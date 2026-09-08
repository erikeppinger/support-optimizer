import * as THREE from "three";
import { searchBestOrientation, evaluateOrientationCost } from "../geometry/orientation-search";
import { voxelizeSurface } from "../geometry/voxelize";
import { detectVoidComponents, summarize, buildCavityHighlightMesh, buildSealPatchMesh } from "../geometry/detect-voids";
import type { VoidComponentSummary, ComponentHighlightMesh } from "../geometry/detect-voids";
import { marchingCubes } from "../geometry/marching-cubes";
import { buildChainMeshes, DEFAULT_PROBE_RADIUS, parsePDBAtoms } from "../geometry/pdb";
import type { Atom, ChainMeshEntry } from "../geometry/pdb";
import { parseCIFAtoms } from "../geometry/mmcif";
import { generateSupportPaths } from "../geometry/support-paths";

export interface OrientationSearchRequest {
  type: "search-orientation";
  position: Float32Array;
  normal: Float32Array;
  criticalAngleDeg: number;
  /**
   * If set, the search runs against a coarse voxelize+remesh proxy of
   * `position` instead of the mesh itself, at this many voxels along its
   * longest axis. Orientation search is O(triangles²) per candidate —
   * infeasible on a dense scan/import mesh — but the result is just a
   * rotation, which is exact and lossless to apply to the original at
   * full resolution afterward, so a coarse proxy only risks missing a
   * fine surface feature, not the mesh's dominant overhang shape.
   */
  proxyResolution?: number;
}

export interface DetectVoidsRequest {
  type: "detect-voids";
  position: Float32Array;
  resolution: number;
}

export interface CloseCavitiesRequest {
  type: "close-cavities";
  position: Float32Array;
  resolution: number;
  /** ids from a prior "voids-detected" response, at the same resolution
   * (detection is deterministic, so it's cheap to redo rather than
   * transfer the whole grid back and forth). May be cavity ids, tunnel
   * ids, or (in principle) a mix — the handler doesn't filter by kind,
   * only by id membership; main.ts's two Fill buttons each send one kind. */
  selectedCavityIds: number[];
}

export interface VoxelizePDBRequest {
  type: "voxelize-pdb";
  /** Either already-parsed atoms directly (used when rebuilding from a
   * chain subset of a structure already loaded — see main.ts's chain
   * filter — so re-parsing is never needed) OR raw source text + its
   * format, parsed inside the worker so a large file's parse cost —
   * CIF's tokenization especially, far heavier per line than PDB's fixed-
   * column slicing — never blocks the main thread with no progress
   * feedback the way it used to. Exactly one of the two is set. */
  atoms?: Atom[];
  text?: string;
  format?: "cif" | "pdb";
  /** "auto" scales the grid down as atom count grows — computed here
   * (not by the caller) specifically so the text-parsing path can resolve
   * it right after parsing, when the atom count first becomes known,
   * without a second request/response round trip. */
  resolution: number | "auto";
  /** Solvent probe radius (Angstroms) for the Solvent Excluded Surface —
   * defaults to the standard 1.4 (water) if omitted. */
  probeRadius?: number;
}

/** Same tradeoff the orientation-search proxy makes, just sized against
 * atom count instead of triangle count — keeps voxelize+marching-cubes
 * tractable on a very large structure without the caller having to
 * already know the atom count before asking for a surface. */
function resolveAutoResolution(resolution: number | "auto", atomCount: number): number {
  if (resolution !== "auto") return resolution;
  return atomCount > 30000 ? 70 : atomCount > 10000 ? 90 : atomCount > 3000 ? 110 : 130;
}

export interface GenerateSupportPathsRequest {
  type: "generate-support-paths";
  /** Echoed back on the response so a caller juggling more than one
   * request against the same long-lived worker (this one isn't
   * busy/cancel-gated like the others — see main.ts) can tell which
   * request a given response belongs to, and safely drop a stale one. */
  requestId: number;
  position: Float32Array;
  normal: Float32Array;
  criticalAngleDeg: number;
}

export type WorkerRequest =
  | OrientationSearchRequest
  | DetectVoidsRequest
  | CloseCavitiesRequest
  | VoxelizePDBRequest
  | GenerateSupportPathsRequest;

