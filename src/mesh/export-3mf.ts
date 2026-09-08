import * as THREE from "three";
import { build3MF } from "./threemf";
import { weldGeometryForExport } from "./weld-geometry";
import { saveFile } from "./save-file";

/**
 * Exports `mesh` as a multi-material 3MF and saves it (native Save As
 * dialog in the desktop build, an ordinary browser download otherwise —
 * see save-file.ts) — unlike STL, 3MF carries a color per material group,
 * grouping triangles by whatever's currently on `mesh.geometry`'s own
 * "color" attribute (one object per distinct color) into separate
 * objects/materials, letting a multi-material slicer print each part in
 * its own color/filament. This function itself is agnostic to WHAT that
 * coloring means — the caller (see main.ts's export-3mf click handler) is
 * responsible for making sure it's whichever coloring should actually
 * define the exported parts (e.g. temporarily swapping in the pure
 * per-chain color instead of a view-only highlight blended into it, so a
 * screen-only visual aid can't fragment a single physical part into extra
 * objects with no real meaning).
 * `baseHeightMm` mirrors downloadMeshAsSTL's breakaway-support offset,
 * applied to a cloned geometry only.
 *
 * Returns false if the user cancelled the native save dialog.
 */
export async function downloadMeshAs3MF(mesh: THREE.Mesh, filename: string, baseHeightMm = 0): Promise<boolean> {
  const exportGeometry = mesh.geometry.clone();
  exportGeometry.computeBoundingBox();
  const currentMinZ = exportGeometry.boundingBox!.min.z;
  const offsetZ = baseHeightMm - currentMinZ;
  if (Math.abs(offsetZ) > 1e-9) {
    exportGeometry.translate(0, 0, offsetZ);
  }

  // build3MF needs real shared vertex indices (not a flat, nothing-ever-
  // shared triangle soup) to produce a file a slicer's manifold checker
  // recognizes as closed — see weld-geometry.ts.
  const weldedGeometry = weldGeometryForExport(exportGeometry);
  exportGeometry.dispose();

  const buffer = build3MF(weldedGeometry);
  weldedGeometry.dispose();

  return saveFile(new Uint8Array(buffer), filename, "3mf", "model/3mf");
}
