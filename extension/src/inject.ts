/**
 * MAIN-world capture installer.
 *
 * Registered as a dynamic content script that runs at document_start in the
 * page's MAIN world (see background.ts → registerCaptureScript). It installs
 * lightweight, read-only capture of:
 *
 *   1. console output (log/info/warn/error/debug) + uncaught errors +
 *      unhandled promise rejections   → window.__chh_console_buffer
 *   2. network metadata for fetch() and XMLHttpRequest                → window.__chh_net_buffer
 *
 * Design constraints (claude-has-hands principles):
 *   - Never stores credentials. We capture request/response METADATA only —
 *     method, url, status, timing — never request or response bodies, which
 *     routinely carry tokens / PII on authenticated sites.
 *   - Never breaks the page. Every wrapper calls the original and returns its
 *     exact value/promise; capture is wrapped in try/catch so a capture bug
 *     can never affect the site's own behaviour.
 *
 * The buffers are bounded ring buffers (oldest dropped past MAX_ENTRIES). The
 * extension reads them on demand via executeScript({ world: "MAIN" }) from the
 * read_console / read_network command handlers.
 *
 * Must run in MAIN world: content scripts default to an ISOLATED world with
 * their own copy of fetch/XHR/console, so an ISOLATED-world patch would never
 * see the page's own network or console activity.
 */

interface ConsoleEntry {
  seq: number;
  ts: number;
  level: string;
  text: string;
}

interface NetEntry {
  seq: number;
  type: "fetch" | "xhr";
  method: string;
  url: string;
  startTs: number;
  status: number;
  ok: boolean;
  durationMs: number;
  error?: string;
}

(() => {
  const W = window as unknown as Record<string, unknown> & {
    __chh_capture_installed?: boolean;
    __chh_console_buffer?: ConsoleEntry[];
    __chh_net_buffer?: NetEntry[];
    fetch?: typeof fetch;
    XMLHttpRequest?: typeof XMLHttpRequest;
  };

  // Guard against double-install (e.g. bfcache restore re-running the script).
  if (W.__chh_capture_installed) return;
  W.__chh_capture_installed = true;

  const MAX_ENTRIES = 500;
  const MAX_TEXT = 2000;
  const MAX_URL = 1000;

  function fmt(v: unknown): string {
    if (typeof v === "string") return v;
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }

  function push<T>(buf: T[], item: T): void {
    buf.push(item);
    if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES);
  }

  // ── console capture ──────────────────────────────────────────────
  const consoleBuf: ConsoleEntry[] = (W.__chh_console_buffer = []);
  let cSeq = 0;
  const levels = ["log", "info", "warn", "error", "debug"] as const;
  const c = console as unknown as Record<string, (...a: unknown[]) => void>;
  for (const level of levels) {
    const orig = typeof c[level] === "function" ? c[level].bind(console) : null;
    if (!orig) continue;
    c[level] = (...args: unknown[]) => {
      try {
        push(consoleBuf, {
          seq: cSeq++,
          ts: Date.now(),
          level,
          text: args.map(fmt).join(" ").slice(0, MAX_TEXT),
        });
      } catch {
        // capture must never break logging
      }
      return orig(...args);
    };
  }

  window.addEventListener("error", (e: ErrorEvent) => {
    try {
      push(consoleBuf, {
        seq: cSeq++,
        ts: Date.now(),
        level: "error",
        text: `Uncaught ${e.message} (${e.filename}:${e.lineno}:${e.colno})`.slice(
          0,
          MAX_TEXT
        ),
      });
    } catch {
      // ignore
    }
  });

  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    try {
      push(consoleBuf, {
        seq: cSeq++,
        ts: Date.now(),
        level: "error",
        text: `Unhandled promise rejection: ${fmt(e.reason)}`.slice(0, MAX_TEXT),
      });
    } catch {
      // ignore
    }
  });

  // ── network capture (metadata only) ──────────────────────────────
  const netBuf: NetEntry[] = (W.__chh_net_buffer = []);
  let nSeq = 0;

  const origFetch = W.fetch;
  if (typeof origFetch === "function") {
    W.fetch = function (this: unknown, ...fetchArgs: Parameters<typeof fetch>) {
      const start = Date.now();
      const input = fetchArgs[0];
      const init = fetchArgs[1];
      let method = "GET";
      let url = "";
      try {
        url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request)?.url || String(input);
        method = (
          init?.method ||
          (typeof input === "object" && (input as Request)?.method) ||
          "GET"
        ).toUpperCase();
      } catch {
        // best-effort metadata only
      }
      const rec: NetEntry = {
        seq: nSeq++,
        type: "fetch",
        method,
        url: url.slice(0, MAX_URL),
        startTs: start,
        status: 0,
        ok: false,
        durationMs: 0,
      };
      push(netBuf, rec);

      const p = origFetch.apply(this as never, fetchArgs);
      return p.then(
        (res) => {
          rec.status = res.status;
          rec.ok = res.ok;
          rec.durationMs = Date.now() - start;
          return res;
        },
        (err) => {
          rec.error = String(err?.message || err);
          rec.durationMs = Date.now() - start;
          throw err;
        }
      );
    } as typeof fetch;
  }

  const OrigXHR = W.XMLHttpRequest;
  if (typeof OrigXHR === "function") {
    const proto = OrigXHR.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;

    proto.open = function (
      this: XMLHttpRequest & { __chh?: { method: string; url: string } },
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      try {
        this.__chh = {
          method: (method || "GET").toUpperCase(),
          url: String(url).slice(0, MAX_URL),
        };
      } catch {
        // ignore
      }
      // eslint-disable-next-line prefer-rest-params
      return (origOpen as (...a: unknown[]) => void).apply(this, [
        method,
        url,
        ...rest,
      ]);
    } as typeof proto.open;

    proto.send = function (
      this: XMLHttpRequest & { __chh?: { method: string; url: string } },
      ...sendArgs: unknown[]
    ) {
      const meta = this.__chh;
      if (meta) {
        const start = Date.now();
        const rec: NetEntry = {
          seq: nSeq++,
          type: "xhr",
          method: meta.method,
          url: meta.url,
          startTs: start,
          status: 0,
          ok: false,
          durationMs: 0,
        };
        push(netBuf, rec);
        this.addEventListener("loadend", () => {
          try {
            rec.status = this.status;
            rec.ok = this.status >= 200 && this.status < 300;
            rec.durationMs = Date.now() - start;
          } catch {
            // ignore
          }
        });
      }
      return (origSend as (...a: unknown[]) => void).apply(this, sendArgs);
    } as typeof proto.send;
  }
})();
