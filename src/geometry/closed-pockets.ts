import * as THREE from "three";
import type { VoxelGrid } from "./voxelize";
import { fillInterior, voxelIndex } from "./voxelize";
import { marchingCubes } from "./marching-cubes";
import type { VoidComponent } from "./detect-voids";
import { insideShell, type InnerShell } from "./inner-shells";

/** Fine cell size as a share of the detection voxel. A seal stops up to
 * about a voxel short of a wall it may not overlap, and the empty sliver
 * left there is a fraction of a voxel thin. */
const CELLS_PER_VOXEL = 6;
/** Margin around a seal's bounding box searched for enclosed space, in
 * detection voxels. */
const MARGIN_VOXELS = 3;
/** Largest fine grid per seal; the cell grows when a seal is bigger. */
const MAX_CELLS = 4_000_000;
/** How far a fill reaches into the material around it, in fine cells. */
const OVERLAP_CELLS = 2;
/** Material a fill may reach into must be at least this many cells from
 * open space, so it stays clear of the outer surface. */
const MIN_OPEN_DISTANCE_CELLS = OVERLAP_CELLS + 1;

export interface PocketFill {
  position: Float32Array;
  normal: Float32Array;
  centroid: [number, number, number];
}

/** What filling left empty on purpose: cavities the user did not select. */
export interface UnfilledCavities {
  /** The model as detected (before filling), which `shells` index into. */
  position: Float32Array;
  grid: VoxelGrid;
  components: VoidComponent[];
  unfilledIds: Set<number>;
  shells: InnerShell[];
}

/**
 * Fills empty space a fill has enclosed, at a resolution fine enough to
 * see it. A voxel seal stops up to about a voxel short of a wall it is not
 * allowed to overlap (near the outer surface), and once it closes the
 * pocket's opening, that thin sliver is sealed in: the slicer prints it as
 * a hollow pocket with walls of its own. Around each seal (`seals`, in the
 * finished model `model`), this classifies a fine grid of cells as inside
 * or outside the model; empty cells not connected to the edge of that grid
 * are enclosed. Each enclosed region that is not part of a cavity left
 * unfilled gets a fill of its own cells plus the material up to
 * OVERLAP_CELLS around it, so the slicer merges it with its surroundings.
 */
export function fillEnclosedNearSeals(
  model: Float32Array,
  seals: Float32Array[],
  detectionVoxel: number,
  unfilled: UnfilledCavities,
): PocketFill[] {
  const fills: PocketFill[] = [];
  const isUnfilled = unfilledTest(unfilled);
  // Neighboring seals' boxes overlap, and a pocket inside both would be
  // found once per box; it is filled only the first time.
  const filledShells: { position: Float32Array; shell: InnerShell }[] = [];
  const isFilled = (p: [number, number, number]) => filledShells.some((f) => insideShell(f.position, f.shell, p));
  for (const seal of seals) {
    if (seal.length === 0) continue;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < seal.length; i += 3) {
      for (let d = 0; d < 3; d++) {
        lo[d] = Math.min(lo[d], seal[i + d]);
        hi[d] = Math.max(hi[d], seal[i + d]);
      }
    }
    const margin = MARGIN_VOXELS * detectionVoxel;
    for (let d = 0; d < 3; d++) {
      lo[d] -= margin;
      hi[d] += margin;
    }
    let cell = detectionVoxel / CELLS_PER_VOXEL;
    const volume = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);
    if (volume / cell ** 3 > MAX_CELLS) cell = Math.cbrt(volume / MAX_CELLS);
    for (const fill of fillEnclosedInBox(model, lo, hi, cell, isUnfilled, isFilled)) {
      fills.push(fill);
      filledShells.push({ position: fill.position, shell: meshShell(fill.position) });
    }
  }
  return fills;
}

