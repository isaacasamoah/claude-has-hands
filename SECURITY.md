# Security

## Threat model

claude-has-hands gives an AI agent control of a browser that is already signed in to your accounts. Treat access to the bridge as access to those accounts.

In scope:

- **Other users and processes on the machine.** The REST API listens on `127.0.0.1`, requires a bearer token and refuses requests with non-local `Origin` headers. The token, `bridge.json` and the Unix socket are mode 0600 and the token changes on every host start. Any process running as your own user can still read the token, so this does not defend against malware running as you.
- **Web pages in your browser.** A page must not be able to call the bridge. The origin allowlist and the token requirement defend against cross-site and DNS-rebinding requests. There is no CORS.
- **Oversized or malformed input.** Native messaging frames and REST request bodies are capped at about 1 MB.

Out of scope or accepted:

- **A malicious or confused agent.** Once connected, an agent can read pages, type, click and evaluate JavaScript in any tab. The bridge has no per-site policy. Keep a human in the loop for sensitive actions.
- **Prompt injection from page content.** Text on a page can try to steer the agent. The bridge returns page content as data and cannot tell instructions from content.
- **Credentials seen on screen.** The bridge does not read or store passwords or bypass MFA, but screenshots, DOM reads and `browser_eval` can expose whatever the page shows.

## Reporting a vulnerability

Please report privately through GitHub's "Report a vulnerability" option on the Security tab of this repository. If that is unavailable, open an issue asking for a private contact and leave out the details. Do not post exploit details publicly.

This is a personal project with no service-level commitment. Reports are read and answered on a best-effort basis.
