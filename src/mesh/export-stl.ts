import * as THREE from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { weldGeometryForExport } from "./weld-geometry";
import { saveFile } from "./save-file";

const exporter = new STLExporter();

/**
 * Exports `mesh` as a binary STL and saves it (native Save As dialog in
 * the desktop build, an ordinary browser download otherwise — see
 * save-file.ts) — binary keeps the file small and is what slicers expect
 * by default.
 *
 * `baseHeightMm` (default 0) raises the model's lowest point to that Z
 * instead of resting it on the plate — useful for printing breakaway
 * support/interface layers first, on slicers that won't let you offset a
 * model's Z position relative to the bed. Applied to a cloned geometry
 * only, so the live working mesh (and its Z=0 invariant that later
 * operations like Optimize/Fill rely on) is never touched.
 *
 * Returns false if the user cancelled the native save dialog.
 */
export async function downloadMeshAsSTL(mesh: THREE.Mesh, filename: string, baseHeightMm = 0): Promise<boolean> {
  const exportGeometry = mesh.geometry.clone();
  exportGeometry.computeBoundingBox();
  const currentMinZ = exportGeometry.boundingBox!.min.z;
  const offsetZ = baseHeightMm - currentMinZ;
  if (Math.abs(offsetZ) > 1e-9) {
    exportGeometry.translate(0, 0, offsetZ);
  }

  // Every geometry this app produces (marching cubes, STL/3MF import) is a
  // non-indexed triangle soup with flat per-face normals — geometrically
  // closed (verified: see weld-geometry.test.ts) but represented as
  // disconnected vertex copies, which some slicers' manifold checkers flag
  // as "open edges" even though nothing is actually missing. Welding by
  // position turns it into a properly indexed, connected mesh before export.
  const weldedGeometry = weldGeometryForExport(exportGeometry);
  exportGeometry.dispose();
  const exportMesh = new THREE.Mesh(weldedGeometry);

  const data = exporter.parse(exportMesh, { binary: true }) as unknown as DataView;
  const bytes = new Uint8Array(new ArrayBuffer(data.byteLength));
  bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  weldedGeometry.dispose();

  return saveFile(bytes, filename, "stl", "application/sla");
}
