# Support Optimizer

A browser-only tool for preparing molecular structures (and STL/3MF meshes in general) for 3D printing: import a PDB/mmCIF structure or an existing mesh, close interior cavities so support material doesn't get trapped inside, find a print orientation that minimizes overhangs, preview organic support paths, and export a print-ready STL or multi-material 3MF.

Everything runs client-side in the browser (Web Workers do the heavy geometry work) — there is no backend/server component, and no data ever leaves the machine it's running on except for the optional "fetch by PDB ID" feature, which downloads directly from RCSB.

**About this project:** a personal tool, built almost entirely with AI assistance (Claude) — not an enterprise/production-grade product, and not backed by a team or a support commitment. It's had real testing on real structures, but treat it accordingly: read the code before trusting it with anything that matters, and expect rough edges.

**Related:** [ChimeraX-Save3MF](https://github.com/erikeppinger/chimerax-save3mf) exports a ChimeraX scene (surfaces, cartoons/ribbons, whatever's on screen) as a 3MF with each chain's ChimeraX color carried through as its own extruder — a natural first step before loading the result here for cavity sealing, orientation optimization, and print-ready export. Those colors are read back when the 3MF is loaded here (see [Notes](#notes-and-known-limits)).

## Requirements

- **To run it (any option below):** a modern desktop browser — Chrome, Edge, or Firefox, recent version. Needs WebGL2 and Web Workers, which all of these support by default. Not tested on mobile browsers.
- **To build/serve it yourself:** [Node.js](https://nodejs.org) 20 or newer (includes `npm`). Nothing else — no Python, no global installs, no accounts.

## Quickest way to just try it

**In your browser:** open **https://erikeppinger.github.io/support-optimizer/** — nothing to install. Files you load are processed in your own browser and never uploaded.

**Desktop installers** for Windows, macOS (Apple Silicon and Intel) and Linux are attached to each release on the [Releases page](https://github.com/erikeppinger/support-optimizer/releases) — download the one for your platform and install it like any other app. Nothing else is needed.

**Without installing anything:** if someone already has it running with `npm run dev` or `npm run preview`, they can just send you the URL it prints (e.g. `http://localhost:5173`) — if you're on the same network, open that in your own browser and it works immediately, no setup on your end at all.

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

If you want the absolute lowest friction for a colleague (they just open a URL, nothing runs on their machine at all), drop the same `dist/` folder from Option B onto any static hosting service — e.g. [Netlify Drop](https://app.netlify.com/drop) (drag the folder into the browser, get a URL back, no account required).

This repository already does this with GitHub Pages: `.github/workflows/pages.yml` builds and publishes the browser version to https://erikeppinger.github.io/support-optimizer/ on every push to `main` (tests must pass first). It needs **Settings → Pages → Source: GitHub Actions** set once. The build uses relative asset paths (`base: "./"` in `vite.config.ts`), so the same `dist/` works at a domain root, under a sub-path like Pages', and inside the desktop app.

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

Building a Mac app *locally* needs the equivalent setup done **on a Mac** (Rust via rustup, Xcode Command Line Tools instead of MSVC) — Tauri doesn't cross-compile a `.app` from Windows. You don't need to for releases: the release workflow (below) builds the Mac apps on GitHub's own macOS machines.

Worth knowing about what's already configured:
- `src-tauri/tauri.conf.json` points at this project's existing `dist/` output and dev server (`npm run build` / `npm run dev`), so there's no separate frontend setup to maintain — the native app wraps the exact same web build described in Option B.
- Content Security Policy is left unset (Tauri's permissive default) rather than hand-tightened, since an untested CSP risks silently breaking the app's own inline styles/Web Worker/Blob-URL exports.
- The one Tauri-specific behavior: **Export STL/3MF opens a native Save As dialog** (via `tauri-plugin-dialog` + `tauri-plugin-fs`) so you can pick exactly where the file goes, instead of always landing in Downloads the way a plain browser download would. Everything else — RCSB fetch, cavity/void detection, orientation search, support-path preview — works exactly as it does in the browser build, since none of it touches the filesystem.

## Publishing a release

`.github/workflows/release.yml` builds installers for Windows, macOS (Apple Silicon and Intel) and Linux on GitHub Actions and attaches them to a **draft** release — nothing is public until you click Publish on the Releases page.

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` (all four must match — the release is named after it).
2. Replace `releaseBody` in `release.yml` with this release's notes. It is not generated automatically.
3. Commit and push `main`, then push a tag: `git tag v1.2.3 && git push origin v1.2.3`.
4. When all four builds finish (about 7 minutes), review the draft on the Releases page and publish it.

**Required secret:** the workflow creates the release with a token stored as the repository secret `RELEASE_TOKEN`, not GitHub's built-in `GITHUB_TOKEN` — since 2026-10-01 the built-in token has been refused when creating the release ("Resource not accessible by integration"), for reasons not yet determined. Use a fine-grained personal access token limited to this repository with **Contents: Read and write** and nothing else. When it expires, every build fails at the release step until you create a new one and update the secret (Settings → Secrets and variables → Actions). A fork needs its own `RELEASE_TOKEN` too.

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
- **What goes into a PDB/mmCIF surface:** crystallographic water is always left out (it would otherwise print as tiny loose fragments). Every other heteroatom — ligands, metal ions, buffer/cryo molecules — is listed after loading under "Ligands & ions found", where you can uncheck any of them and rebuild.
- **3MF colors:** a loaded 3MF keeps its own colors, read either from standard 3MF color groups or from PrusaSlicer/Bambu/Orca per-triangle paint data (which is how ChimeraX-Save3MF and slicer paint tools store them). Painted triangles that a slicer subdivided more finely than one color per triangle can't be decoded and show as gray.
- **Colorblind-safe colors:** the checkbox at the top of the panel switches chain colors, axis colors, overhang shading and cavity highlights to colorblind-safe palettes. Colors from an imported 3MF stay the file's own.
