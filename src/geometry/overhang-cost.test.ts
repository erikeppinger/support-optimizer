import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { leanAngleDegrees, applyOverhangColors, DEFAULT_CRITICAL_ANGLE_DEG } from "./overhang-cost";
import { evaluateOrientationCost } from "./orientation-search";

describe("leanAngleDegrees", () => {
  it("is 0 for an upward-facing face (fully self-supporting)", () => {
    expect(leanAngleDegrees(1)).toBeCloseTo(0, 6);
  });

  it("is 90 for a straight-down overhang (worst case)", () => {
    expect(leanAngleDegrees(-1)).toBeCloseTo(90, 6);
  });

  it("is 0 for a vertical wall (normal has no Z component)", () => {
    expect(leanAngleDegrees(0)).toBeCloseTo(0, 6);
  });

  it("is 45 for a face leaning exactly halfway to horizontal-down", () => {
    // normalZ = -sin(45deg): the classic 45-degree overhang boundary.
    expect(leanAngleDegrees(-Math.sin(Math.PI / 4))).toBeCloseTo(45, 4);
  });
});

describe("applyOverhangColors", () => {
  it("colors faces under the critical angle blue and over it red", () => {
    // Two triangles: one upward-facing (safe), one downward-facing
    // (overhang), non-indexed so each vertex carries its own flat normal.
    const position = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 0, 1, 1, 0, 1, 0, 1, 1,
    ]);
    const normal = new Float32Array([
      0, 0, 1, 0, 0, 1, 0, 0, 1,
      0, 0, -1, 0, 0, -1, 0, 0, -1,
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));

    applyOverhangColors(geometry, DEFAULT_CRITICAL_ANGLE_DEG);

    const color = geometry.getAttribute("color") as THREE.BufferAttribute;
    const safe = new THREE.Color(color.getX(0), color.getY(0), color.getZ(0));
    const overhang = new THREE.Color(color.getX(3), color.getY(3), color.getZ(3));
    // Overhang (red) should have a stronger red channel and weaker
    // blue/green than the safe (blue-ish) face.
    expect(overhang.r).toBeGreaterThan(safe.r);
    expect(overhang.b).toBeLessThan(safe.b);
  });
});

describe("evaluateOrientationCost", () => {
  // A small "floor" triangle far off to the side at Z=0 (pulls minProj to
  // 0 without sitting under the overhang triangle, so it can't occlude
  // it), plus a horizontal downward-facing "roof" triangle floating at
  // Z=20 directly above open space. With no occluder below it, its
  // support cost should be exactly area * height.
  const floor = [100, 100, 0, 110, 100, 0, 100, 110, 0];
  const floorNormal = [0, 0, 1, 0, 0, 1, 0, 0, 1];
  const roof = [0, 0, 20, 10, 0, 20, 0, 10, 20];
  const roofNormal = [0, 0, -1, 0, 0, -1, 0, 0, -1];

  const position = new Float32Array([...floor, ...roof]);
  const normal = new Float32Array([...floorNormal, ...roofNormal]);

  it("costs area times unobstructed drop height for a floating overhang", () => {
    const { cost } = evaluateOrientationCost(position, normal, new THREE.Vector3(0, 0, 1), 45);
    // Right-triangle legs of 10 => area 50; height 20 => cost 1000.
    expect(cost).toBeCloseTo(1000, 1);
  });

  it("counts only plate-touching triangles toward contact area", () => {
    const { contactArea } = evaluateOrientationCost(position, normal, new THREE.Vector3(0, 0, 1), 45);
    expect(contactArea).toBeCloseTo(50, 1);
  });

  it("has zero cost when nothing exceeds the critical angle", () => {
    const { cost } = evaluateOrientationCost(position, normal, new THREE.Vector3(0, 0, 1), 90);
    expect(cost).toBe(0);
  });
});
