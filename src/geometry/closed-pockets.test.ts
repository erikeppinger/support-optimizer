import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { fillEnclosedNearSeals } from "./closed-pockets";
import { voxelizeSurface, fillInterior } from "./voxelize";
import { detectVoidComponentsFull } from "./detect-voids";
import { findInnerShells } from "./inner-shells";

/** Non-indexed box of side `s` centered at the origin; inverted turns its
 * faces inward, as a cavity's wall is in a surface mesh. */
function box(s: number, inverted = false): Float32Array {
  const p = new THREE.BoxGeometry(s, s, s).toNonIndexed().attributes.position.array as Float32Array;
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
/** Whether p is inside a closed triangle soup (nonzero winding along +x). */
function inside(position: Float32Array, p: number[]): boolean {
  let w = 0;
  for (let o = 0; o < position.length; o += 9) {
    const ay = position[o + 1], az = position[o + 2], by = position[o + 4], bz = position[o + 5], cy = position[o + 7], cz = position[o + 8];
    const d = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    if (d === 0) continue;
    const u = ((p[1] - ay) * (cz - az) - (p[2] - az) * (cy - ay)) / d;
    const v = ((by - ay) * (p[2] - az) - (bz - az) * (p[1] - ay)) / d;
    if (u < 0 || v < 0 || u + v > 1) continue;
    if (position[o] + u * (position[o + 3] - position[o]) + v * (position[o + 6] - position[o]) > p[0]) w += d > 0 ? 1 : -1;
  }
  return w !== 0;
}

describe("fillEnclosedNearSeals", () => {
  // A 10 mm block with a 4 mm pocket, and a 3 mm "seal" in the pocket that
  // falls 0.5 mm short of its walls on every side.
  const original = concat(box(10), box(4, true));
  const seal = box(3);
  const model = concat(original, seal);
  const grid = voxelizeSurface(original, 20);
  fillInterior(grid, original);
  const components = detectVoidComponentsFull(grid).components;
  const pocket = components.find((c) => c.kind === "cavity")!;
  const shells = findInnerShells(original);
  const gapPoint = [1.75 + 0.01, 0.013, 0.017];

  it("fills the gap a seal leaves in its pocket", () => {
    expect(inside(model, gapPoint)).toBe(false);
    const fills = fillEnclosedNearSeals(model, [seal], grid.voxelSize, { position: original, grid, components, unfilledIds: new Set(), shells });
    expect(fills.length).toBeGreaterThan(0);
    const filled = concat(model, ...fills.map((f) => f.position));
    expect(inside(filled, gapPoint)).toBe(true);
    // Nothing pokes out of the block.
    let reach = 0;
    for (const f of fills) for (let i = 0; i < f.position.length; i++) reach = Math.max(reach, Math.abs(f.position[i]));
    expect(reach).toBeLessThan(5);
  });

  it("fills a gap only once when two seals' search boxes both reach it", () => {
    const once = fillEnclosedNearSeals(model, [seal], grid.voxelSize, { position: original, grid, components, unfilledIds: new Set(), shells });
    const twice = fillEnclosedNearSeals(model, [seal, seal], grid.voxelSize, { position: original, grid, components, unfilledIds: new Set(), shells });
    expect(twice).toHaveLength(once.length);
  });

  // A 0.1 mm slit (about one fine cell) from the pocket's wall to the
  // outside, faces touching the pocket and the block's surface exactly.
  function slit(fromX: number, toX: number): Float32Array {
    const p = box(1, true);
    for (let i = 0; i < p.length; i += 3) {
      p[i] = p[i] < 0 ? fromX : toX;
      p[i + 1] *= 0.1;
    }
    return p;
  }

  it("leaves a narrow groove in the surface alone", () => {
    const grooved = concat(box(10), slit(3, 5));
    const nearby = box(1);
    for (let i = 0; i < nearby.length; i += 3) nearby[i] += 3;
    const gGrid = voxelizeSurface(grooved, 20);
    fillInterior(gGrid, grooved);
    const fills = fillEnclosedNearSeals(concat(grooved, nearby), [nearby], gGrid.voxelSize, { position: grooved, grid: gGrid, components: detectVoidComponentsFull(gGrid).components, unfilledIds: new Set(), shells: [] });
    expect(fills).toHaveLength(0);
  });

  it("leaves a cavity the user chose not to fill alone", () => {
    const fills = fillEnclosedNearSeals(model, [seal], grid.voxelSize, { position: original, grid, components, unfilledIds: new Set([pocket.id]), shells });
    expect(fills).toHaveLength(0);
  });

  it("adds nothing where the seal leaves no gap", () => {
    const tight = concat(box(10), box(4, true), box(4.4));
    const fills = fillEnclosedNearSeals(tight, [box(4.4)], grid.voxelSize, { position: original, grid, components, unfilledIds: new Set(), shells });
    expect(fills).toHaveLength(0);
  });
});
