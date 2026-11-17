import * as esbuild from "esbuild";

const args = process.argv.slice(2);
const watchMode = args.includes("--watch");
const buildExtension = args.length === 0 || args.includes("--extension") || watchMode;
const buildNativeHost = args.length === 0 || args.includes("--native-host") || watchMode;

/** @type {import('esbuild').BuildOptions[]} */
const configs = [];

if (buildExtension) {
  configs.push({
    entryPoints: ["extension/src/background.ts"],
    bundle: true,
    outfile: "extension/dist/background.js",
    format: "esm",
    target: "es2022",
    platform: "browser",
    minify: false,
    sourcemap: true,
  });

  // MAIN-world capture installer — injected at document_start to buffer page
  // console output and fetch/XHR network metadata. Built as an IIFE (not an
  // ES module) because MAIN-world content scripts run as classic scripts.
  configs.push({
    entryPoints: ["extension/src/inject.ts"],
    bundle: true,
    outfile: "extension/dist/inject.js",
    format: "iife",
    target: "es2022",
    platform: "browser",
    minify: false,
    sourcemap: true,
  });
}

if (buildNativeHost) {
  // Native host — Chrome spawns this via native messaging
  configs.push({
    entryPoints: ["native-host/src/index.ts"],
    bundle: true,
    outfile: "native-host/dist/index.js",
    format: "esm",
    target: "es2022",
    platform: "node",
    minify: false,
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node\n" },
    external: ["net", "fs", "path", "os", "events", "stream", "util", "child_process", "crypto", "tty"],
  });

  // MCP server — Claude Code spawns this (legacy, native-messaging path)
  configs.push({
    entryPoints: ["native-host/src/mcp-server.ts"],
    bundle: true,
    outfile: "native-host/dist/mcp-server.js",
    format: "esm",
    target: "es2022",
    platform: "node",
    minify: false,
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node\n" },
    external: ["net", "fs", "path", "os", "events", "stream", "util", "child_process", "crypto", "tty"],
  });

  // MCP adapter — REST-backed entry point used by Codex / Gemini / new
  // Claude Code config. Same browser_* surface, sourced from the shared
  // BrowserToolRegistry instead of bridge.sock directly.
  configs.push({
    entryPoints: ["native-host/src/mcp-adapter.ts"],
    bundle: true,
    outfile: "native-host/dist/mcp-adapter.js",
    format: "esm",
    target: "es2022",
    platform: "node",
    minify: false,
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node\n" },
    external: ["net", "fs", "path", "os", "events", "stream", "util", "child_process", "crypto", "tty", "http", "https"],
  });
}

if (watchMode) {
  // Watch mode: use esbuild context for incremental rebuilds
  const contexts = await Promise.all(
    configs.map((config) => esbuild.context(config))
  );

  await Promise.all(contexts.map((ctx) => ctx.watch()));

  console.log("Watching for changes...");

  // Keep process alive
  process.on("SIGINT", async () => {
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
    process.exit(0);
  });
} else {
  // One-shot build
  await Promise.all(configs.map((config) => esbuild.build(config)));
  console.log("Build complete.");
}