export type WorkerResponse =
  | { type: "progress"; fraction: number }
  | {
      type: "orientation-result";
      up: [number, number, number];
      beforeCost: number;
      afterCost: number;
      usedProxy: boolean;
      proxyTriangleCount?: number;
    }
  | { type: "voids-detected"; components: VoidComponentSummary[]; voxelSize: number; highlights: ComponentHighlightMesh[] }
  | {
      type: "cavity-result";
      patchPosition: Float32Array;
      patchNormal: Float32Array;
      filledVoxelCount: number;
      sealedCount: number;
      /** Selected cavities eroded down to nothing (too thin, relative to
       * the detection resolution, to seal safely — see
       * buildSealPatchMesh) and were skipped rather than risk a patch
       * that protrudes through the exterior surface. */
      skippedCount: number;
      /** Parallel arrays (same length as sealedCount): the id and vertex
       * count of each sealed component, in the order its vertices appear
       * in patchPosition/patchNormal. Lets the caller color each patch
       * individually (e.g. by nearest chain) instead of uniformly. */
      sealedIds: number[];
      sealedVertexCounts: number[];
    }
  | {
      type: "support-paths-result";
      requestId: number;
      /** Flattened [ax,ay,az,bx,by,bz] per path segment — plain Vector3
       * objects would lose their prototype (and so their .distanceTo etc.)
       * through structured clone, so the caller reconstructs real
       * THREE.Vector3s from these on the other side instead. */
      segments: Float32Array;
      rootCount: number;
      totalLength: number;
      error?: string;
    }
  | {
      type: "pdb-mesh-result";
      position: Float32Array;
      normal: Float32Array;
      color: Float32Array;
      chains: ChainMeshEntry[];
      atomCount: number;
    }
  | {
      /** Sent once, right after a text-based "voxelize-pdb" request
       * finishes parsing and before voxelize/remesh work begins — lets
       * the caller populate the chain-subset dropdown and keep the atom
       * records for a later chain rebuild, without waiting for (or
       * duplicating) the full mesh-building pass that follows. Never sent
       * for an atoms-based request, since the caller already has the
       * atoms in that case. */
      type: "atoms-parsed";
      atoms: Atom[];
      /** The resolved grid resolution mesh-building will actually use —
       * echoed back so the caller can show it in a status message even
       * when the request's own `resolution` was "auto". */
      resolution: number;
    }
  | { type: "parse-error"; message: string };