function fillEnclosedInBox(
  model: Float32Array,
  lo: number[],
  hi: number[],
  cell: number,
  isUnfilled: (p: [number, number, number]) => boolean,
  isFilled: (p: [number, number, number]) => boolean,
): PocketFill[] {
  const nx = Math.ceil((hi[0] - lo[0]) / cell), ny = Math.ceil((hi[1] - lo[1]) / cell), nz = Math.ceil((hi[2] - lo[2]) / cell);
  const total = nx * ny * nz;
  const grid: VoxelGrid = { nx, ny, nz, voxelSize: cell, origin: new THREE.Vector3(lo[0], lo[1], lo[2]), solid: new Uint8Array(total) };
  fillInterior(grid, model);
  const solid = grid.solid;
  const coords = (i: number) => {
    const z = Math.floor(i / (nx * ny));
    const y = Math.floor((i - z * nx * ny) / nx);
    return [i - z * nx * ny - y * nx, y, z];
  };
  // Runs 6× per cell in each flood below, so no allocation here.
  const nxy = nx * ny;
  const neighbor = (i: number, k: number) => {
    switch (k) {
      case 0: return i % nx === nx - 1 ? -1 : i + 1;
      case 1: return i % nx === 0 ? -1 : i - 1;
      case 2: return Math.floor(i / nx) % ny === ny - 1 ? -1 : i + nx;
      case 3: return Math.floor(i / nx) % ny === 0 ? -1 : i - nx;
      case 4: return i + nxy >= total ? -1 : i + nxy;
      default: return i < nxy ? -1 : i - nxy;
    }
  };

  // Open space: empty cells connected to the edge of the box.
  const open = new Uint8Array(total);
  const queue: number[] = [];
  for (let i = 0; i < total; i++) {
    if (solid[i]) continue;
    const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / nxy);
    if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) {
      open[i] = 1;
      queue.push(i);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    for (let k = 0; k < 6; k++) {
      const n = neighbor(queue[q], k);
      if (n >= 0 && !solid[n] && !open[n]) {
        open[n] = 1;
        queue.push(n);
      }
    }
  }

  // Distance (in cell steps, up to MIN_OPEN_DISTANCE_CELLS) from open space.
  const openDist = new Uint8Array(total).fill(255);
  let front = queue;
  for (const i of front) openDist[i] = 0;
  for (let d = 1; d <= MIN_OPEN_DISTANCE_CELLS && front.length; d++) {
    const next: number[] = [];
    for (const i of front) {
      for (let k = 0; k < 6; k++) {
        const n = neighbor(i, k);
        if (n >= 0 && openDist[n] === 255) {
          openDist[n] = d;
          next.push(n);
        }
      }
    }
    front = next;
  }

  const fills: PocketFill[] = [];
  const seen = new Uint8Array(total);
  for (let s = 0; s < total; s++) {
    if (solid[s] || open[s] || seen[s]) continue;
    const pocket = [s];
    seen[s] = 1;
    for (let q = 0; q < pocket.length; q++) {
      for (let k = 0; k < 6; k++) {
        const n = neighbor(pocket[q], k);
        if (n >= 0 && !solid[n] && !seen[n]) {
          seen[n] = 1;
          pocket.push(n);
        }
      }
    }
    const center = (i: number): [number, number, number] => {
      const [x, y, z] = coords(i);
      return [lo[0] + (x + 0.5) * cell, lo[1] + (y + 0.5) * cell, lo[2] + (z + 0.5) * cell];
    };
    const sample = Math.max(1, Math.floor(pocket.length / 50));
    let left = false, sampled = 0, alreadyFilled = 0;
    for (let j = 0; j < pocket.length && !left; j += sample) {
      const c = center(pocket[j]);
      left = isUnfilled(c);
      sampled++;
      if (isFilled(c)) alreadyFilled++;
    }
    // Mostly inside an earlier fill: the same pocket, seen from another
    // seal's box.
    if (left || alreadyFilled * 2 >= sampled) continue;

    // The pocket plus the material within OVERLAP_CELLS of it that is far
    // enough from open space.
    const fill = new Set(pocket);
    let ring = pocket;
    for (let d = 0; d < OVERLAP_CELLS; d++) {
      const next: number[] = [];
      for (const i of ring) {
        for (let k = 0; k < 6; k++) {
          const n = neighbor(i, k);
          if (n >= 0 && solid[n] && !fill.has(n) && openDist[n] >= MIN_OPEN_DISTANCE_CELLS) {
            fill.add(n);
            next.push(n);
          }
        }
      }
      ring = next;
    }
    const mesh = remesh(grid, [...fill]);
    if (mesh.position.length === 0) continue;
    let cx = 0, cy = 0, cz = 0;
    for (const i of pocket) {
      const c = center(i);
      cx += c[0]; cy += c[1]; cz += c[2];
    }
    fills.push({ ...mesh, centroid: [cx / pocket.length, cy / pocket.length, cz / pocket.length] });
  }
  return fills;
}

