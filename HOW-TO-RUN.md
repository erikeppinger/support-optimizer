# Support Optimizer — Setup Guide

You've been sent `support-optimizer-app.zip`. This is a small self-contained web app for preparing molecular structures for 3D printing — it runs entirely in your own browser, nothing gets installed on your computer, and no data is sent anywhere except if you use the "fetch from RCSB" button.

It just needs to be **served** over a local address (`http://localhost:...`) instead of opened directly as a file — that's what the steps below do. It takes about a minute the first time.

## TL;DR (if you're comfortable with a terminal)

1. Unzip `support-optimizer-app.zip` anywhere.
2. Open a terminal in that unzipped folder.
3. Run **one** of these, whichever you have installed:
   ```bash
   npx serve .
   ```
   ```bash
   python -m http.server 8080
   ```
4. Open the URL it prints in your browser.

If that worked, you're done — skip to "Using the app" below. If not, follow the full steps.

---

## Step 1 — Unzip the file

Right-click `support-optimizer-app.zip` → **Extract All...** (Windows) or double-click it (Mac). Remember where you put the extracted folder — you'll open a terminal there in Step 3.

Inside, you should see `index.html`, a `favicon.svg`, and an `assets` folder. Don't open `index.html` directly by double-clicking it — see the note at the bottom for why.

## Step 2 — Check what you already have installed

You need **either** Node.js **or** Python — most computers already have at least one. Open a terminal (see below) and try both commands; whichever one prints a version number, you have.

**Opening a terminal:**
- **Windows:** press the Windows key, type `PowerShell`, press Enter.
- **Mac:** press Cmd+Space, type `Terminal`, press Enter.

**Checking what's installed:**
```bash
node --version
python --version
```
(On Mac, if `python --version` fails, also try `python3 --version`.)

If **neither** command works, install Node.js from **[nodejs.org](https://nodejs.org)** (the "LTS" download button) — that's the easiest fix, a normal installer, and you'll only need to do it once.

## Step 3 — Navigate to the unzipped folder

In the same terminal, move into the folder from Step 1. For example, if you unzipped it to your Desktop into a folder called `support-optimizer-app`:

```bash
cd Desktop\support-optimizer-app
```
(Use `\` on Windows, `/` on Mac — either way, typing the first few letters of the folder name and pressing Tab will auto-complete it for you.)

(On Windows, if you extracted it via File Explorer, you can also just open the extracted folder, then type `powershell` into the address bar at the top and press Enter — that opens a terminal already in the right place. If the command in Step 4 then fails with a message about "running scripts is disabled on this system", PowerShell is blocking it — open **Command Prompt** instead (Windows key → type `cmd` → Enter), navigate to the folder the same way, and run Step 4's command there instead.)

## Step 4 — Start it

**If you have Node.js:**
```bash
npx serve .
```
The first run downloads a small helper tool automatically (no separate install step) — just wait a few seconds. It may first ask something like `Need to install the following packages: serve. Ok to proceed? (y)` — type `y` and press Enter to accept; this only happens once. It will then print something like:
```
Accepting connections at http://localhost:3000
```

**If you have Python instead:**
```bash
python -m http.server 8080
```
(or `python3 -m http.server 8080` on Mac if needed). It will sit there quietly running — that's normal, it means it's working.

## Step 5 — Open it in your browser

Copy the address it printed (e.g. `http://localhost:3000`, or `http://localhost:8080` for the Python option) and paste it into Chrome, Edge, or Firefox.

You should see the app: a dark viewer panel with a controls panel on the left. That's it — you're running it.

**To stop it later:** close the browser tab first, then go back to the terminal window and press `Ctrl+C` (on Windows it may ask `Terminate batch job (Y/N)?` — type `Y` and press Enter to confirm). Your files aren't affected — run Step 4's command again any time you want to reopen it.

## Using the app

- **Load a structure:** either type a 4-character PDB ID (e.g. `6LU7`) and click Fetch, or click "Browse for a file…" to load your own `.stl`, `.pdb`, `.cif`, or `.3mf` file.
- Every section on the left has a small **"?"** button next to it — click one any time for a plain explanation of what that control does and how it's computed. It opens in a panel on the right.
- Nothing you do here is saved anywhere outside your own browser tab — closing the tab discards your session (export whatever you want to keep first, via the Export buttons at the bottom).

## Why not just double-click index.html?

Browsers deliberately block some of the things this app needs (loading its background worker, which does the heavy geometry computation) when a page is opened directly from disk instead of through a real address — you'd see a blank screen or a broken viewer. Serving it via Step 4, even just to yourself on `localhost`, is what makes that work correctly. This is normal for apps built this way, not something specific to this one.

## Troubleshooting

- **"npx: command not found" / "python: command not found"** — neither is installed; get Node.js from [nodejs.org](https://nodejs.org) (Step 2).
- **"running scripts is disabled on this system" (Windows PowerShell)** — PowerShell's default security setting blocks npx. Use **Command Prompt** instead (Windows key → type `cmd` → Enter) and run the same command there.
- **Browser shows a blank page** — double check the address bar shows `http://localhost:...`, not a `file://...` path.
- **Port already in use** — if `npx serve .` or the Python command complains a port is taken, just run `npx serve . -l 3001` (or another number nearby, e.g. 3002, 3003…) instead.
- **Still stuck** — check the browser's developer console (F12 → Console tab) for a red error message and send that along with what you tried.
