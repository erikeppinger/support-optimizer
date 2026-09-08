import { describe, it, expect } from "vitest";
import * as THREE from "three";
import type { VoxelGrid } from "./voxelize";
import { voxelIndex } from "./voxelize";
import { floodFillExterior } from "./flood-fill";

/** A 7x7x7 grid: a hollow 5x5x5 shell (walls solid, indices 1..5) sitting
 * in a 1-voxel empty border, with a sealed 3x3x3 cavity (indices 2..4)
 * inside it. */
function buildHollowShellGrid(): VoxelGrid {
  const nx = 7, ny = 7, nz = 7;
  const solid = new Uint8Array(nx * ny * nz);
  const grid: VoxelGrid = { nx, ny, nz, voxelSize: 1, origin: new THREE.Vector3(0, 0, 0), solid };
  for (let z = 1; z <= 5; z++) {
    for (let y = 1; y <= 5; y++) {
      for (let x = 1; x <= 5; x++) {
        const onShell = x === 1 || x === 5 || y === 1 || y === 5 || z === 1 || z === 5;
        if (onShell) solid[voxelIndex(grid, x, y, z)] = 1;
      }
    }
  }
  return grid;
}

describe("floodFillExterior", () => {
  it("reaches empty voxels outside the shell from the padded corner", () => {
    const grid = buildHollowShellGrid();
    const reached = floodFillExterior(grid);
    expect(reached[voxelIndex(grid, 0, 0, 0)]).toBe(1);
    expect(reached[voxelIndex(grid, 6, 6, 6)]).toBe(1);
    expect(reached[voxelIndex(grid, 3, 3, 0)]).toBe(1);
  });

  it("never reaches the sealed interior cavity", () => {
    const grid = buildHollowShellGrid();
    const reached = floodFillExterior(grid);
    for (let z = 2; z <= 4; z++) {
      for (let y = 2; y <= 4; y++) {
        for (let x = 2; x <= 4; x++) {
          expect(reached[voxelIndex(grid, x, y, z)]).toBe(0);
        }
      }
    }
  });

  it("never marks solid (shell) voxels as reached", () => {
    const grid = buildHollowShellGrid();
    const reached = floodFillExterior(grid);
    for (let i = 0; i < grid.solid.length; i++) {
      if (grid.solid[i]) expect(reached[i]).toBe(0);
    }
  });
});
