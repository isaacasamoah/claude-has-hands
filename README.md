# claude-has-hands

claude-has-hands lets an AI coding agent drive the Chrome you are already signed in to. A Chrome MV3 extension and a local native messaging host expose one set of `browser_*` tools. They include navigation, accessibility-tree reads, clicks, typing, screenshots, and console and network reads. Agents reach the tools over MCP (stdio or HTTP), a localhost REST API, or the `chh` shell command, so Claude Code, Codex, Gemini CLI and any tool that can run a shell command share the same browser.

It is a personal project for one user on one machine. It targets Google Chrome on macOS and Linux, and it is not a cloud browser service or a test framework.

## Why

Browser automation frameworks such as Playwright and Puppeteer start a fresh browser profile with no sessions, so the agent has to sign in, and sites with MFA or device checks often stop it there. This project works inside the browser you already use, with its cookies, extensions and device trust. It never asks the agent for credentials. Signing in and passing MFA stay human steps, and the agent waits while you do them.

## How a call works

```text
Claude Code, Codex, Gemini CLI       shell tools, curl
        │ MCP (stdio or HTTP)               │
        ▼                                   │
  mcp-adapter.js                         bin/chh
        │ POST /v1/call + bearer token      │
        └────────────────┬──────────────────┘
                         ▼
  native host: REST on 127.0.0.1, dispatcher, tool registry
                         │ Chrome native messaging (stdio)
                         ▼
  MV3 extension: CDP via chrome.debugger, injected scripts
                         │
                         ▼
  your signed-in Chrome tabs
```

When an agent calls `browser_click` through MCP:

1. The agent sends the call to `native-host/dist/mcp-adapter.js`, an MCP server that the agent started over stdio.
2. The adapter reads the host's URL from `~/.claude/claude-has-hands/bridge.json` and the bearer token from `bridge.token`, then sends `POST /v1/call` to the native host.
3. The host's REST server checks the token, validates the input against the tool's zod schema, and the dispatcher sends the command to the extension over native messaging with a fresh request id.
4. The extension's service worker runs the command in the automation tab through the Chrome DevTools Protocol or an injected script, then replies with the same id.
5. The dispatcher matches the reply to the waiting request, or fails it after 30 seconds. The adapter formats the result as MCP content and returns it to the agent.

`native-host/src/tool-registry.ts` defines every tool's name, input schema and result formatting. The REST server, both MCP servers and the generated [tool reference](docs/tools.md) all read from it.

## Install

You need Google Chrome on macOS or Linux, Node.js 22.18 or later, and npm. The `chh` CLI also needs `curl` and `python3`.

```bash
git clone https://github.com/isaacasamoah/claude-has-hands.git
cd claude-has-hands
npm ci
npm run build
```

1. Open `chrome://extensions`, turn on **Developer mode** and click **Load unpacked**. Select the `extension/` directory, not `extension/dist/`.
2. Copy the extension ID and run `./scripts/install.sh <extension-id>`. The script rebuilds the project and registers the native messaging host for that extension ID. It also writes a launcher with the absolute path of your Node binary, because Chrome can start native hosts with a `PATH` that does not include it.
3. Reload the extension. Chrome starts the native host, which writes `bridge.json` and a new `bridge.token` to `~/.claude/claude-has-hands/`.
4. Check the round trip to the extension:

   ```bash
   ./bin/chh call browser_status
   ```

   A working bridge replies with JSON that has `"ok": true` and a `result` describing the connection and the automation tab. `chh status` checks only that the REST server answers. It does not contact the extension.

## Connect an agent

Use the absolute path of this checkout in place of `<repo>`. The native host must have started at least once, because the adapter reads `bridge.json` when it starts.

```bash
# Claude Code
claude mcp add -s user claude-has-hands -- node <repo>/native-host/dist/mcp-adapter.js

# Codex
codex mcp add claude-has-hands -- node <repo>/native-host/dist/mcp-adapter.js

# Gemini CLI
gemini mcp add -s user claude-has-hands node <repo>/native-host/dist/mcp-adapter.js
```

