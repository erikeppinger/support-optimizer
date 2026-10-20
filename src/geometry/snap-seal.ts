import type { ComponentHighlightMesh } from "./detect-voids";

/** How far (detection voxels) a seal vertex may be moved to reach a wall. A
 * seal's marching-cubes surface sits on the voxel faces, so where its
 * overlap can't grow (near the outer surface, see buildSealPatchMesh) it
 * stops up to about a voxel short of the real wall. */
const SNAP_REACH_VOXELS = 1.5;
/** How far past the wall a snapped vertex goes, so the slicer sees overlap
 * rather than two surfaces touching — capped at half the wall's thickness,
 * so it never comes out the far side. */
const SNAP_MARGIN_VOXELS = 0.25;
/** Times each seal triangle is split in four before snapping. A seal's
 * triangles are about a voxel across; on a curved wall, one with some
 * corners snapped and others anchored inside material still spans a thin
 * gap. Two rounds bring edges down to about a quarter voxel. */
const SUBDIVISIONS = 2;

/**
 * Closes the slivers a cavity seal leaves against the real walls. A slicer
 * prints such a sliver as a tiny walled pocket (a ring with a pinhole),
 * even though the seal fills the rest of the cavity.
 *
 * From each seal vertex, a ray goes outward along the vertex normal. If the
 * first surface it meets faces back toward the vertex, the vertex sits in
 * empty space short of a wall, and moves along the ray just past that wall.
 * A vertex whose ray first meets a surface from behind is already inside
 * material — including near the outer surface — and stays put, so the seal
 * can't be pushed out of the model. Moving each vertex along its own normal
 * keeps neighbors apart; a triangle that would still flip or collapse gets
 * its corners put back, so the seal stays a clean closed surface.
 *
 * `mesh` is the model's triangle soup; triangles flagged in `skip` (inner
 * surfaces being removed by the same fill) are ignored. Seals are modified
 * in place (position and normal are replaced with subdivided arrays).
 */
