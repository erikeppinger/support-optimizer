import * as THREE from "three";
import type { VoxelGrid } from "./voxelize";
import { PAD, voxelIndex } from "./voxelize";
import { floodFillExterior } from "./flood-fill";
import { marchingCubes } from "./marching-cubes";
import { distanceTransform3D } from "./distance-transform";

export type VoidKind = "cavity" | "tunnel";

export interface VoidComponentSummary {
  id: number;
  kind: VoidKind;
  voxelCount: number;
  /** World-space centroid, for the UI to describe roughly where it is. */
  centroid: [number, number, number];
  /** This component's voxels as a fraction (0-1) of the WHOLE detection
   * grid's own voxel count — the grid is sized to just contain the model
   * plus a small fixed padding margin, so this is a good proxy for "how
   * much of the model itself" a void takes up. A genuine local pocket or
   * interface gap is always a small fraction of this; something close to
   * the whole grid is a sign the flood-fill swept in the open space
   * around/between distant parts of the model rather than a real sealed
   * void — see the fill-size safety check in main.ts that reads this. */
  volumeFraction: number;
}

export interface VoidComponent extends VoidComponentSummary {
  voxels: number[];
}

/** BFS-labels connected components of every voxel matching `includeVoxel`.
 * Shared by cavity and tunnel detection below — same traversal, different
 * predicate for which empty voxels count as part of the region. */
function labelComponents(grid: VoxelGrid, includeVoxel: (idx: number) => boolean): number[][] {
  const { nx, ny, nz } = grid;
  const total = nx * ny * nz;
  const stepX = 1, stepY = nx, stepZ = nx * ny;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const components: number[][] = [];

  for (let start = 0; start < total; start++) {
    if (visited[start] || !includeVoxel(start)) continue;

    let head = 0, tail = 0;
    visited[start] = 1;
    queue[tail++] = start;
    const component: number[] = [start];

    while (head < tail) {
      const idx = queue[head++];
      const z = Math.floor(idx / stepZ);
      const y = Math.floor((idx - z * stepZ) / stepY);
      const x = idx - z * stepZ - y * stepY;

      if (x > 0) { const n = idx - stepX; if (!visited[n] && includeVoxel(n)) { visited[n] = 1; queue[tail++] = n; component.push(n); } }
      if (x < nx - 1) { const n = idx + stepX; if (!visited[n] && includeVoxel(n)) { visited[n] = 1; queue[tail++] = n; component.push(n); } }
      if (y > 0) { const n = idx - stepY; if (!visited[n] && includeVoxel(n)) { visited[n] = 1; queue[tail++] = n; component.push(n); } }
      if (y < ny - 1) { const n = idx + stepY; if (!visited[n] && includeVoxel(n)) { visited[n] = 1; queue[tail++] = n; component.push(n); } }
      if (z > 0) { const n = idx - stepZ; if (!visited[n] && includeVoxel(n)) { visited[n] = 1; queue[tail++] = n; component.push(n); } }
      if (z < nz - 1) { const n = idx + stepZ; if (!visited[n] && includeVoxel(n)) { visited[n] = 1; queue[tail++] = n; component.push(n); } }
    }

    components.push(component);
  }

  return components;
}

function toComponent(id: number, kind: VoidKind, voxels: number[], grid: VoxelGrid): VoidComponent {
  const { nx, ny, nz, voxelSize, origin } = grid;
  let sx = 0, sy = 0, sz = 0;
  for (const idx of voxels) {
    const z = Math.floor(idx / (nx * ny));
    const y = Math.floor((idx - z * nx * ny) / nx);
    const x = idx - z * nx * ny - y * nx;
    sx += x; sy += y; sz += z;
  }
  const n = voxels.length;
  const centroid: [number, number, number] = [
    origin.x + (sx / n + 0.5) * voxelSize,
    origin.y + (sy / n + 0.5) * voxelSize,
    origin.z + (sz / n + 0.5) * voxelSize,
  ];
  const volumeFraction = n / (nx * ny * nz);
  return { id, kind, voxelCount: n, centroid, volumeFraction, voxels };
}

