import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { countToolChanges, triangleColorIndices } from "./tool-changes";
import { searchBestOrientation } from "./orientation-search";

/** Two 10 mm boxes side by side along x, one color each. */
function twoBoxes() {
  const a = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
  const b = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
  a.translate(-5, 0, 5);
  b.translate(5, 0, 5);
  const pa = a.attributes.position.array as Float32Array, pb = b.attributes.position.array as Float32Array;
  const position = new Float32Array(pa.length + pb.length);
  position.set(pa);
  position.set(pb, pa.length);
  const na = a.attributes.normal.array as Float32Array, nb = b.attributes.normal.array as Float32Array;
  const normal = new Float32Array(na.length + nb.length);
  normal.set(na);
  normal.set(nb, na.length);
  const triColor = new Uint8Array(position.length / 9);
  triColor.fill(1, pa.length / 9);
  return { position, normal, triColor };
}

describe("countToolChanges", () => {
  it("changes tools in every layer when both colors share each layer", () => {
    const { position, triColor } = twoBoxes();
    // 10 mm tall at 0.2 mm: 50 layers, each holding both colors. The first
    // layer costs one change, every later one too (it starts on the color
    // the layer below ended on, then switches once).
    expect(countToolChanges(position, triColor, new THREE.Vector3(0, 0, 1))).toBe(50);
  });

  it("changes tools once when the colors are stacked", () => {
    const { position, triColor } = twoBoxes();
    // Building along x stacks one box on the other: only the layer where
    // they meet holds both colors.
    expect(countToolChanges(position, triColor, new THREE.Vector3(1, 0, 0))).toBeLessThanOrEqual(2);
  });
});

describe("triangleColorIndices", () => {
  it("returns null for a single color", () => {
    const colors = new Float32Array(18).fill(0.5);
    expect(triangleColorIndices(colors)).toBeNull();
  });

  it("numbers colors in order of first appearance", () => {
    const colors = new Float32Array([...Array(9).fill(1), ...Array(9).fill(0), ...Array(9).fill(1)]);
    const result = triangleColorIndices(colors)!;
    expect(result.colorCount).toBe(2);
    expect(Array.from(result.index)).toEqual([0, 1, 0]);
  });
});

describe("searchBestOrientation with tool changes", () => {
  it("stacks the colors when optimizing for fewest tool changes", () => {
    const { position, normal, triColor } = twoBoxes();
    const result = searchBestOrientation(position, normal, {
      criticalAngleDeg: 45,
      optimizeFor: "tool-changes",
      toolChangeMesh: { position, triColor },
    });
    expect(result.toolChanges).toBeLessThanOrEqual(2);
    expect(Math.abs(result.up.x)).toBeGreaterThan(0.9);
  });

  it("keeps least-support results unchanged when colors are given", () => {
    const { position, normal, triColor } = twoBoxes();
    const result = searchBestOrientation(position, normal, {
      criticalAngleDeg: 45,
      optimizeFor: "support",
      toolChangeMesh: { position, triColor },
    });
    // Both boxes resting side by side (up along z or y, which tie): no
    // overhang and the largest contact area. Stacking them (up along x)
    // would halve the contact area, so least support never picks it.
    expect(result.cost).toBeCloseTo(0, 6);
    expect(Math.abs(result.up.x)).toBeLessThan(0.1);
  });
});
