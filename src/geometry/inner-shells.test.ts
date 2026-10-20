import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { findInnerShells, insideShell, planInnerShellFills } from "./inner-shells";
import { voxelizeSurface, fillInterior } from "./voxelize";
import { detectVoidComponentsFull } from "./detect-voids";

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
function cavitiesOf(position: Float32Array) {
  const grid = voxelizeSurface(position, 40);
  fillInterior(grid, position);
  return { grid, cavities: detectVoidComponentsFull(grid).components.filter((c) => c.kind === "cavity") };
}

describe("findInnerShells", () => {
  it("finds only the inward-facing shell", () => {
    const position = concat(boxSoup(10, [0, 0, 0]), boxSoup(4, [0, 0, 0], true), boxSoup(2, [20, 0, 0]));
    const shells = findInnerShells(position);
    expect(shells).toHaveLength(1);
    expect(shells[0].triangles).toEqual(Array.from({ length: 12 }, (_, i) => 12 + i));
    expect(insideShell(position, shells[0], [0.3, 0.2, 0.1])).toBe(true);
    expect(insideShell(position, shells[0], [3.5, 0, 0])).toBe(false);
  });
});

describe("planInnerShellFills", () => {
  it("fills a selected cavity by removing its inner surface", () => {
    const position = concat(boxSoup(10, [0, 0, 0]), boxSoup(4, [0, 0, 0], true));
    const { grid, cavities } = cavitiesOf(position);
    expect(cavities).toHaveLength(1);
    const plan = planInnerShellFills(position, grid, cavities, new Set([cavities[0].id]));
    expect(plan.filledByRemoval.has(cavities[0].id)).toBe(true);
    expect(Array.from(plan.removedTriangles).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => 12 + i));
  });

  it("leaves an unselected cavity's surface alone", () => {
    const position = concat(boxSoup(10, [0, 0, 0]), boxSoup(4, [0, 0, 0], true));
    const { grid, cavities } = cavitiesOf(position);
    const plan = planInnerShellFills(position, grid, cavities, new Set());
    expect(plan.removedTriangles).toHaveLength(0);
  });

  it("doesn't remove anything for a pocket closed off between two parts", () => {
    // Two overlapping boxes leave no inner shell: the pocket between them is
    // bounded by their outer surfaces, so it still needs a voxel seal.
    const position = concat(
      boxSoup(10, [0, 0, 0]),
      boxSoup(10, [0, 0, 8]),
    );
    const { grid, cavities } = cavitiesOf(position);
    const plan = planInnerShellFills(position, grid, cavities, new Set(cavities.map((c) => c.id)));
    expect(plan.removedTriangles).toHaveLength(0);
    expect(plan.filledByRemoval.size).toBe(0);
  });
});
