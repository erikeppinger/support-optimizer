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
  /** Per-voxel Euclidean distance (in detection-voxel units) to the
   * nearest SOLID voxel — a real-valued generalization of "how many
   * voxels of erosion margin can this voxel still afford," rather than
   * the old binary 6-connected-neighbors-present test, which required a
   * whole extra voxel of clearance in EVERY one of the 3 axes simultaneously
   * to survive even one step (so it erased any cavity narrower than 3
   * voxels across in any single axis, everywhere along its length — most
   * of a real structure's interior pockets, in practice). A distance
   * transform lets the margin be fractional and isotropic instead. */
  solidDist: Float32Array;
  /** Per-voxel distance to the nearest voxel floodFillExterior actually
   * reached from outside — i.e. how many voxels of solid material stand
   * between this point and confirmed open air, through the SHORTEST
   * path. Used to tell a cavity that's nowhere near the true exterior
   * (no plausible protrusion risk, however this is sealed) apart from
   * one separated from it by only a thin wall (where the margin below
   * still matters). */
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

/** How many detection voxels of safety margin to erode off a TUNNEL's
 * boundary before sealing it — kept as the original fixed, conservative
 * margin (never falls back toward 0 the way a cavity's ladder can, see
 * buildSealPatchMesh) since a tunnel always has a real opening nearby
 * that a zero-margin seal could wrongly cap shut. */
const SEAL_EROSION_MARGIN_VOXELS = 1;

/** A cavity that never comes within this many detection voxels of the
 * true exterior (through solid material, by the shortest path) is far
 * enough from it that voxelizeSurface's own coarse solid/empty
 * classification — accurate to roughly ±1 voxel at a thin exterior wall,
 * see buildSealPatchMesh below — cannot plausibly be wrong by enough to
 * make a full-extent (zero-margin) seal poke through a real surface.
 * Comfortably above 1 for margin against that ±1 uncertainty itself. */
const SAFE_EXTERIOR_DISTANCE_VOXELS = 2;

/** Erosion margins tried for a cavity NOT confirmed far from the
 * exterior (or for a tunnel — see buildSealPatchMesh), largest/safest
 * first: the first margin that leaves a non-empty voxel set wins. 1
 * matches this project's original fixed margin; the smaller fallbacks
 * are new — sealing a bit closer to a thin cavity's true boundary is a
 * worthwhile trade against leaving it completely unfilled, which is
 * exactly the failure this whole adaptive scheme replaces. 0 (no
 * erosion at all) is deliberately the last resort here, not the
 * default, since — unlike the "confirmed far from exterior" case above —
 * this path is only reached when the cavity/tunnel might actually be
 * close to real open air. */
const RISKY_EROSION_MARGINS = [1, 0.75, 0.5, 0.25, 0];

/**
 * Builds the actual sealing patch for a void component — same
 * construction as buildCavityHighlightMesh, but on a voxel set eroded
 * inward from the component's own detected boundary (see SealContext),
 * and returns null only if every fallback margin leaves nothing (the
 * void is too thin, relative to the detection resolution, to seal at
 * all safely).
 *
 * The full-extent seal used before erosion existed at all traced the
 * boundary exactly where flood-fill first found empty space — but that
 * boundary is only as accurate as voxelizeSurface's own coarse
 * classification of the exterior shell, which is itself a triangle/box-
 * overlap test at the SAME detection resolution. Near a thin wall
 * (thinner than roughly one detection voxel), that classification can be
 * wrong enough that the cavity's coarse boundary sits at or past where
 * the true (finer) exterior surface actually is — sealing exactly there
 * could then visibly protrude through the printed surface. Eroding first
 * gives up a thin (sub-voxel) sliver of unsealed space at the cavity's
 * true edge in exchange for a patch that's guaranteed to stay inside the
 * solid the coarse grid found.
 *
 * That risk is specifically about proximity to the true exterior, though
 * — a cavity buried deep inside a structure, nowhere near open air, can't
 * poke through a surface that isn't anywhere nearby regardless of how it's
 * sealed. A cavity confirmed at least SAFE_EXTERIOR_DISTANCE_VOXELS from
 * the exterior skips straight to a full-extent (zero-margin) seal, since
 * none of the above justifies giving up on it; a cavity that might
 * actually be close to open air still gets the cautious margin ladder
 * instead, bottoming out at (but never skipping past) 0 only as a last
 * resort.
 *
 * A tunnel is deliberately kept OUT of that ladder's zero-margin fallback
 * entirely, unlike a cavity: by definition a tunnel always has at least
 * one point at or near a real opening to the outside (that's what makes
 * it a tunnel and not a cavity), so a zero-margin seal there risks
 * capping that opening shut — not a surface protrusion, but arguably
 * worse (a channel that was supposed to stay open, doesn't). A skipped
 * tunnel seal (todays' "too thin" outcome, unchanged here) is a far
 * safer failure than silently plugging one.
 */
export function buildSealPatchMesh(grid: VoxelGrid, component: VoidComponent, ctx: SealContext): ComponentHighlightMesh | null {
  const { solidDist, exteriorDist } = ctx;

  if (component.kind === "tunnel") {
    const eroded = component.voxels.filter((v) => solidDist[v] > SEAL_EROSION_MARGIN_VOXELS);
    return eroded.length > 0 ? remeshVoxelSubset(grid, component.id, eroded) : null;
  }

  let minExteriorDist = Infinity;
  for (const v of component.voxels) {
    if (exteriorDist[v] < minExteriorDist) minExteriorDist = exteriorDist[v];
    if (minExteriorDist < SAFE_EXTERIOR_DISTANCE_VOXELS) break;
  }
  const isFarFromExterior = minExteriorDist >= SAFE_EXTERIOR_DISTANCE_VOXELS;

  const margins = isFarFromExterior ? [0] : RISKY_EROSION_MARGINS;
  for (const margin of margins) {
    const eroded = component.voxels.filter((v) => solidDist[v] > margin);
    if (eroded.length > 0) return remeshVoxelSubset(grid, component.id, eroded);
  }
  return null;
}
