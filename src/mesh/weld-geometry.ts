import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Welds a flat-shaded, non-indexed triangle soup (the shape every mesh in
 * this app is in — marching cubes and STL both produce one) into a
 * properly INDEXED mesh, for export only. Every geometry-generating path
 * here (marching cubes especially) computes per-FACE flat normals, so
 * adjacent triangles sharing an edge have vertices that sit at the exact
 * same position but carry different normals — THREE's own mergeVertices
 * hashes position+normal+every attribute together, so run against that
 * as-is it would never actually merge anything across a shared edge (only
 * within one triangle, which is already distinct by position). Welding by
 * position (+ color, so a color-boundary edge between two differently
 * colored regions is deliberately left split, which is correct — a vertex
 * can't be two colors at once) and recomputing normals afterward is what
 * actually produces a topologically connected, indexed mesh.
 *
 * This matters specifically for slicer "open edges" complaints: a
 * non-indexed triangle soup where every triangle owns unique vertex
 * copies (even at positions that coincide exactly with a neighboring
 * triangle's) reads as disconnected to some manifold checkers, even when
 * every position is geometrically shared. Only used at export time — the
 * live viewer keeps its current flat-shaded look and doesn't pay this
 * extra pass on every recolor/reframe.
 */
export function weldGeometryForExport(geometry: THREE.BufferGeometry, tolerance = 1e-5): THREE.BufferGeometry {
  const forWelding = new THREE.BufferGeometry();
  forWelding.setAttribute("position", geometry.getAttribute("position"));
  const colorAttr = geometry.getAttribute("color");
  if (colorAttr) forWelding.setAttribute("color", colorAttr);

  const welded = mergeVertices(forWelding, tolerance);
  welded.computeVertexNormals();
  return welded;
}
