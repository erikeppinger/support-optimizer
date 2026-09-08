import * as THREE from "three";
import type { VoxelGrid } from "./voxelize";
import { PAD, voxelIndex } from "./voxelize";
import { floodFillExterior } from "./flood-fill";
import { marchingCubes } from "./marching-cubes";

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
 *   heads-up regardless. Never fillable — listed for visibility only.
 */
export function detectVoidComponents(grid: VoxelGrid): VoidComponent[] {
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
  return components;
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

/** Binary-erodes a voxel set by `margin` steps: a voxel survives a step
 * only if all 6 face-neighbors were also in the set going into that step.
 * Two voxels reached from each other by repeated 6-connected steps are
 * necessarily in the same flood-filled component (that's how the labeling
 * itself works), so any non-solid neighbor of a cavity voxel is
 * guaranteed to be another voxel of that SAME cavity — a neighbor outside
 * the set can only be solid (the shell) or, at the grid boundary, outside
 * the grid entirely (defensive-only; a true enclosed cavity never reaches
 * the grid edge). */
function erodeVoxelSet(grid: VoxelGrid, voxels: number[], margin: number): number[] {
  const { nx, ny, nz } = grid;
  const stepX = 1, stepY = nx, stepZ = nx * ny;
  let current = voxels;
  for (let step = 0; step < margin; step++) {
    const set = new Set(current);
    const next: number[] = [];
    for (const idx of current) {
      const z = Math.floor(idx / stepZ);
      const y = Math.floor((idx - z * stepZ) / stepY);
      const x = idx - z * stepZ - y * stepY;
      if (x <= 0 || x >= nx - 1 || y <= 0 || y >= ny - 1 || z <= 0 || z >= nz - 1) continue;
      if (
        set.has(idx - stepX) && set.has(idx + stepX) &&
        set.has(idx - stepY) && set.has(idx + stepY) &&
        set.has(idx - stepZ) && set.has(idx + stepZ)
      ) {
        next.push(idx);
      }
    }
    current = next;
    if (current.length === 0) break;
  }
  return current;
}

/** How many detection voxels of safety margin to erode off a cavity's
 * boundary before sealing it — see buildSealPatchMesh. */
const SEAL_EROSION_MARGIN_VOXELS = 1;

/**
 * Builds the actual sealing patch for a cavity — same construction as
 * buildCavityHighlightMesh, but on an ERODED voxel set (shrunk 1 detection
 * voxel in from the cavity's own boundary) rather than the full detected
 * extent, and returns null if erosion leaves nothing (the cavity is too
 * thin, relative to the detection resolution, to seal safely).
 *
 * The full-extent seal used before this existed traced the boundary
 * exactly where flood-fill first found empty space — but that boundary is
 * only as accurate as voxelizeSurface's own coarse classification of the
 * exterior shell, which is itself a triangle/box-overlap test at the SAME
 * detection resolution. Near a thin wall (thinner than roughly one
 * detection voxel), that classification can be wrong enough that the
 * cavity's coarse boundary sits at or past where the true (finer) exterior
 * surface actually is — sealing exactly there could then visibly protrude
 * through the printed surface. Eroding first gives up a thin (sub-voxel)
 * sliver of unsealed space at the cavity's true edge in exchange for a
 * patch that's guaranteed to stay inside the solid the coarse grid found —
 * a worthwhile trade, since an invisible, interior under-fill is harmless
 * where a visible surface protrusion isn't.
 */
export function buildSealPatchMesh(grid: VoxelGrid, component: VoidComponent): ComponentHighlightMesh | null {
  const eroded = erodeVoxelSet(grid, component.voxels, SEAL_EROSION_MARGIN_VOXELS);
  if (eroded.length === 0) return null;
  return remeshVoxelSubset(grid, component.id, eroded);
}
