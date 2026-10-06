import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { WHATS_NEW } from "./whats-new";

const REPO_URL = "https://github.com/erikeppinger/support-optimizer";
const RELEASES_URL = `${REPO_URL}/releases`;
const MANUAL_URL = "https://erikeppinger.github.io/support-optimizer/manual.html";
const SEEN_KEY = "support-optimizer.welcome-seen-version";
const RELEASES_SHOWN = 3;

const INFO_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="7.25" y="7" width="1.5" height="5" rx=".75" fill="currentColor"/><circle cx="8" cy="4.75" r=".95" fill="currentColor"/></svg>';
const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>';

function link(url: string, text: string): string {
  return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

/** Markup for the lower-right corner: About button, GitHub link, version. */
export function cornerBarHtml(version: string): string {
  return `
    <div id="corner-bar">
      <button type="button" id="about-btn" class="corner-icon" aria-label="About and quick start" title="About and quick start">${INFO_ICON}</button>
      <a id="github-link" class="corner-icon" href="${REPO_URL}" target="_blank" rel="noopener noreferrer" aria-label="Source code on GitHub" title="Source code on GitHub">${GITHUB_ICON}</a>
      <span id="version-badge">v: ${version}</span>
    </div>`;
}

function dialogHtml(version: string): string {
  const releases = WHATS_NEW.slice(0, RELEASES_SHOWN)
    .map(
      (r) =>
        `<li><strong>v${r.version}</strong><ul>${r.items.map((i) => `<li>${i}</li>`).join("")}</ul></li>`,
    )
    .join("");
  return `
    <div class="about-head">
      <h2>Support Optimizer <span class="about-version">v${version}</span></h2>
      <button type="button" class="about-close" aria-label="Close">&times;</button>
    </div>
    <div class="about-body">
      <p>Prepares molecular structures and other 3D models for printing: it builds a printable surface from a PDB or mmCIF entry, seals interior cavities so support material can't get trapped inside, finds the print orientation that needs the least support, and exports an STL or a multi-material 3MF.</p>
      <p class="about-note">Everything runs on your own computer. Files you load are never uploaded; only fetching a structure from RCSB goes online.</p>

      <h3>Quick start</h3>
      <ol>
        <li><strong>Load a model</strong> — drop an STL, PDB, mmCIF or 3MF file onto the viewer, or type a PDB ID under <em>1. Load model</em> and click Fetch (try <code>6LU7</code>).</li>
        <li><strong>Seal cavities</strong> — under <em>3. Voids &amp; cavities</em>, click Find cavities, then Fill selected cavities.</li>
        <li><strong>Optimize the orientation</strong> — under <em>4. Optimize orientation</em>, click Optimize orientation.</li>
        <li><strong>Export</strong> — under <em>5. Export</em>, save an STL, or a 3MF with one part per chain.</li>
      </ol>
      <p>Every control has a <span class="about-q">?</span> button that explains what it does.</p>

      <h3>What's new</h3>
      <ul class="about-news">${releases}</ul>

      <p class="about-links">${link(MANUAL_URL, "Manual")} · ${link(RELEASES_URL, "Desktop app for Windows, macOS and Linux")} · ${link(REPO_URL, "Source code on GitHub")}</p>
      <p class="about-fine">A personal tool, built with AI assistance (Claude) — see the README on GitHub before relying on it for anything important.</p>
    </div>`;
}

function readSeenVersion(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function writeSeenVersion(version: string) {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    // Storage blocked: the dialog just shows again next visit.
  }
}

/** Wires the corner bar and the About dialog. Opens it automatically on a
 * first visit and after an update (a different version than last seen). */
export function setupAboutDialog(version: string) {
  const dialog = document.createElement("dialog");
  dialog.id = "about-dialog";
  dialog.setAttribute("aria-labelledby", "about-title");
  dialog.innerHTML = dialogHtml(version);
  dialog.querySelector("h2")!.id = "about-title";
  document.body.appendChild(dialog);

  const open = () => {
    if (!dialog.open) dialog.showModal();
  };
  dialog.querySelector<HTMLButtonElement>(".about-close")!.addEventListener("click", () => dialog.close());
  // A click on the backdrop lands on the <dialog> element itself.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  document.querySelector<HTMLButtonElement>("#about-btn")!.addEventListener("click", open);

  // The desktop webview won't open target="_blank" links by itself.
  if (isTauri()) {
    document.addEventListener("click", (e) => {
      const a = (e.target as Element | null)?.closest?.("a[target=_blank]") as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault();
      openUrl(a.href).catch(() => {});
    });
  }

  // Recorded on showing, not on closing: the dialog's close event isn't
  // reliable in every embedded webview, and once per version is the intent.
  if (readSeenVersion() !== version) {
    open();
    writeSeenVersion(version);
  }
}
