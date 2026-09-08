import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { VoxelGrid } from "./voxelize";
import { detectVoidComponents, summarize } from "./detect-voids";

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
