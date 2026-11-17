# claude-has-hands

Chrome MV3 extension plus a local native-messaging host that exposes `browser_*` tools over MCP, REST and the `chh` CLI. See README.md for architecture and install steps.

## Principles

- Runs inside the user's real Chrome, not Chrome for Testing or Puppeteer.
- Never reads, stores or replays credentials, and never bypasses authentication.
- Token-efficient: accessibility-tree snapshots over screenshots where possible.
- `native-host/src/tool-registry.ts` is the single source of truth for tool schemas. Change tools there, then run `npm run docs:tools`.

## Commands

```bash
npm ci
npm run build   # typecheck + esbuild
npm test        # typecheck + unit tests (no browser needed)
```

Browser scenarios in `test/scenarios/` need a real Chrome with the extension loaded and are run by hand.