`-s user` registers the server for every project. Without it, Claude Code and Gemini CLI register it only for the current directory. The adapter reads `bridge.json` and the token on every call, so it keeps working when the host restarts on a new port with a new token.

`native-host/dist/mcp-server.js` is an older MCP server that talks to the host over the Unix socket `bridge.sock`. It is kept for existing configurations. Use `mcp-adapter.js` for new ones.

### Shell and REST

Any agent with a shell tool can use the CLI:

```bash
<repo>/bin/chh status
<repo>/bin/chh tools
<repo>/bin/chh call browser_navigate '{"url":"https://example.com"}'
<repo>/bin/chh call browser_survey '{}'
```

`./scripts/install-cli.sh` links `chh` and one `browser_<tool>` command per tool into `~/.local/bin`. Set `CHH_BIN_DIR` to link them somewhere else.

To call the REST API directly (this example uses `jq`):

```bash
URL="$(jq -r .url ~/.claude/claude-has-hands/bridge.json)"
TOKEN="$(cat ~/.claude/claude-has-hands/bridge.token)"
curl -sS -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{"tool":"browser_status","input":{}}' "${URL}/v1/call"
```

The API has three routes: `GET /v1/status`, `GET /v1/tools` and `POST /v1/call`.

### MCP over HTTP

To serve MCP over Streamable HTTP as well as stdio, set `CHH_MCP_HTTP_PORT` when you start `mcp-adapter.js`. To serve HTTP only, also set `CHH_MCP_TRANSPORT=http`. If you set no port, the OS picks one and the adapter logs it to stderr. The listener binds to `127.0.0.1`, handles each request statelessly with a new MCP server, and applies the same origin and bearer checks as REST. The token changes every time the host restarts, so an HTTP client must read `bridge.token` again after a restart.

## Tools

[docs/tools.md](docs/tools.md) lists every tool with its parameters. It is generated from the registry, and a unit test fails if it is out of date. `chh tools` returns the full JSON Schema for each tool.

`browser_console` and `browser_network` read ring buffers of the last 500 entries. A capture script fills them from `document_start` in the top frame of every `http` and `https` page. Network capture records `fetch` and `XMLHttpRequest` calls only: method, URL, status, timing and any error, never request or response bodies. Pages opened before the extension started need a reload before capture covers them.

## Security model

The bridge gives an agent control of a browser that is signed in to your accounts. [SECURITY.md](SECURITY.md) has the threat model and how to report a vulnerability. In short:

- The REST server and the MCP HTTP listener bind to `127.0.0.1` only.
- Every request needs `Authorization: Bearer <token>`. The token is 32 random bytes, generated each time the host starts, and compared with `crypto.timingSafeEqual` after a length check. A web page cannot read the token file, so it cannot call the bridge.
- As a second check, a request whose `Origin` header names a host other than `localhost`, `127.0.0.1` or `[::1]` gets a 403. Requests with no `Origin` header, or `Origin: null`, pass this check and still need the token. The server sends no CORS headers.
- `bridge.token`, `bridge.json` and `bridge.sock` are mode 0600. A Unix socket client must send the token in a handshake within 5 seconds.
- REST request bodies and native messaging frames are capped at 1,024,000 bytes, which matches Chrome's 1 MB limit on messages from a native host.
- `browser_navigate` accepts only `http`, `https` and `about:blank` URLs, so a link planted in page text cannot send the browser to `javascript:`, `file:` or `chrome:` URLs. This check is not a sandbox. `browser_tabs` with `action: "new"` opens a URL without it, and `browser_eval` runs any JavaScript in the page.

The bridge stores no credentials and has no login automation. It can still see whatever the page can. Screenshots, DOM reads, console output and `browser_eval` results can contain sensitive data from a signed-in session. `browser_dom_snapshot` redacts the values of password and token-like inputs, but `browser_eval` can read them.

