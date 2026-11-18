# Security

## Threat model

claude-has-hands gives an AI agent control of a browser that is already signed in to your accounts. Treat access to the bridge as access to those accounts.

In scope:

- **Other users and processes on the machine.** The REST API and the MCP HTTP listener listen on `127.0.0.1` and require a bearer token. The token, `bridge.json` and the Unix socket are mode 0600, and the token changes on every host start. Any process running as your own user can still read the token, so this does not defend against malware running as you.
- **Web pages in your browser.** A page must not be able to call the bridge. The token is the defense against cross-site and DNS-rebinding requests, because a page cannot read the token file. The server does not check the `Host` header. As a second check, it refuses requests whose `Origin` header names a host other than `localhost`, `127.0.0.1` or `[::1]`, but a request with no `Origin` or `Origin: null` passes that check. There are no CORS headers.
- **Oversized or malformed input.** Native messaging frames, Unix socket frames and REST request bodies are capped at 1,024,000 bytes. REST validates every input against the tool's zod schema before it reaches Chrome.

Out of scope or accepted:

- **A malicious or confused agent.** Once connected, an agent can read pages, type, click and evaluate JavaScript in any tab. The bridge has no per-site policy. `browser_navigate` refuses URLs other than `http`, `https` and `about:blank`, but `browser_tabs` and `browser_eval` can still open other URLs. Keep a human in the loop for sensitive actions.
- **Prompt injection from page content.** Text on a page can try to steer the agent. The bridge returns page content as data and cannot tell instructions from content.
- **Credentials in the page.** The bridge stores no credentials and does not bypass MFA. `browser_dom_snapshot` redacts password and token-like input values, but screenshots, other DOM reads and `browser_eval` can expose anything the page holds.

## Reporting a vulnerability

Please report privately through GitHub's "Report a vulnerability" option on the Security tab of this repository. If that is unavailable, open an issue asking for a private contact and leave out the details. Do not post exploit details publicly.

This is a personal project with no service-level commitment. Reports are read and answered on a best-effort basis.
