/** Möller–Trumbore ray-triangle intersection. Returns the ray parameter t
 * (distance along the normalized direction) of the intersection, or null.
 * Shared by orientation-search's occlusion raycasting and support-path
 * generation, so both agree on exactly what "the surface below this
 * point" means. */
export function rayTriangleT(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  v0x: number, v0y: number, v0z: number,
  v1x: number, v1y: number, v1z: number,
  v2x: number, v2y: number, v2z: number,
): number | null {
  const EPS = 1e-9;
  const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
  const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < EPS) return null;
  const invDet = 1 / det;
  const tx = ox - v0x, ty = oy - v0y, tz = oz - v0z;
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < 0 || u + v > 1) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  if (t < EPS) return null;
  return t;
}

/** Nearest ray-triangle hit distance across the whole (non-indexed)
 * triangle soup, excluding face `skipFace` (its own originating face, to
 * avoid a self-hit). Returns Infinity if nothing is hit. O(triangles) —
 * the same brute-force approach evaluateOrientationCost uses. */
export function raycastNearest(
  position: Float32Array,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  skipFace: number,
): number {
  const triCount = position.length / 9;
  let best = Infinity;
  for (let g = 0; g < triCount; g++) {
    if (g === skipFace) continue;
    const j0 = g * 9, j1 = j0 + 3, j2 = j0 + 6;
    const t = rayTriangleT(
      ox, oy, oz, dx, dy, dz,
      position[j0], position[j0 + 1], position[j0 + 2],
      position[j1], position[j1 + 1], position[j1 + 2],
      position[j2], position[j2 + 1], position[j2 + 2],
    );
    if (t !== null && t < best) best = t;
  }
  return best;
}