export function snapSealsToWalls(seals: ComponentHighlightMesh[], mesh: Float32Array, voxelSize: number, skip?: Uint8Array): void {
  if (seals.length === 0) return;
  const reach = SNAP_REACH_VOXELS * voxelSize;
  const margin = SNAP_MARGIN_VOXELS * voxelSize;

  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const s of seals) {
    for (let i = 0; i < s.position.length; i += 3) {
      for (let d = 0; d < 3; d++) {
        lo[d] = Math.min(lo[d], s.position[i + d] - 2 * reach);
        hi[d] = Math.max(hi[d], s.position[i + d] + 2 * reach);
      }
    }
  }

  // Spatial hash of the model's triangles near any seal, one cell per voxel.
  const cell = voxelSize;
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const cells = new Map<string, number[]>();
  const triCount = mesh.length / 9;
  for (let t = 0; t < triCount; t++) {
    if (skip && skip[t]) continue;
    const o = t * 9;
    const mn = [Math.min(mesh[o], mesh[o + 3], mesh[o + 6]), Math.min(mesh[o + 1], mesh[o + 4], mesh[o + 7]), Math.min(mesh[o + 2], mesh[o + 5], mesh[o + 8])];
    const mx = [Math.max(mesh[o], mesh[o + 3], mesh[o + 6]), Math.max(mesh[o + 1], mesh[o + 4], mesh[o + 7]), Math.max(mesh[o + 2], mesh[o + 5], mesh[o + 8])];
    if (mx[0] < lo[0] || mn[0] > hi[0] || mx[1] < lo[1] || mn[1] > hi[1] || mx[2] < lo[2] || mn[2] > hi[2]) continue;
    for (let x = Math.floor(mn[0] / cell); x <= Math.floor(mx[0] / cell); x++)
      for (let y = Math.floor(mn[1] / cell); y <= Math.floor(mx[1] / cell); y++)
        for (let z = Math.floor(mn[2] / cell); z <= Math.floor(mx[2] / cell); z++) {
          const k = key(x, y, z);
          const list = cells.get(k);
          if (list) list.push(t);
          else cells.set(k, [t]);
        }
  }

  /** Hits of the segment p + s·dir, s in [0, len], as [s, facing] with
   * facing < 0 when the ray enters through the triangle's front side. */
  const hits = (p: number[], dir: number[], len: number): [number, number][] => {
    const seen = new Set<number>();
    const out: [number, number][] = [];
    const end = [p[0] + dir[0] * len, p[1] + dir[1] * len, p[2] + dir[2] * len];
    for (let x = Math.floor(Math.min(p[0], end[0]) / cell); x <= Math.floor(Math.max(p[0], end[0]) / cell); x++)
      for (let y = Math.floor(Math.min(p[1], end[1]) / cell); y <= Math.floor(Math.max(p[1], end[1]) / cell); y++)
        for (let z = Math.floor(Math.min(p[2], end[2]) / cell); z <= Math.floor(Math.max(p[2], end[2]) / cell); z++) {
          for (const t of cells.get(key(x, y, z)) ?? []) {
            if (seen.has(t)) continue;
            seen.add(t);
            const o = t * 9;
            const e1 = [mesh[o + 3] - mesh[o], mesh[o + 4] - mesh[o + 1], mesh[o + 5] - mesh[o + 2]];
            const e2 = [mesh[o + 6] - mesh[o], mesh[o + 7] - mesh[o + 1], mesh[o + 8] - mesh[o + 2]];
            const h = [dir[1] * e2[2] - dir[2] * e2[1], dir[2] * e2[0] - dir[0] * e2[2], dir[0] * e2[1] - dir[1] * e2[0]];
            const a = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
            if (Math.abs(a) < 1e-12) continue;
            const sv = [p[0] - mesh[o], p[1] - mesh[o + 1], p[2] - mesh[o + 2]];
            const u = (sv[0] * h[0] + sv[1] * h[1] + sv[2] * h[2]) / a;
            if (u < 0 || u > 1) continue;
            const q = [sv[1] * e1[2] - sv[2] * e1[1], sv[2] * e1[0] - sv[0] * e1[2], sv[0] * e1[1] - sv[1] * e1[0]];
            const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) / a;
            if (v < 0 || u + v > 1) continue;
            const s = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / a;
            if (s <= 1e-9 * voxelSize || s > len) continue;
            const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            out.push([s, n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2]]);
          }
        }
    return out.sort((x, y) => x[0] - y[0]);
  };

  for (const seal of seals) {
    let pos = seal.position;
    for (let i = 0; i < SUBDIVISIONS; i++) pos = subdivide(pos);
    seal.position = pos;
    seal.normal = new Float32Array(pos.length);
    // Weld the soup so every copy of a corner moves together (no cracks).
    const ids = new Map<string, number>();
    const vertexOf = new Int32Array(pos.length / 3);
    const corners: number[] = [];
    for (let v = 0; v < pos.length / 3; v++) {
      const k = `${pos[v * 3]},${pos[v * 3 + 1]},${pos[v * 3 + 2]}`;
      let id = ids.get(k);
      if (id === undefined) {
        id = ids.size;
        ids.set(k, id);
        corners.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
      }
      vertexOf[v] = id;
    }
    const points = new Float64Array(corners);
    const triCount = pos.length / 9;
    const cornerOf = (t: number, c: number) => vertexOf[t * 3 + c];
    const faceNormal = (P: Float64Array, t: number) => {
      const a = cornerOf(t, 0) * 3, b = cornerOf(t, 1) * 3, c = cornerOf(t, 2) * 3;
      const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
      const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      return [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    };
    // Area-weighted vertex normals.
    const normals = new Float64Array(points.length);
    for (let t = 0; t < triCount; t++) {
      const n = faceNormal(points, t);
      for (let c = 0; c < 3; c++) for (let d = 0; d < 3; d++) normals[cornerOf(t, c) * 3 + d] += n[d];
    }
    const moved = new Float64Array(points);
    for (let id = 0; id < ids.size; id++) {
      const n = [normals[id * 3], normals[id * 3 + 1], normals[id * 3 + 2]];
      const len = Math.hypot(n[0], n[1], n[2]);
      if (len === 0) continue;
      const dir = [n[0] / len, n[1] / len, n[2] / len];
      const p = [points[id * 3], points[id * 3 + 1], points[id * 3 + 2]];
      const found = hits(p, dir, reach + margin);
      if (found.length === 0 || found[0][1] >= 0 || found[0][0] > reach) continue;
      const wall = found[0][0];
      const next = found.length > 1 ? found[1][0] : Infinity;
      const s = wall + Math.min(margin, (next - wall) / 2);
      for (let d = 0; d < 3; d++) moved[id * 3 + d] = p[d] + dir[d] * s;
    }
    // Put back the corners of any triangle that flipped or collapsed, until
    // none is left.
    for (let changed = true; changed; ) {
      changed = false;
      for (let t = 0; t < triCount; t++) {
        const before = faceNormal(points, t), after = faceNormal(moved, t);
        const lb = Math.hypot(before[0], before[1], before[2]), la = Math.hypot(after[0], after[1], after[2]);
        const ok = la > lb * 1e-3 && before[0] * after[0] + before[1] * after[1] + before[2] * after[2] > 0.1 * lb * la;
        if (ok) continue;
        for (let c = 0; c < 3; c++) {
          const id = cornerOf(t, c);
          if (moved[id * 3] !== points[id * 3] || moved[id * 3 + 1] !== points[id * 3 + 1] || moved[id * 3 + 2] !== points[id * 3 + 2]) {
            for (let d = 0; d < 3; d++) moved[id * 3 + d] = points[id * 3 + d];
            changed = true;
          }
        }
      }
    }
    for (let v = 0; v < pos.length / 3; v++) {
      const id = vertexOf[v];
      for (let d = 0; d < 3; d++) pos[v * 3 + d] = moved[id * 3 + d];
    }
    // Flat normals for the moved triangles.
    for (let t = 0; t < pos.length / 9; t++) {
      const o = t * 9;
      const e1 = [pos[o + 3] - pos[o], pos[o + 4] - pos[o + 1], pos[o + 5] - pos[o + 2]];
      const e2 = [pos[o + 6] - pos[o], pos[o + 7] - pos[o + 1], pos[o + 8] - pos[o + 2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      for (let c = 0; c < 3; c++) for (let d = 0; d < 3; d++) seal.normal[o + c * 3 + d] = n[d] / l;
    }
  }
}


/** Splits each triangle of a soup into four at its edge midpoints. */
function subdivide(pos: Float32Array): Float32Array {
  const out = new Float32Array(pos.length * 4);
  let o = 0;
  const put = (p: number[]) => { out[o++] = p[0]; out[o++] = p[1]; out[o++] = p[2]; };
  for (let t = 0; t < pos.length; t += 9) {
    const a = [pos[t], pos[t + 1], pos[t + 2]], b = [pos[t + 3], pos[t + 4], pos[t + 5]], c = [pos[t + 6], pos[t + 7], pos[t + 8]];
    const ab = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const bc = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2, (b[2] + c[2]) / 2];
    const ca = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2, (c[2] + a[2]) / 2];
    for (const tri of [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]]) for (const p of tri) put(p);
  }
  return out;
}
