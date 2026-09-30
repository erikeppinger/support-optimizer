import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { VoxelGrid } from "./voxelize";
import { detectVoidComponents, detectVoidComponentsFull, summarize, buildSealContext, buildSealPatchMesh } from "./detect-voids";

function makeGrid(n: number): VoxelGrid {
  return {
    nx: n,
    ny: n,
    nz: n,
    voxelSize: 1,
    origin: new THREE.Vector3(0, 0, 0),
    solid: new Uint8Array(n * n * n),
  };
}

function setBox(grid: VoxelGrid, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, value: 0 | 1) {
  const { nx, ny } = grid;
  for (let z = z0; z <= z1; z++) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        grid.solid[(z * ny + y) * nx + x] = value;
      }
    }
  }
}

describe("detectVoidComponents", () => {
  it("finds a small sealed cavity as a tiny fraction of the model", () => {
    const grid = makeGrid(20);
    // A solid block (the "model") from 3..16 in every axis...
    setBox(grid, 3, 16, 3, 16, 3, 16, 1);
    // ...with a small enclosed pocket carved out of its middle.
    setBox(grid, 9, 10, 9, 10, 9, 10, 0);

    const components = detectVoidComponents(grid);
    const cavities = components.filter((c) => c.kind === "cavity");
    expect(cavities).toHaveLength(1);
    expect(cavities[0].voxelCount).toBe(8);
    expect(cavities[0].volumeFraction).toBeCloseTo(8 / (20 * 20 * 20), 6);
    expect(cavities[0].volumeFraction).toBeLessThan(0.01);

    const summary = summarize(components);
    expect(summary[0]).toHaveProperty("volumeFraction");
  });

  it("flags a wide gap between separated solid blocks as an oversized tunnel", () => {
    const grid = makeGrid(20);
    // Two solid blocks with a real gap between them — the open space swept
    // in around/between them should read as a large fraction of the grid,
    // not a narrow, safely-fillable channel.
    setBox(grid, 3, 7, 3, 16, 3, 16, 1);
    setBox(grid, 12, 16, 3, 16, 3, 16, 1);

    const components = detectVoidComponents(grid);
    const tunnels = components.filter((c) => c.kind === "tunnel");
    expect(tunnels.length).toBeGreaterThan(0);
    const biggest = tunnels[0];
    expect(biggest.volumeFraction).toBeGreaterThan(0.2);
  });
});

describe("buildSealPatchMesh", () => {
  /** A single detection voxel thick in Z everywhere along its extent —
   * exactly the shape the OLD fixed 6-connected 1-voxel erosion could
   * never seal (no voxel there ever has both z-neighbors also in the
   * cavity), regardless of how deep inside the model it sits. */
  function buildBlockWithThinSlabCavity(blockSize: number, slabZ: number) {
    const grid = makeGrid(blockSize + 6);
    const lo = 3, hi = blockSize + 2;
    setBox(grid, lo, hi, lo, hi, lo, hi, 1);
    setBox(grid, lo + 2, hi - 2, lo + 2, hi - 2, slabZ, slabZ, 0);
    return grid;
  }

  it("seals a thin (1-voxel-thick) cavity buried deep inside the model, which the old fixed erosion could never seal", () => {
    // A 30-voxel block with the thin slab at its exact vertical center —
    // many voxels of solid material separate it from the exterior on
    // every side, so it should be classified "far from exterior" and
    // sealed at full extent (margin 0) immediately.
    const grid = buildBlockWithThinSlabCavity(30, 18);
    const { components, reached } = detectVoidComponentsFull(grid);
    const cavity = components.find((c) => c.kind === "cavity");
    expect(cavity).toBeDefined();

    const ctx = buildSealContext(grid, reached);
    const patch = buildSealPatchMesh(grid, cavity!, ctx);
    expect(patch).not.toBeNull();
    expect(patch!.position.length).toBeGreaterThan(0);
  });

  it("still seals a thin cavity close to the exterior, via the fractional-margin fallback ladder", () => {
    // Same thin slab shape, but only 2 voxels of solid wall away from
    // open air on one side — "risky" by proximity, not "far from
    // exterior", so this exercises the margin ladder instead of the
    // immediate zero-margin shortcut, and should still succeed.
    const grid = buildBlockWithThinSlabCavity(10, 5);
    const { components, reached } = detectVoidComponentsFull(grid);
    const cavity = components.find((c) => c.kind === "cavity");
    expect(cavity).toBeDefined();

    const ctx = buildSealContext(grid, reached);
    const patch = buildSealPatchMesh(grid, cavity!, ctx);
    expect(patch).not.toBeNull();
  });

  it("never seals a thin tunnel shut — stays skipped (null) rather than capping a real opening", () => {
    // The tunnel-detection heuristic itself (isInterior + flood-fill) has
    // its own separate test coverage above and its own known quirk on a
    // small synthetic grid (the space AROUND a lone block reads as one
    // huge "tunnel" — exactly what the oversized-tunnel test above is
    // about) — irrelevant noise for what this test actually checks: given
    // a tunnel-kind component that genuinely is just a thin 1-voxel-wide
    // channel, does buildSealPatchMesh correctly refuse to seal it shut?
    // Building that component directly, rather than through detection,
    // isolates exactly that question.
    const grid = makeGrid(20);
    setBox(grid, 3, 16, 3, 16, 3, 16, 1);
    setBox(grid, 9, 9, 9, 9, 10, 16, 0); // 1-voxel-wide drilled channel, open at z=16

    const { nx, ny } = grid;
    const voxels: number[] = [];
    for (let z = 10; z <= 16; z++) voxels.push((z * ny + 9) * nx + 9);
    const channelTunnel = { id: 0, kind: "tunnel" as const, voxelCount: voxels.length, centroid: [9, 9, 13] as [number, number, number], volumeFraction: voxels.length / (nx * ny * grid.nz), voxels };

    const { reached } = detectVoidComponentsFull(grid);
    const ctx = buildSealContext(grid, reached);
    const patch = buildSealPatchMesh(grid, channelTunnel, ctx);
    expect(patch).toBeNull();
  });
});
