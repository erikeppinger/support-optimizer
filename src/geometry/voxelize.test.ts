import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { voxelizeSurface, fillInterior, voxelIndex, PAD } from "./voxelize";

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

describe("fillInterior", () => {
  /** Non-indexed box of side `s` centered at `c`; inverted turns its faces
   * inward, as a cavity's wall is in a surface mesh. */
  function boxSoup(s: number, c: [number, number, number], inverted = false): Float32Array {
    const g = new THREE.BoxGeometry(s, s, s).toNonIndexed();
    g.translate(...c);
    const p = g.attributes.position.array as Float32Array;
    if (inverted) {
      for (let t = 0; t < p.length; t += 9) {
        for (let k = 0; k < 3; k++) [p[t + 3 + k], p[t + 6 + k]] = [p[t + 6 + k], p[t + 3 + k]];
      }
    }
    return p;
  }
  function concat(...parts: Float32Array[]) {
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function solidAt(grid: ReturnType<typeof voxelizeSurface>, x: number, y: number, z: number) {
    const ix = Math.floor((x - grid.origin.x) / grid.voxelSize);
    const iy = Math.floor((y - grid.origin.y) / grid.voxelSize);
    const iz = Math.floor((z - grid.origin.z) / grid.voxelSize);
    return grid.solid[voxelIndex(grid, ix, iy, iz)];
  }

  it("fills a closed box's interior and leaves the padding empty", () => {
    const position = boxSoup(10, [0, 0, 0]);
    const grid = voxelizeSurface(position, 20);
    fillInterior(grid, position);
    expect(solidAt(grid, 0.1, 0.2, 0.3)).toBe(1);
    expect(grid.solid[voxelIndex(grid, 0, 0, 0)]).toBe(0);
  });

  it("keeps a real cavity — an inward-facing wall inside the box — empty", () => {
    const position = concat(boxSoup(10, [0, 0, 0]), boxSoup(4, [0, 0, 0], true));
    const grid = voxelizeSurface(position, 40);
    fillInterior(grid, position);
    expect(solidAt(grid, 0.1, 0.2, 0.3)).toBe(0); // inside the cavity
    expect(solidAt(grid, 3.6, 0.2, 0.3)).toBe(1); // material between cavity and outside
  });

  it("treats two overlapping boxes as one solid, overlap included", () => {
    const position = concat(boxSoup(10, [0, 0, 0]), boxSoup(10, [6, 0, 0]));
    const grid = voxelizeSurface(position, 40);
    fillInterior(grid, position);
    expect(solidAt(grid, 3.1, 0.2, 0.3)).toBe(1); // inside both
    expect(solidAt(grid, 9.1, 0.2, 0.3)).toBe(1); // inside the second only
  });
});
