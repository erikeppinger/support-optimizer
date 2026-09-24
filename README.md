# Support Optimizer

A browser-only tool for preparing molecular structures (and STL/3MF meshes in general) for 3D printing: import a PDB/mmCIF structure or an existing mesh, close interior cavities so support material doesn't get trapped inside, find a print orientation that minimizes overhangs, preview organic support paths, and export a print-ready STL or multi-material 3MF.

Everything runs client-side in the browser (Web Workers do the heavy geometry work) — there is no backend/server component, and no data ever leaves the machine it's running on except for the optional "fetch by PDB ID" feature, which downloads directly from RCSB.

**About this project:** a personal tool, built almost entirely with AI assistance (Claude) — not an enterprise/production-grade product, and not backed by a team or a support commitment. It's had real testing on real structures, but treat it accordingly: read the code before trusting it with anything that matters, and expect rough edges.

**Related:** [ChimeraX-Save3MF](https://github.com/erikeppinger/chimerax-save3mf) exports a ChimeraX scene (surfaces, cartoons/ribbons, whatever's on screen) as a 3MF with each chain's ChimeraX color carried through as its own extruder — a natural first step before loading the result here for cavity sealing, orientation optimization, and print-ready export.

## Requirements

- **To run it (any option below):** a modern desktop browser — Chrome, Edge, or Firefox, recent version. Needs WebGL2 and Web Workers, which all of these support by default. Not tested on mobile browsers.
- **To build/serve it yourself:** [Node.js](https://nodejs.org) 20 or newer (includes `npm`). Nothing else — no Python, no global installs, no accounts.

## Quickest way to just try it (no installation)

If someone already has it running with `npm run dev` or `npm run preview`, they can just send you the URL it prints (e.g. `http://localhost:5173`) — if you're on the same network, open that in your own browser and it works immediately, no setup on your end at all.

## Option A — Run it from source

Best if you want to keep it up to date, poke at the code, or run the test suite.

1. Get the project folder (zip it up and share via Dropbox/etc., or clone it if it's in a git remote).
2. Open a terminal in the project folder and run:
   ```bash
   npm install
   npm run dev
   ```
3. Open the URL it prints (usually `http://localhost:5173`) in your browser.

`npm install` only needs to happen once (or again after the code changes). `npm run dev` starts a local dev server with hot-reload; stop it with Ctrl+C.

## Option B — Share a pre-built copy (recipient doesn't need to build anything)

Best for handing off to a colleague who just wants to use the tool, not develop it.

**You build it once:**
```bash
npm install
npm run build
```
This produces a self-contained `dist/` folder (a handful of static HTML/CSS/JS files, a few hundred KB). Zip that folder and send it however's convenient (Dropbox, email, a USB stick — it doesn't matter, it's just static files).

**Important:** don't just double-click the `index.html` inside it — browsers block the Web Worker/module loading this app needs when a page is opened directly as a `file://` path. It has to be served over local HTTP, which takes one command and no installation:

- **If they have Node.js:** unzip it, open a terminal in that folder, and run:
  ```bash
  npx serve .
  ```
  (`npx` comes with Node and downloads the tiny `serve` tool on the fly — no separate install step, nothing left behind afterward beyond a small npx cache.) Then open the URL it prints.

- **If they have Python instead** (pre-installed on most Mac/Linux machines): unzip it, open a terminal in that folder, and run:
  ```bash
  python -m http.server 8080
  ```
  Then open `http://localhost:8080`.

Either way, this is a one-line command with no dependency installation beyond whichever runtime (Node or Python) they already have.

## Option C — Host it somewhere, share a link

If you want the absolute lowest friction for a colleague (they just open a URL, nothing runs on their machine at all), drop the same `dist/` folder from Option B onto any static hosting service — e.g. [Netlify Drop](https://app.netlify.com/drop) (drag the folder into the browser, get a URL back, no account required) or GitHub Pages if the project lives in a GitHub repo. Not set up as part of this project by default — mentioned here as the option to reach for if repeated file-sharing gets old.

## Option D — Native desktop app (Tauri)

A true installable `.exe` (Windows) or `.app` (Mac), rather than "a folder you serve locally." This is built and working — installers live under `src-tauri/target/release/bundle/` (`msi/` and `nsis/`) after a build.

**Building it needs a Rust toolchain** (one-time, system-level install):
1. Install Rust via [rustup.rs](https://rustup.rs) (the standard installer; pick the default options).
2. Install the "Desktop development with C++" workload from [Visual Studio Build Tools](https://aka.ms/vs/17/release/vs_BuildTools.exe) — needed to compile Rust's Windows (MSVC) target.
3. Restart the terminal (so `cargo`/`rustc` are on `PATH`), then run `npx tauri info` — once it shows checkmarks instead of `✘` across the board, you're ready to build.

```bash
npm run tauri:dev     # launches a native window against the Vite dev server, with hot-reload
npm run tauri:build   # produces a real installer/binary under src-tauri/target/release/bundle/
```

A Mac build needs the equivalent setup done **on a Mac** (Rust via rustup, Xcode Command Line Tools instead of MSVC) — Tauri doesn't cross-compile a `.app` from Windows.

Worth knowing about what's already configured:
- `src-tauri/tauri.conf.json` points at this project's existing `dist/` output and dev server (`npm run build` / `npm run dev`), so there's no separate frontend setup to maintain — the native app wraps the exact same web build described in Option B.
- Content Security Policy is left unset (Tauri's permissive default) rather than hand-tightened, since an untested CSP risks silently breaking the app's own inline styles/Web Worker/Blob-URL exports.
- The one Tauri-specific behavior: **Export STL/3MF opens a native Save As dialog** (via `tauri-plugin-dialog` + `tauri-plugin-fs`) so you can pick exactly where the file goes, instead of always landing in Downloads the way a plain browser download would. Everything else — RCSB fetch, cavity/void detection, orientation search, support-path preview — works exactly as it does in the browser build, since none of it touches the filesystem.

## Running the test suite / typecheck

Only relevant if you're changing the code, not for ordinary use:
```bash
npm run test        # vitest — unit tests for the geometry/import/export logic
npx tsc --noEmit     # typecheck only, no build output
```

## Notes and known limits

- Large structures (hundreds of thousands of atoms) take real time to import and optimize — the app stays responsive throughout (heavy work runs in Web Workers), but individual steps can take from several seconds to a minute or more on complex structures. Built-in advisories (e.g. the low-res search proxy) appear automatically once a loaded model crosses that size.
- The "fetch by RCSB ID" feature needs an internet connection (it downloads directly from `files.rcsb.org`); everything else — loading a local STL/PDB/mmCIF/3MF file, cavity detection, orientation search, support-path preview, export — works fully offline once the page itself has loaded.
- The organic support-path preview is illustrative, not a real slicer simulation — see the in-app help ("?") next to that option for exactly what it does and doesn't account for.