// `self` inside a worker has the same postMessage/onmessage shape as the
// DOM `Worker` handle used to talk to it, so this cast types it correctly
// without pulling in the "webworker" lib (which conflicts with "DOM" when
// both are in one tsconfig).
const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;

  if (msg.type === "search-orientation") {
    let searchPosition = msg.position;
    let searchNormal = msg.normal;
    let usedProxy = false;
    let proxyTriangleCount: number | undefined;

    if (msg.proxyResolution) {
      ctx.postMessage({ type: "progress", fraction: 0.05 } satisfies WorkerResponse);
      const grid = voxelizeSurface(msg.position, msg.proxyResolution);
      ctx.postMessage({ type: "progress", fraction: 0.15 } satisfies WorkerResponse);
      const proxyGeometry = marchingCubes(grid);
      searchPosition = proxyGeometry.attributes.position.array as Float32Array;
      searchNormal = proxyGeometry.attributes.normal.array as Float32Array;
      usedProxy = true;
      proxyTriangleCount = searchPosition.length / 9;
    }

    const progressOffset = usedProxy ? 0.2 : 0;
    const progressScale = usedProxy ? 0.8 : 1;

    const beforeCost = evaluateOrientationCost(
      searchPosition,
      searchNormal,
      new THREE.Vector3(0, 0, 1),
      msg.criticalAngleDeg,
    ).cost;

    const result = searchBestOrientation(searchPosition, searchNormal, {
      criticalAngleDeg: msg.criticalAngleDeg,
      onProgress: (fraction) => {
        ctx.postMessage({ type: "progress", fraction: progressOffset + fraction * progressScale } satisfies WorkerResponse);
      },
    });

    ctx.postMessage({
      type: "orientation-result",
      up: [result.up.x, result.up.y, result.up.z],
      beforeCost,
      afterCost: result.cost,
      usedProxy,
      proxyTriangleCount,
    } satisfies WorkerResponse);
    return;
  }

  if (msg.type === "detect-voids") {
    ctx.postMessage({ type: "progress", fraction: 0.3 } satisfies WorkerResponse);
    const grid = voxelizeSurface(msg.position, msg.resolution);

    ctx.postMessage({ type: "progress", fraction: 0.6 } satisfies WorkerResponse);
    const components = detectVoidComponents(grid);

    // Highlight meshes for both cavities and tunnels now (both fillable —
    // see buildSealPatchMesh), capped at the largest 20 of EACH kind —
    // matches the UI's own "show top 20 per list" cap, and keeps this
    // bounded regardless of how many tiny voids a complex structure turns
    // up. `components` is sorted descending by voxelCount across BOTH
    // kinds combined, so the two caps are tracked independently rather
    // than just taking the first 20 overall (which could starve tunnels
    // entirely on a structure with 20+ larger cavities).
    const MAX_HIGHLIGHTS_PER_KIND = 20;
    const highlights: ComponentHighlightMesh[] = [];
    const transferBuffers: Transferable[] = [];
    let cavityHighlightCount = 0;
    let tunnelHighlightCount = 0;
    for (const c of components) {
      if (c.kind === "cavity" && cavityHighlightCount >= MAX_HIGHLIGHTS_PER_KIND) continue;
      if (c.kind === "tunnel" && tunnelHighlightCount >= MAX_HIGHLIGHTS_PER_KIND) continue;
      const mesh = buildCavityHighlightMesh(grid, c);
      highlights.push(mesh);
      transferBuffers.push(mesh.position.buffer, mesh.normal.buffer);
      if (c.kind === "cavity") cavityHighlightCount++;
      else tunnelHighlightCount++;
      if (cavityHighlightCount >= MAX_HIGHLIGHTS_PER_KIND && tunnelHighlightCount >= MAX_HIGHLIGHTS_PER_KIND) break;
    }

    ctx.postMessage(
      {
        type: "voids-detected",
        components: summarize(components),
        voxelSize: grid.voxelSize,
        highlights,
      } satisfies WorkerResponse,
      transferBuffers,
    );
    return;
  }

  if (msg.type === "generate-support-paths") {
    try {
      const result = generateSupportPaths(msg.position, msg.normal, new THREE.Vector3(0, 0, 1), msg.criticalAngleDeg);
      const segments = new Float32Array(result.paths.length * 6);
      for (let i = 0; i < result.paths.length; i++) {
        const [a, b] = result.paths[i].points;
        const o = i * 6;
        segments[o] = a.x; segments[o + 1] = a.y; segments[o + 2] = a.z;
        segments[o + 3] = b.x; segments[o + 4] = b.y; segments[o + 5] = b.z;
      }
      ctx.postMessage(
        {
          type: "support-paths-result",
          requestId: msg.requestId,
          segments,
          rootCount: result.rootCount,
          totalLength: result.totalLength,
        } satisfies WorkerResponse,
        [segments.buffer],
      );
    } catch (err) {
      ctx.postMessage({
        type: "support-paths-result",
        requestId: msg.requestId,
        segments: new Float32Array(0),
        rootCount: 0,
        totalLength: 0,
        error: err instanceof Error ? err.message : "unknown error",
      } satisfies WorkerResponse);
    }
    return;
  }

  if (msg.type === "voxelize-pdb") {
    let atoms: Atom[];
    let resolution: number;
    if (msg.atoms) {
      atoms = msg.atoms;
      resolution = resolveAutoResolution(msg.resolution, atoms.length);
    } else {
      if (msg.text === undefined || !msg.format) {
        ctx.postMessage({ type: "parse-error", message: "voxelize-pdb request had neither atoms nor text" } satisfies WorkerResponse);
        return;
      }
      // Parsing gets its own slice of the progress bar (0-15%) — for a
      // large CIF file especially, tokenization itself can take real time,
      // and previously ran synchronously on the MAIN thread with no
      // feedback at all while it did.
      const parseProgress = (fraction: number) => {
        ctx.postMessage({ type: "progress", fraction: fraction * 0.15 } satisfies WorkerResponse);
      };
      try {
        atoms = msg.format === "cif" ? parseCIFAtoms(msg.text, parseProgress) : parsePDBAtoms(msg.text, parseProgress);
      } catch (err) {
        ctx.postMessage({ type: "parse-error", message: err instanceof Error ? err.message : "unknown parse error" } satisfies WorkerResponse);
        return;
      }
      if (atoms.length === 0) {
        ctx.postMessage({ type: "parse-error", message: "no readable atom records" } satisfies WorkerResponse);
        return;
      }
      resolution = resolveAutoResolution(msg.resolution, atoms.length);
      ctx.postMessage({ type: "atoms-parsed", atoms, resolution } satisfies WorkerResponse);
    }

    const probeRadius = msg.probeRadius ?? DEFAULT_PROBE_RADIUS;
    const meshProgressOffset = msg.atoms ? 0 : 0.15;
    const meshProgressScale = msg.atoms ? 1 : 0.85;
    const { position, normal, color, chains } = buildChainMeshes(atoms, resolution, probeRadius, (fraction) => {
      ctx.postMessage({ type: "progress", fraction: meshProgressOffset + fraction * meshProgressScale } satisfies WorkerResponse);
    });

    ctx.postMessage(
      { type: "pdb-mesh-result", position, normal, color, chains, atomCount: atoms.length } satisfies WorkerResponse,
      [position.buffer, normal.buffer, color.buffer],
    );
    return;
  }

  // close-cavities — deliberately does NOT touch the exterior surface at
  // all, regardless of whether the selected components are cavities or
  // tunnels (the caller — main.ts's two Fill buttons — only ever sends ids
  // of one kind at a time, but this handler itself doesn't need to care).
  // Earlier this re-voxelized+remeshed the WHOLE model via marching cubes,
  // which replaced the (often carefully computed, e.g. per-chain SES)
  // exterior with a single blocky remesh even though only interior voids
  // needed anything done to them. Instead, this builds a small "sealing"
  // mesh per selected component (its own enclosing boundary, eroded 1
  // voxel in — see buildSealPatchMesh) and returns just those patch
  // triangles; the caller concatenates them onto the UNCHANGED original
  // exterior geometry. The erosion margin is what makes this safe for a
  // tunnel too, not just a cavity: a voxel right at a tunnel's opening to
  // the outside always has a neighbor outside the tunnel's own voxel set,
  // so it erodes away exactly like a cavity voxel next to the shell would.
  ctx.postMessage({ type: "progress", fraction: 0.2 } satisfies WorkerResponse);
  const grid = voxelizeSurface(msg.position, msg.resolution);

  ctx.postMessage({ type: "progress", fraction: 0.5 } satisfies WorkerResponse);
  const components = detectVoidComponents(grid);
  const selectedIds = new Set(msg.selectedCavityIds);

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
  for (const c of components) {
    if (!selectedIds.has(c.id)) continue;
    const patch = buildSealPatchMesh(grid, c);
    if (!patch) {
      skippedCount++;
      continue;
    }
    patchPositions.push(patch.position);
    patchNormals.push(patch.normal);
    filledVoxelCount += c.voxelCount;
    sealedCount++;
    sealedIds.push(c.id);
    sealedVertexCounts.push(patch.position.length / 3);
  }

  ctx.postMessage({ type: "progress", fraction: 0.8 } satisfies WorkerResponse);
  const totalFloats = patchPositions.reduce((sum, p) => sum + p.length, 0);
  const patchPosition = new Float32Array(totalFloats);
  const patchNormal = new Float32Array(totalFloats);
  let offset = 0;
  for (let i = 0; i < patchPositions.length; i++) {
    patchPosition.set(patchPositions[i], offset);
    patchNormal.set(patchNormals[i], offset);
    offset += patchPositions[i].length;
  }

  ctx.postMessage(
    { type: "cavity-result", patchPosition, patchNormal, filledVoxelCount, sealedCount, skippedCount, sealedIds, sealedVertexCounts } satisfies WorkerResponse,
    [patchPosition.buffer, patchNormal.buffer],
  );
};
