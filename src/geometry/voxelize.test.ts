import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { voxelizeSurface, voxelIndex, PAD } from "./voxelize";

describe("voxelizeSurface", () => {
  const box = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
  const position = box.attributes.position.array as Float32Array;

  it("sizes voxels from the target resolution along the longest axis", () => {
    const grid = voxelizeSurface(position, 20);
    expect(grid.voxelSize).toBeCloseTo(10 / 20, 6);
    // Grid extent = geometry extent / voxelSize, plus padding on both sides.
    expect(grid.nx).toBe(20 + PAD * 2);
  });

  it("marks only the surface shell solid, leaving padding and interior empty", () => {
    const grid = voxelizeSurface(position, 20);

    // The padded corner is guaranteed empty — flood fill's start point.
    expect(grid.solid[voxelIndex(grid, 0, 0, 0)]).toBe(0);

    // The cube's center is hollow interior air, not surface.
    const cx = Math.floor(grid.nx / 2), cy = Math.floor(grid.ny / 2), cz = Math.floor(grid.nz / 2);
    expect(grid.solid[voxelIndex(grid, cx, cy, cz)]).toBe(0);

    // Somewhere in the grid, the surface itself must be marked.
    let solidCount = 0;
    for (let i = 0; i < grid.solid.length; i++) solidCount += grid.solid[i];
    expect(solidCount).toBeGreaterThan(0);
  });

  it("scales the grid up for a finer target resolution", () => {
    const coarse = voxelizeSurface(position, 10);
    const fine = voxelizeSurface(position, 40);
    expect(fine.nx).toBeGreaterThan(coarse.nx);
    expect(fine.voxelSize).toBeLessThan(coarse.voxelSize);
  });
});