## Configuration

The native host runs as a child of Chrome, so set host variables in Chrome's environment, not only in your shell. The client variables apply to `mcp-adapter.js` and `chh`.

| Variable | Read by | Purpose |
|----------|---------|---------|
| `CHH_BRIDGE_PORT` | Host | Fix the REST port. Default: the OS picks a free port. |
| `CHH_BRIDGE_REST=off` | Host | Turn off the REST server. The host then serves only the Unix socket. |
| `CHH_BRIDGE_GRACE_MS` | Host | How long a host keeps its token and socket after Chrome disconnects, so a restarted worker can take over. Default: 8000. |
| `CHH_BRIDGE_URL` | Clients | Use this REST URL instead of the one in `bridge.json`. |
| `CHH_BRIDGE_TOKEN_FILE` | Clients | Read the token from this path. |
| `CHH_BRIDGE_JSON` | Clients | Read the discovery file from this path. |
| `CHH_MCP_HTTP_PORT` | `mcp-adapter.js` | Also serve MCP over HTTP on this port. |
| `CHH_MCP_TRANSPORT` | `mcp-adapter.js` | `stdio` (default), `http` or `both`. |

## Reliability

Chrome starts the native host from the extension's MV3 service worker, and the host lives only as long as that worker. The worker sends the host a message about every 20 seconds, which resets Chrome's idle timer. If the worker stops anyway, a `chrome.alarms` handler reconnects it within about 30 seconds. Each restart creates a new token and, unless `CHH_BRIDGE_PORT` is set, a new port. The adapter and `chh` read both from disk on every call.

## Troubleshooting

**A call fails with `Command '<action>' timed out after 30000ms. The extension may not be responding.`** The host is running, but the extension did not answer. Open `chrome://extensions` and click reload on Claude Has Hands. The host restarts with a new port and token, and the next call picks them up.

**`chh` reports `no readable token`, or the adapter reports `Cannot read bridge token`.** The native host is not running. Reload the extension. If the token still does not appear, open the service worker console from the extension's card in `chrome://extensions` and read the disconnect message. A "native messaging host not found" or "forbidden" message means the host manifest is missing or names a different extension ID. Run `./scripts/install.sh <extension-id>` again with the ID shown on the card.

**The adapter exits at startup with `Cannot determine REST bridge URL`.** The host has never written `bridge.json`. Load or reload the extension first, or set `CHH_BRIDGE_URL`.

## Limitations and non-goals

- Chrome only, on macOS and Linux. `install.sh` registers the host for Google Chrome. Chromium, Chrome for Testing and other browsers are untested.
- Single user, single machine. There is no remote access, multi-user mode or cloud browser fallback.
- The extension asks for `<all_urls>` and the `debugger` permission, and Chrome shows its debugging banner while attached. Connect only agents you trust with the whole browser session.
- There is no per-site policy or action tiering. The calling agent or harness owns approval for actions such as submitting forms.
- `browser_gif` returns a sequence of JPEG frames, not an encoded GIF, because one native messaging message is capped near 1 MB.
- `browser_observe` starts and stops an observer, but no transport delivers its events to the agent yet. Use `browser_wait` to wait for a page change.

## Development

```bash
npm run typecheck
npm test              # typecheck, then node --test test/unit/*.test.ts
npm run build         # typecheck, then esbuild into extension/dist and native-host/dist
npm run docs:tools    # regenerate docs/tools.md
npm run dev           # rebuild on change
```

The unit tests run without a browser. They cover the wire protocol, the dispatcher, the REST and MCP transports, keepalive, the tool registry and the `chh` CLI. The scenarios in `test/scenarios/` and the fixture pages in `test/` are for driving a real Chrome by hand and are not part of `npm test`.

## Licence

MIT. See [LICENSE](LICENSE).
