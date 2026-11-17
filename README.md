# claude-has-hands

A guarded local bridge that lets AI coding CLIs drive your existing, signed-in Chrome. A Chrome MV3 extension and a native messaging host expose one set of `browser_*` tools over MCP (stdio and HTTP), a localhost REST API and a `chh` shell command, so Claude Code, Codex, Gemini CLI or any tool that can run a shell command can use the same browser.

## Why

Browser automation frameworks start a fresh browser with no sessions, and sites with MFA or device trust block them. This project goes the other way. It works inside the browser you already use, with its cookies, extensions and device trust, and it never asks the agent for credentials. Signing in and passing MFA stay human steps: the agent waits while you do them.

The bridge is a local tool for one user. It is not a cloud browser service and not a test framework.

## Architecture

```text
 Chrome (your profile)                       Native host (Node, spawned by Chrome)
┌─────────────────────────┐   native         ┌──────────────────────────────────────┐
│ MV3 extension           │   messaging      │ dispatcher (request/response match)  │
│  - CDP via chrome.debugger ◀──────────────▶ │ tool registry (zod schemas)          │
│  - DOM + MAIN-world capture│  (stdio)      │                                      │
└─────────────────────────┘                  │  Unix socket   REST 127.0.0.1:<port> │
                                             │  bridge.sock   Bearer token          │
                                             └───────┬──────────────┬───────────────┘
                                                     │              │
                                        mcp-server.js│     ┌────────┴─────────┬──────────────┐
                                        (direct MCP) │     │ mcp-adapter.js   │ chh CLI      │
                                                     │     │ MCP over stdio   │ curl wrapper │
                                                     │     │ or HTTP          │              │
                                                     ▼     ▼                  ▼              ▼
                                                  Claude Code            Codex, Gemini, shell tools
```

- `extension/` is the MV3 extension. Its service worker keeps the native host alive and runs each command through the Chrome DevTools Protocol and content scripts.
- `native-host/src/dispatcher.ts` is the single command router. `tool-registry.ts` is the single source of truth for tool names, zod input schemas and result formatting. Every transport reads from it.
- `native-host/src/rest-server.ts` is the localhost REST API (`GET /v1/status`, `GET /v1/tools`, `POST /v1/call`).
- `native-host/src/mcp-adapter.ts` is an MCP server that forwards each tool call to the REST API. `mcp-server.js` is the older path that talks to the Unix socket directly.
- `bin/chh` is a shell wrapper around the REST API for agents without MCP.

## Install

Requirements: Google Chrome on macOS or Linux, Node.js 22.18 or later (the unit tests run TypeScript natively), npm. The `chh` CLI also needs `curl` and `python3`.

```bash
git clone https://github.com/isaacasamoah/claude-has-hands.git
cd claude-has-hands
npm ci
npm run build
```

1. Open `chrome://extensions`, enable Developer mode and choose Load unpacked. Select the `extension/` directory (not `extension/dist/`).
2. Copy the extension ID and run `./scripts/install.sh <extension-id>`. It builds the project, writes a launcher that records the absolute path of your Node binary (Chrome starts native hosts with a minimal `PATH`) and registers the native messaging host for that extension ID.
3. Reload the extension. Chrome starts the native host, which writes `bridge.json` and a fresh `bridge.token` under `~/.claude/claude-has-hands/`.

## Connect an agent

Use the absolute path of this checkout in place of `<repo>`. Chrome and the extension must be running.

```bash
# Claude Code
claude mcp add claude-has-hands -- node <repo>/native-host/dist/mcp-adapter.js

# Codex
codex mcp add claude-has-hands -- node <repo>/native-host/dist/mcp-adapter.js

# Gemini CLI
gemini mcp add claude-has-hands node <repo>/native-host/dist/mcp-adapter.js
```

The adapter reads `bridge.json` and the token on every call, so it keeps working when the host restarts on a new port with a new token.

For any agent with a shell tool, use the CLI:

```bash
<repo>/bin/chh status
<repo>/bin/chh tools
<repo>/bin/chh call browser_navigate '{"url":"https://example.com"}'
<repo>/bin/chh call browser_survey '{}'
```

`./scripts/install-cli.sh` links `chh` and one `browser_<tool>` command per tool into `~/.local/bin`.

Plain REST:

