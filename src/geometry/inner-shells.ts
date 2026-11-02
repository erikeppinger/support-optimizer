import type { VoxelGrid } from "./voxelize";
import type { VoidComponent, ComponentHighlightMesh } from "./detect-voids";

/**
 * Closed inner shells of a triangle soup: connected pieces (by shared vertex
 * position) whose signed volume is negative — the inside surface of a pocket
 * enclosed by a single chain's own surface. Removing such a shell fills the
 * pocket exactly, which a voxel seal can only approximate (see
 * buildSealPatchMesh).
 */
export interface InnerShell {
  /** Triangle indices (into the soup, i.e. position.length / 9 of them). */
  triangles: number[];
  min: [number, number, number];
  max: [number, number, number];
  /** Enclosed volume (positive). */
  volume: number;
}

export function findInnerShells(position: Float32Array): InnerShell[] {
  const triCount = position.length / 9;
  const ids = new Map<string, number>();
  const vertexOf = new Int32Array(triCount * 3);
  for (let v = 0; v < triCount * 3; v++) {
    const key = `${position[v * 3]},${position[v * 3 + 1]},${position[v * 3 + 2]}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    vertexOf[v] = id;
  }
  const parent = new Int32Array(ids.size).map((_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  for (let t = 0; t < triCount; t++) {
    const a = find(vertexOf[t * 3]);
    parent[find(vertexOf[t * 3 + 1])] = a;
    parent[find(vertexOf[t * 3 + 2])] = a;
  }

  const volume = new Map<number, number>();
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = position[o], ay = position[o + 1], az = position[o + 2];
    const bx = position[o + 3], by = position[o + 4], bz = position[o + 5];
    const cx = position[o + 6], cy = position[o + 7], cz = position[o + 8];
    const r = find(vertexOf[t * 3]);
    volume.set(r, (volume.get(r) ?? 0) + (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6);
  }

  const shells = new Map<number, InnerShell>();
  for (let t = 0; t < triCount; t++) {
    const r = find(vertexOf[t * 3]);
    if (!(volume.get(r)! < 0)) continue;
    let s = shells.get(r);
    if (!s) {
      s = { triangles: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], volume: -volume.get(r)! };
      shells.set(r, s);
    }
    s.triangles.push(t);
    for (let k = 0; k < 9; k++) {
      const d = k % 3;
      if (position[t * 9 + k] < s.min[d]) s.min[d] = position[t * 9 + k];
      if (position[t * 9 + k] > s.max[d]) s.max[d] = position[t * 9 + k];
    }
  }
  return [...shells.values()];
}

/** Whether `p` lies inside `shell`'s closed surface (its winding number
 * around p is nonzero), by counting signed crossings of a +x ray. */
export function insideShell(position: Float32Array, shell: InnerShell, p: [number, number, number]): boolean {
  if (p[0] < shell.min[0] || p[0] > shell.max[0] || p[1] < shell.min[1] || p[1] > shell.max[1] || p[2] < shell.min[2] || p[2] > shell.max[2]) return false;
  // Nudge off the grid so the ray never runs exactly through an edge or vertex.
  const py = p[1] + 1.3e-6, pz = p[2] + 0.7e-6;
  let w = 0;
  for (const t of shell.triangles) {
    const o = t * 9;
    const ay = position[o + 1], az = position[o + 2], by = position[o + 4], bz = position[o + 5], cy = position[o + 7], cz = position[o + 8];
    const d = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    if (d === 0) continue;
    const u = ((py - ay) * (cz - az) - (pz - az) * (cy - ay)) / d;
    const v = ((by - ay) * (pz - az) - (bz - az) * (py - ay)) / d;
    if (u < 0 || v < 0 || u + v > 1) continue;
    const x = position[o] + u * (position[o + 3] - position[o]) + v * (position[o + 6] - position[o]);
    if (x > p[0]) w += d > 0 ? 1 : -1;
  }
  return w !== 0;
}

/**
 * Which inner shells to delete for the selected cavities, and which of
 * those cavities that fills completely. A voxel seal stops up to about a
 * voxel short of the wall wherever the outer surface is close (see
 * buildSealPatchMesh), and a slicer prints that sliver as a tiny walled
 * pocket; deleting the shell fills its pocket exactly.
 *
 * A shell is deleted when a selected cavity has voxel centers inside it and
 * no unselected cavity does — deleting it fills all of it. A cavity can
 * also reach past its shell, where the wall between the pocket and other
 * empty space is thinner than a voxel; such a cavity still needs a seal for
 * the rest, so only cavities lying wholly inside deleted shells are listed
 * in filledByRemoval.
 */
export function planInnerShellFills(
  position: Float32Array,
  grid: VoxelGrid,
  components: VoidComponent[],
  selectedIds: Set<number>,
  shells: InnerShell[] = findInnerShells(position),
): { removedTriangles: Int32Array; filledByRemoval: Set<number> } {
  const { nx, ny, voxelSize, origin } = grid;
  const shellsOf = new Map<number, Set<number>>();
  const enclosed = new Set<number>();
  for (const c of components) {
    if (c.kind !== "cavity") continue;
    if (c.innerShell !== undefined) {
      shellsOf.set(c.id, new Set([c.innerShell]));
      enclosed.add(c.id);
      continue;
    }
    const found = new Set<number>();
    let all = true;
    for (const v of c.voxels) {
      const z = Math.floor(v / (nx * ny));
      const y = Math.floor((v - z * nx * ny) / nx);
      const x = v - z * nx * ny - y * nx;
      const p: [number, number, number] = [origin.x + (x + 0.5) * voxelSize, origin.y + (y + 0.5) * voxelSize, origin.z + (z + 0.5) * voxelSize];
      const i = shells.findIndex((s) => insideShell(position, s, p));
      if (i < 0) all = false;
      else found.add(i);
    }
    shellsOf.set(c.id, found);
    if (all && found.size > 0) enclosed.add(c.id);
  }
  const blocked = new Set<number>();
  for (const [id, s] of shellsOf) if (!selectedIds.has(id)) for (const i of s) blocked.add(i);
  const remove = new Set<number>();
  for (const [id, s] of shellsOf) if (selectedIds.has(id)) for (const i of s) if (!blocked.has(i)) remove.add(i);
  const filledByRemoval = new Set<number>();
  for (const id of enclosed) {
    if (selectedIds.has(id) && [...shellsOf.get(id)!].every((i) => remove.has(i))) filledByRemoval.add(id);
  }
  return { removedTriangles: new Int32Array([...remove].flatMap((i) => shells[i].triangles)), filledByRemoval };
}

/** Smallest inner skin listed as a cavity of its own, as a share of one
 * detection voxel's volume. Below it are bubbles of a few triangles that
 * surface building leaves inside large structures — hundreds of them,
 * none printable. */
const MIN_SHELL_CAVITY_VOXELS = 0.125;

/**
 * Adds the mesh's closed inner skins that no detected cavity reaches as
 * cavities of their own (see VoidComponent.innerShell). A pocket inside a
 * single chain that is narrower than the detection grid has no empty voxel
 * center, so voxel detection misses it — but its skin is in the mesh at
 * any resolution, and removing it fills the pocket exactly. Deterministic
 * for the same mesh and grid, so ids match between detecting and filling.
 * Returns the components, re-sorted by size like detectVoidComponentsFull.
 */
export function addInnerShellCavities(
  position: Float32Array,
  grid: VoxelGrid,
  components: VoidComponent[],
  shells: InnerShell[] = findInnerShells(position),
): VoidComponent[] {
  if (shells.length === 0) return components;
  const { nx, ny, nz, voxelSize, origin } = grid;
  const reached = new Set<number>();
  for (const c of components) {
    if (c.kind !== "cavity") continue;
    for (const v of c.voxels) {
      const z = Math.floor(v / (nx * ny));
      const y = Math.floor((v - z * nx * ny) / nx);
      const x = v - z * nx * ny - y * nx;
      const p: [number, number, number] = [origin.x + (x + 0.5) * voxelSize, origin.y + (y + 0.5) * voxelSize, origin.z + (z + 0.5) * voxelSize];
      const i = shells.findIndex((s) => insideShell(position, s, p));
      if (i >= 0) reached.add(i);
    }
  }
  const voxelVolume = voxelSize ** 3;
  let nextId = components.reduce((m, c) => Math.max(m, c.id), -1) + 1;
  const added: VoidComponent[] = [];
  shells.forEach((shell, i) => {
    if (reached.has(i) || shell.volume < MIN_SHELL_CAVITY_VOXELS * voxelVolume) return;
    let sx = 0, sy = 0, sz = 0;
    for (const t of shell.triangles) for (let k = 0; k < 9; k += 3) {
      sx += position[t * 9 + k]; sy += position[t * 9 + k + 1]; sz += position[t * 9 + k + 2];
    }
    const n = shell.triangles.length * 3;
    added.push({
      id: nextId++,
      kind: "cavity",
      voxelCount: Math.max(1, Math.round(shell.volume / voxelVolume)),
      centroid: [sx / n, sy / n, sz / n],
      volumeFraction: shell.volume / (nx * ny * nz * voxelVolume),
      voxels: [],
      innerShell: i,
    });
  });
  return added.length ? [...components, ...added].sort((a, b) => b.voxelCount - a.voxelCount) : components;
}

/** Highlight mesh for a cavity found as an inner skin: the skin itself,
 * turned to face outward so it reads as a solid blob. */
export function innerShellHighlightMesh(position: Float32Array, shell: InnerShell, id: number): ComponentHighlightMesh {
  const out = new Float32Array(shell.triangles.length * 9);
  const normal = new Float32Array(out.length);
  shell.triangles.forEach((t, j) => {
    const o = t * 9, q = j * 9;
    // Swap the second and third corners to flip the facing.
    out.set(position.subarray(o, o + 3), q);
    out.set(position.subarray(o + 6, o + 9), q + 3);
    out.set(position.subarray(o + 3, o + 6), q + 6);
    const e1 = [out[q + 3] - out[q], out[q + 4] - out[q + 1], out[q + 5] - out[q + 2]];
    const e2 = [out[q + 6] - out[q], out[q + 7] - out[q + 1], out[q + 8] - out[q + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    for (let c = 0; c < 3; c++) for (let d = 0; d < 3; d++) normal[q + c * 3 + d] = n[d] / l;
  });
  return { id, position: out, normal };
}
