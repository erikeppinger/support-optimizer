/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Single source of truth for the version shown in the UI (see
// __APP_VERSION__ in main.ts) — read from package.json at build/dev-server
// start time rather than duplicating the number in a second place that
// could drift out of sync with it.
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf-8"));

// Keeps the dev server's file watcher off scratch/ — dropping a large file
// there while it's still being written (e.g. an in-progress download) has
// crashed the whole server with an EBUSY watch error before. Not part of
// the app itself. public/ is left watched normally since Vite serves it
// directly from disk per-request.
export default defineConfig({
  // Relative asset paths, so the same build works at a domain root (Tauri)
  // and under GitHub Pages' /support-optimizer/ sub-path.
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    // Tauri's devUrl (src-tauri/tauri.conf.json) is a fixed
    // "http://localhost:5173" — it has no way to discover a fallback port,
    // unlike a browser preview pointed at whatever URL actually got
    // printed. Without strictPort, a stray process already holding 5173
    // (has happened before in this project) would make Vite silently move
    // to 5174+ while Tauri kept trying to load a server that isn't there,
    // failing with a connection error that doesn't obviously point back to
    // "something else is on 5173" as the cause.
    strictPort: true,
    watch: {
      ignored: ["**/scratch/**"],
    },
  },
  test: {
    // jsdom (not the default "node" environment) so tests can exercise
    // DOMParser-based code (3MF XML parsing) the same way it runs in the
    // browser/worker at runtime.
    environment: "jsdom",
  },
});