export interface VoidDetectionResult {
  components: VoidComponent[];
  /** The exterior-reachable empty-voxel mask from this same flood-fill
   * pass — exposed so seal-building (buildSealContext) can reuse it
   * instead of re-running floodFillExterior from scratch. */
  reached: Uint8Array;
}

/**
 * Enumerates every distinct internal void as its own component instead of
 * lumping them into one fill-everything operation, so the caller can list
 * them and let the user pick which to fill.
 *
 * - "cavity": empty voxels flood-fill never reaches from outside — each
 *   disconnected enclosed region is its own component (fillable).
 * - "tunnel": empty voxels flood-fill *does* reach, but that are still
 *   within the mesh's own bounds (excluding voxelizeSurface's padding
 *   shell) — a heuristic for "open channel through the part" rather than
 *   the ordinary exterior. Imperfect for concave shapes (some genuinely
 *   exterior space near a concavity can get swept in), but a useful
 *   heads-up regardless. Fillable too (see buildSealPatchMesh) — the
 *   erosion margin protects a tunnel's own opening the same way it
 *   protects a cavity from an over-thin exterior wall.
 */
export function detectVoidComponentsFull(grid: VoxelGrid): VoidDetectionResult {
  const { nx, ny, nz, solid } = grid;
  const reached = floodFillExterior(grid);

  const cavityVoxelSets = labelComponents(grid, (idx) => !solid[idx] && !reached[idx]);

  function isInterior(idx: number): boolean {
    const z = Math.floor(idx / (nx * ny));
    const y = Math.floor((idx - z * nx * ny) / nx);
    const x = idx - z * nx * ny - y * nx;
    return x >= PAD && x < nx - PAD && y >= PAD && y < ny - PAD && z >= PAD && z < nz - PAD;
  }
  const tunnelVoxelSets = labelComponents(grid, (idx) => !solid[idx] && !!reached[idx] && isInterior(idx));

  let id = 0;
  const components: VoidComponent[] = [];
  for (const voxels of cavityVoxelSets) components.push(toComponent(id++, "cavity", voxels, grid));
  for (const voxels of tunnelVoxelSets) components.push(toComponent(id++, "tunnel", voxels, grid));

  components.sort((a, b) => b.voxelCount - a.voxelCount);
  return { components, reached };
}

export function detectVoidComponents(grid: VoxelGrid): VoidComponent[] {
  return detectVoidComponentsFull(grid).components;
}

export function summarize(components: VoidComponent[]): VoidComponentSummary[] {
  return components.map(({ id, kind, voxelCount, centroid, volumeFraction }) => ({ id, kind, voxelCount, centroid, volumeFraction }));
}

export interface ComponentHighlightMesh {
  id: number;
  position: Float32Array;
  normal: Float32Array;
}

/**
 * Remeshes an arbitrary voxel subset (must all belong to the same grid)
 * into a small standalone mesh, by building a tightly cropped sub-grid
 * around just those voxels (their own bounding box + 1 voxel padding)
 * rather than remeshing the whole detection grid with everything else
 * masked out — the subset is typically a small fraction of the full
 * model, so cropping keeps this O(subset size) instead of O(whole grid).
 * Shared by the full-extent highlight preview and the eroded seal patch
 * below, which differ only in which voxels they pass in.
 */