```bash
URL="$(jq -r .url ~/.claude/claude-has-hands/bridge.json)"
TOKEN="$(cat ~/.claude/claude-has-hands/bridge.token)"
curl -sS -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{"tool":"browser_status","input":{}}' "${URL}/v1/call"
```

To serve MCP over HTTP, set `CHH_MCP_HTTP_PORT` (or `CHH_MCP_TRANSPORT=http|both`) when starting `mcp-adapter.js`. Clients must send the same bearer token as for REST.

## Tools

The tool reference is generated from the registry: see [docs/tools.md](docs/tools.md). It covers navigation and tabs, accessibility-tree and DOM inspection, click, type, select, scroll and key presses, screenshots and frame-sequence capture, console and network inspection, waits, file upload, JavaScript evaluation and batches. `chh tools` returns the full JSON Schema for each tool.

`browser_console` and `browser_network` read ring buffers filled by a capture script injected at `document_start`. Network capture stores method, URL, status and timing only, never request or response bodies. Pages opened before the extension started need a reload for full coverage.


## Security model

Details and reporting instructions are in [SECURITY.md](SECURITY.md). In short:

- The REST server binds to `127.0.0.1` only.
- Every request needs `Authorization: Bearer <token>`. The token is compared with `crypto.timingSafeEqual` after a length check.
- Requests carrying a browser `Origin` other than `localhost`, `127.0.0.1` or `[::1]` get a 403, which blocks DNS-rebinding and cross-site requests from web pages. There is no CORS.
- The token is regenerated every time the host starts. `bridge.token`, `bridge.json` and `bridge.sock` are mode 0600.
- The Unix socket requires a token handshake. The HTTP MCP transport applies the same origin and bearer checks as REST.
- Request bodies are capped at about 1 MB, matching Chrome's native messaging frame limit. Responses carry `Cache-Control: no-store`.
- `browser_navigate` accepts only an allowlist of URL schemes.

The bridge does not read, store or replay passwords and does not bypass MFA. It can still see whatever the page shows: DOM reads, screenshots, console output and `browser_eval` results can contain sensitive data from a signed-in session.

## Configuration

| Variable | Purpose |
|----------|---------|
| `CHH_BRIDGE_URL` | Override the REST URL (default: read from `bridge.json`) |
| `CHH_BRIDGE_TOKEN_FILE` | Override the token path |
| `CHH_BRIDGE_JSON` | Override the discovery file path |
| `CHH_BRIDGE_PORT` | Pin the REST port (default: OS-assigned) |
| `CHH_BRIDGE_REST=off` | Disable the REST server; the host serves the Unix socket only |
| `CHH_MCP_HTTP_PORT` | Serve MCP over HTTP on this port |
| `CHH_MCP_TRANSPORT` | `stdio` (default), `http` or `both` |

## Reliability

Chrome starts the native host from the extension's MV3 service worker, and the host lives only as long as that worker. The worker pings the host over the native port about every 20 seconds, which resets Chrome's idle timer, and a `chrome.alarms` handler restarts the connection if the worker dies anyway. Each restart means a new port and a new token, which the adapter and `chh` pick up from `bridge.json`.

## Limitations and non-goals

- Chrome only, on macOS and Linux. Chrome for Testing and other browsers are untested.
- Single user, single machine. There is no remote access, multi-user mode or cloud browser fallback.
- The extension asks for `<all_urls>` and the `debugger` permission, and Chrome shows its debugging banner while attached. Connect only agents you trust with the whole browser session.
- There is no per-site policy or action tiering. The calling agent or harness owns approval for actions such as submitting forms.
- `browser_gif` returns a frame sequence, not an encoded GIF, because one native messaging message is capped near 1 MB.
- No streaming events for `browser_observe`.

## Development

```bash
npm run typecheck
npm test              # typecheck, then node --test test/unit/*.test.ts
npm run build         # typecheck, then esbuild into extension/dist and native-host/dist
npm run docs:tools    # regenerate docs/tools.md
npm run dev           # rebuild on change
```

Unit tests cover the wire protocol, dispatcher, REST and MCP transports, keepalive and the tool registry, and run without a browser. The declarative scenarios in `test/scenarios/` and the fixture pages in `test/` are for driving a real Chrome by hand and are not part of `npm test`.

## Licence

MIT. See [LICENSE](LICENSE).
