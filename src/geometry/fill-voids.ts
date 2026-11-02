import { voxelizeSurface, fillInterior } from "./voxelize";
import { detectVoidComponentsFull, buildSealContext, buildSealPatchMesh } from "./detect-voids";
import type { ComponentHighlightMesh } from "./detect-voids";
import { planInnerShellFills, addInnerShellCavities, findInnerShells } from "./inner-shells";
import { fillEnclosedNearSeals } from "./closed-pockets";

export interface FillResult {
  patchPositions: Float32Array[];
  patchNormals: Float32Array[];
  filledVoxelCount: number;
  sealedCount: number;
  skippedCount: number;
  /** Per patch: the component it seals, or -1 for a pocket the seals had
   * closed off (see fillEnclosedNearSeals). */
  sealedIds: number[];
  sealedVertexCounts: number[];
  /** Per patch, x, y, z flattened. */
  sealedCentroids: number[];
  closedOffCount: number;
  /** Triangles of `position` to delete (inner skins of filled cavities). */
  removedTriangles: Int32Array;
}

/**
 * Fills the voids `selectedIds` names, detected on `position` at
 * `resolution` — the work behind the Fill buttons. Never touches the
 * exterior: cavities enclosed by one chain lose their inner skin (see
 * planInnerShellFills), every other selected void gets a small seal mesh
 * (see buildSealPatchMesh), and pockets those seals close off are filled
 * too (see fillEnclosedNearSeals). The caller removes `removedTriangles`
 * and appends the patches to the unchanged rest of the mesh.
 */
export function fillVoids(position: Float32Array, resolution: number, selectedIds: Set<number>, onProgress?: (fraction: number) => void): FillResult {
  const grid = voxelizeSurface(position, resolution);
  fillInterior(grid, position);

  onProgress?.(0.5);
  const detected = detectVoidComponentsFull(grid);
  const { reached } = detected;
  const innerShells = findInnerShells(position);
  const components = addInnerShellCavities(position, grid, detected.components, innerShells);
  const sealCtx = buildSealContext(grid, reached);

  const patchPositions: Float32Array[] = [];
  const patchNormals: Float32Array[] = [];
  let filledVoxelCount = 0;
  let sealedCount = 0;
  let skippedCount = 0;
  // Parallel to each other and to the order patches land in
  // patchPosition/patchNormal — lets the caller recover per-cavity vertex
  // ranges (e.g. to color each sealed patch by whichever chain it's
  // nearest to, rather than one flat color for the whole batch).
  const sealedIds: number[] = [];
  const sealedVertexCounts: number[] = [];
  const patches: ComponentHighlightMesh[] = [];

  // Cavities enclosed by one chain are filled by deleting their inner
  // surface instead of sealing them (see planInnerShellFills).
  const { removedTriangles, filledByRemoval: fullyEnclosed } = planInnerShellFills(position, grid, components, selectedIds, innerShells);

  for (const c of components) {
    if (!selectedIds.has(c.id)) continue;
    if (fullyEnclosed.has(c.id)) {
      filledVoxelCount += c.voxelCount;
      sealedCount++;
      continue;
    }
    const patch = buildSealPatchMesh(grid, c, sealCtx);
    if (!patch) {
      skippedCount++;
      continue;
    }
    patches.push(patch);
    filledVoxelCount += c.voxelCount;
    sealedCount++;
    sealedIds.push(c.id);
  }

  const removedMask = new Uint8Array(position.length / 9);
  for (const t of removedTriangles) removedMask[t] = 1;
  const sealedCentroids: number[] = [];
  for (const patch of patches) {
    patchPositions.push(patch.position);
    patchNormals.push(patch.normal);
    sealedVertexCounts.push(patch.position.length / 3);
    sealedCentroids.push(...components.find((c) => c.id === patch.id)!.centroid);
  }

  // A seal can close a narrow opening and enclose the space behind it — a
  // sliver too thin for the detection grid. Find and fill those too, on a
  // fine grid around each seal.
  onProgress?.(0.65);
  const sealCount = patchPositions.length;
  const model = new Float32Array(position.length - removedTriangles.length * 9 + patchPositions.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (let t = 0; t < position.length / 9; t++) {
    if (removedMask[t]) continue;
    model.set(position.subarray(t * 9, t * 9 + 9), at);
    at += 9;
  }
  for (const p of patchPositions) {
    model.set(p, at);
    at += p.length;
  }
  const unfilledIds = new Set(components.filter((c) => c.kind === "cavity" && !selectedIds.has(c.id)).map((c) => c.id));
  const closedOff = fillEnclosedNearSeals(model, patchPositions.slice(0, sealCount), grid.voxelSize, {
    position: position, grid, components, unfilledIds, shells: innerShells,
  });
  for (const pocket of closedOff) {
    patchPositions.push(pocket.position);
    patchNormals.push(pocket.normal);
    sealedVertexCounts.push(pocket.position.length / 3);
    sealedCentroids.push(...pocket.centroid);
    sealedIds.push(-1);
  }

  return {
    patchPositions, patchNormals, filledVoxelCount, sealedCount, skippedCount,
    sealedIds, sealedVertexCounts, sealedCentroids, closedOffCount: closedOff.length, removedTriangles,
  };
}