function remeshVoxelSubset(grid: VoxelGrid, id: number, voxels: number[]): ComponentHighlightMesh {
  const { nx, ny, voxelSize, origin } = grid;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const idx of voxels) {
    const z = Math.floor(idx / (nx * ny));
    const y = Math.floor((idx - z * nx * ny) / nx);
    const x = idx - z * nx * ny - y * nx;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const pad = 1;
  const subNx = maxX - minX + 1 + pad * 2;
  const subNy = maxY - minY + 1 + pad * 2;
  const subNz = maxZ - minZ + 1 + pad * 2;
  const subSolid = new Uint8Array(subNx * subNy * subNz);
  const subOrigin = new THREE.Vector3(
    origin.x + (minX - pad) * voxelSize,
    origin.y + (minY - pad) * voxelSize,
    origin.z + (minZ - pad) * voxelSize,
  );
  const subGrid: VoxelGrid = { nx: subNx, ny: subNy, nz: subNz, voxelSize, origin: subOrigin, solid: subSolid };

  for (const idx of voxels) {
    const z = Math.floor(idx / (nx * ny));
    const y = Math.floor((idx - z * nx * ny) / nx);
    const x = idx - z * nx * ny - y * nx;
    subSolid[voxelIndex(subGrid, x - minX + pad, y - minY + pad, z - minZ + pad)] = 1;
  }

  const geometry = marchingCubes(subGrid);
  return {
    id,
    position: geometry.attributes.position.array as Float32Array,
    normal: geometry.attributes.normal.array as Float32Array,
  };
}

/**
 * Remeshes a single void component's own (full-extent) voxels — "what
 * does this cavity actually look like" — so the UI can highlight it
 * directly on/in the model for visibility and manual selection. This is
 * detection-only: it never feeds the actual seal (see buildSealPatchMesh)
 * precisely because it's drawn right at the detected boundary.
 */
export function buildCavityHighlightMesh(grid: VoxelGrid, component: VoidComponent): ComponentHighlightMesh {
  return remeshVoxelSubset(grid, component.id, component.voxels);
}

export interface SealContext {
  /** Per-voxel Euclidean distance (detection-voxel units) to the nearest
   * solid voxel — how far a tunnel's seal is pulled back from its walls. */
  solidDist: Float32Array;
  /** Per-voxel distance to the nearest voxel floodFillExterior reached from
   * outside — bounds how far a cavity's seal may grow into solid material
   * without approaching the outer surface. */
  exteriorDist: Float32Array;
}

/** Builds the two distance fields sealing needs, from the SAME flood-fill
 * `detectVoidComponentsFull` already ran — pass its `reached` straight
 * through rather than re-running floodFillExterior. Cheap (two more
 * linear-time separable passes over the same grid) and shared across
 * every component being sealed in one Fill operation, so callers should
 * compute this once per grid, not once per cavity. */
export function buildSealContext(grid: VoxelGrid, reached: Uint8Array): SealContext {
  const { nx, ny, nz, solid } = grid;
  return {
    solidDist: distanceTransform3D(solid, nx, ny, nz),
    exteriorDist: distanceTransform3D(reached, nx, ny, nz),
  };
}

/** How many detection voxels a TUNNEL's seal is pulled back from its walls.
 * Tunnels are detected among space reachable from outside, so growing their
 * seals into the walls the way cavity seals do would need its own guard
 * against the outer surface; until then they keep this pull-back and are
 * not fused with their walls. */
const SEAL_EROSION_MARGIN_VOXELS = 1;

/** How far (detection voxels) a CAVITY's seal reaches into the solid around
 * it. A seal that stops at the cavity's detected boundary leaves a gap of up
 * to about a voxel to the real wall, which a slicer prints as empty space —
 * the seal becomes a loose plug inside its pocket. Overlapping the walls
 * makes slicers merge seal and walls into one solid. */
const SEAL_OVERLAP_VOXELS = 2;

/** A seal only grows into solid voxels at least this far (detection voxels)
 * from space reachable from outside. That keeps the overlap off the outer
 * surface: checked against a 256³ reference of 3NL1 and 1L90, sealed points
 * end up no further outside the real surface than with no overlap at all
 * (only at slits — see buildSealPatchMesh). 3 gave the same outward reach
 * with weaker fusion. */
const MIN_EXTERIOR_DISTANCE_VOXELS = 2;

