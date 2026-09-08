import { isTauri } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

/**
 * Writes `bytes` to disk as `filename`. In the desktop (Tauri) build this
 * opens a native Save As dialog so the user actually picks where the file
 * goes — a plain `<a download>` blob URL still "works" inside Tauri's
 * WebView2, but has no way to prompt for a location and always drops the
 * file silently into the OS Downloads folder, same as a browser with
 * "ask where to save" turned off. Everywhere else (the plain web build)
 * this is the ordinary blob-URL download, which is the only mechanism a
 * browser tab has.
 *
 * Returns false if the user cancelled the native dialog (nothing was
 * written), true otherwise.
 */
export async function saveFile(
  bytes: Uint8Array,
  filename: string,
  extension: string,
  mimeType: string,
): Promise<boolean> {
  if (isTauri()) {
    const path = await save({
      defaultPath: filename,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
    if (!path) return false;
    await writeFile(path, bytes);
    return true;
  }

  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  return true;
}
