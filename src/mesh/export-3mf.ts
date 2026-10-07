import * as THREE from "three";
import { build3MF, buildPainted3MF, paintPalette, MAX_PAINTED_COLORS } from "./threemf";
import { weldGeometryForExport } from "./weld-geometry";
import { saveFile } from "./save-file";

export interface Export3MFResult {
  saved: boolean;
  /** "painted": one closed mesh with per-triangle slicer paint codes.
   * "split": one object per color, used past MAX_PAINTED_COLORS colors. */
  mode: "painted" | "split";
  colorCount: number;
}

/** One RGB per triangle of a non-indexed geometry, from its first vertex —
 * this app colors whole triangles, so all three vertices agree. */
function triangleColorsOf(geometry: THREE.BufferGeometry): Float32Array {
  const position = geometry.getAttribute("position");
  const color = geometry.getAttribute("color");
  const triCount = position.count / 3;
  const out = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const v = t * 3;
    out[t * 3] = color ? color.getX(v) : 0.7;
    out[t * 3 + 1] = color ? color.getY(v) : 0.7;
    out[t * 3 + 2] = color ? color.getZ(v) : 0.7;
  }
  return out;
}

/**
 * Exports `mesh` as a 3MF and saves it (native Save As dialog in the desktop
 * build, an ordinary download otherwise — see save-file.ts). Colors come
 * from `mesh.geometry`'s "color" attribute; the caller decides which
 * coloring that is (main.ts swaps in pure per-chain color so an on-screen
 * overhang highlight can't become a part).
 *
 * Up to MAX_PAINTED_COLORS colors are written as one closed mesh painted per
 * triangle (see buildPainted3MF). Beyond that, slicer painting has no codes
 * left, so the export falls back to one object per color — whose color
 * borders are open edges.
 * `baseHeightMm` mirrors downloadMeshAsSTL's breakaway-support offset,
 * applied to a cloned geometry only.
 */
export async function downloadMeshAs3MF(mesh: THREE.Mesh, filename: string, baseHeightMm = 0): Promise<Export3MFResult> {
  const exportGeometry = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone());
  exportGeometry.computeBoundingBox();
  const offsetZ = baseHeightMm - exportGeometry.boundingBox!.min.z;
  if (Math.abs(offsetZ) > 1e-9) exportGeometry.translate(0, 0, offsetZ);

  const triangleColors = triangleColorsOf(exportGeometry);
  const painted = paintPalette(triangleColors);

  let buffer: ArrayBuffer;
  let result: Omit<Export3MFResult, "saved">;
  if (painted) {
    // Welding by position only keeps triangle order, so triangleColors
    // still lines up with the welded index buffer.
    const welded = weldGeometryForExport(exportGeometry, 1e-5, { splitAtColorBorders: false });
    buffer = buildPainted3MF(welded, triangleColors);
    welded.dispose();
    result = { mode: "painted", colorCount: painted.palette.length };
  } else {
    const welded = weldGeometryForExport(exportGeometry);
    buffer = build3MF(welded);
    welded.dispose();
    result = { mode: "split", colorCount: MAX_PAINTED_COLORS + 1 };
  }
  exportGeometry.dispose();

  const saved = await saveFile(new Uint8Array(buffer), filename, "3mf", "model/3mf");
  return { saved, ...result };
}