const OVERLAP_OFFSETS: number[][] = [];
for (let dz = -SEAL_OVERLAP_VOXELS; dz <= SEAL_OVERLAP_VOXELS; dz++)
  for (let dy = -SEAL_OVERLAP_VOXELS; dy <= SEAL_OVERLAP_VOXELS; dy++)
    for (let dx = -SEAL_OVERLAP_VOXELS; dx <= SEAL_OVERLAP_VOXELS; dx++)
      if ((dx || dy || dz) && Math.hypot(dx, dy, dz) <= SEAL_OVERLAP_VOXELS) OVERLAP_OFFSETS.push([dx, dy, dz]);

/**
 * Builds the sealing mesh for a void component, or null if nothing is left
 * to seal (a tunnel thinner than its margin, or a cavity no piece of which
 * reaches a wall).
 *
 * A cavity's own voxels are sealed in full, plus every solid voxel within
 * SEAL_OVERLAP_VOXELS of it that is at least MIN_EXTERIOR_DISTANCE_VOXELS
 * from space reachable from outside. The overlap fuses the seal with the
 * surrounding chain(s) in the slicer; the distance rule keeps the overlap off
 * the outer surface. Where a cavity sits right under a thin outer wall, the
 * overlap simply stops there.
 *
 * Of the result, only face-connected pieces holding both cavity and wall
 * voxels are kept. The distance rule can cut a wall voxel off from the rest
 * of the seal, and a cavity voxel can touch the rest of its cavity only at
 * an edge; either alone would export as a separate speck, loose in the
 * slicer.
 *
 * "Enclosed" is as seen at the detection resolution: a pocket joined to the
 * outside only by a slit narrower than about one voxel counts as a cavity,
 * and sealing it closes that slit too — up to 1.7 voxels deep across 20
 * random PDB assemblies, never on single-chain ones, and up to 1.84 once
 * snapSealsToWalls has pulled the seal onto the walls. In print units that is
 * a fixed share of the model's size (~2% at 64³), so it grows with print
 * size; a finer detection grid shrinks it.
 *
 * A tunnel keeps the fixed pull-back instead (see SEAL_EROSION_MARGIN_VOXELS).
 */
export function buildSealPatchMesh(grid: VoxelGrid, component: VoidComponent, ctx: SealContext): ComponentHighlightMesh | null {
  const { solidDist, exteriorDist } = ctx;

  if (component.kind === "tunnel") {
    const eroded = component.voxels.filter((v) => solidDist[v] > SEAL_EROSION_MARGIN_VOXELS);
    return eroded.length > 0 ? remeshVoxelSubset(grid, component.id, eroded) : null;
  }

  const { nx, ny, nz, solid } = grid;
  const seal = new Set(component.voxels);
  for (const v of component.voxels) {
    const z = Math.floor(v / (nx * ny));
    const y = Math.floor((v - z * nx * ny) / nx);
    const x = v - z * nx * ny - y * nx;
    for (const [dx, dy, dz] of OVERLAP_OFFSETS) {
      const xx = x + dx, yy = y + dy, zz = z + dz;
      if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz) continue;
      const n = voxelIndex(grid, xx, yy, zz);
      if (solid[n] && exteriorDist[n] >= MIN_EXTERIOR_DISTANCE_VOXELS) seal.add(n);
    }
  }
  const steps = [1, -1, nx, -nx, nx * ny, -nx * ny];
  const seen = new Set<number>();
  const kept: number[] = [];
  for (const start of seal) {
    if (seen.has(start)) continue;
    seen.add(start);
    const piece = [start];
    let hasCavity = false, hasWall = false;
    for (let i = 0; i < piece.length; i++) {
      const v = piece[i];
      if (solid[v]) hasWall = true; else hasCavity = true;
      for (const d of steps) {
        const n = v + d;
        if (seal.has(n) && !seen.has(n)) { seen.add(n); piece.push(n); }
      }
    }
    if (hasCavity && hasWall) kept.push(...piece);
  }
  return kept.length > 0 ? remeshVoxelSubset(grid, component.id, kept) : null;
}