/** Marching-cubes mesh of a set of cells, on a cropped, padded copy. */
function remesh(grid: VoxelGrid, cells: number[]): { position: Float32Array; normal: Float32Array } {
  const { nx, ny, voxelSize, origin } = grid;
  const xyz = cells.map((i) => {
    const z = Math.floor(i / (nx * ny));
    const y = Math.floor((i - z * nx * ny) / nx);
    return [i - z * nx * ny - y * nx, y, z];
  });
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of xyz) for (let d = 0; d < 3; d++) { min[d] = Math.min(min[d], p[d]); max[d] = Math.max(max[d], p[d]); }
  const sub: VoxelGrid = {
    nx: max[0] - min[0] + 3, ny: max[1] - min[1] + 3, nz: max[2] - min[2] + 3,
    voxelSize,
    origin: new THREE.Vector3(origin.x + (min[0] - 1) * voxelSize, origin.y + (min[1] - 1) * voxelSize, origin.z + (min[2] - 1) * voxelSize),
    solid: new Uint8Array((max[0] - min[0] + 3) * (max[1] - min[1] + 3) * (max[2] - min[2] + 3)),
  };
  for (const p of xyz) sub.solid[voxelIndex(sub, p[0] - min[0] + 1, p[1] - min[1] + 1, p[2] - min[2] + 1)] = 1;
  const g = marchingCubes(sub);
  return { position: g.attributes.position.array as Float32Array, normal: g.attributes.normal.array as Float32Array };
}

/** A closed mesh of its own as an InnerShell over all of its triangles, so
 * insideShell can test points against it. */
function meshShell(position: Float32Array): InnerShell {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3) {
    for (let d = 0; d < 3; d++) {
      min[d] = Math.min(min[d], position[i + d]);
      max[d] = Math.max(max[d], position[i + d]);
    }
  }
  return { triangles: Array.from({ length: position.length / 9 }, (_, t) => t), min, max, volume: 0 };
}

/** Whether a point lies in a cavity the user left unfilled: in or next to
 * a detected cavity's voxel (its walls run through the neighboring voxels,
 * which the grid counts as solid), or inside an unfilled inner skin. */
function unfilledTest(unfilled: UnfilledCavities): (p: [number, number, number]) => boolean {
  const { position, grid: g, components, unfilledIds, shells } = unfilled;
  const voxels = new Set<number>();
  const skins: InnerShell[] = [];
  for (const c of components) {
    if (c.kind !== "cavity" || !unfilledIds.has(c.id)) continue;
    if (c.innerShell !== undefined) skins.push(shells[c.innerShell]);
    else for (const v of c.voxels) voxels.add(v);
  }
  return (p) => {
    const ix = Math.floor((p[0] - g.origin.x) / g.voxelSize);
    const iy = Math.floor((p[1] - g.origin.y) / g.voxelSize);
    const iz = Math.floor((p[2] - g.origin.z) / g.voxelSize);
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = ix + dx, y = iy + dy, z = iz + dz;
          if (x >= 0 && y >= 0 && z >= 0 && x < g.nx && y < g.ny && z < g.nz && voxels.has(voxelIndex(g, x, y, z))) return true;
        }
    return skins.some((s) => insideShell(position, s, p));
  };
}
