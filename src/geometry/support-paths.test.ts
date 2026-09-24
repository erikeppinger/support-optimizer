import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { generateSupportPaths } from "./support-paths";

/** Deterministic PRNG (no external dependency) so the test is reproducible. */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** A field of small downward-facing (straight -Z normal) triangles at
 * varied heights, scattered over a square footprint — enough spatial
 * variety that greedy nearest-pair merging has plenty of candidate pairs
 * at a range of horizontal separations and height differences, so the
 * branch-angle constraint actually gets exercised (not just trivially
 * satisfied by every pair already being close together). */
function buildScatteredOverhangMesh(count: number, footprint: number, heightRange: number, seed: number) {
  const rand = makeRng(seed);
  const position: number[] = [];
  const normal: number[] = [];
  const triSize = footprint * 0.006;
  for (let i = 0; i < count; i++) {
    const cx = (rand() - 0.5) * footprint;
    const cy = (rand() - 0.5) * footprint;
    const cz = rand() * heightRange;
    position.push(
      cx - triSize, cy - triSize, cz,
      cx + triSize, cy - triSize, cz,
      cx, cy + triSize, cz,
    );
    for (let k = 0; k < 3; k++) normal.push(0, 0, -1);
  }
  return { position: new Float32Array(position), normal: new Float32Array(normal) };
}

/** Every overhang triangle's centroid — the only positions a support
 * branch is allowed to START from, since a centroid is by construction
 * exactly on the surface. */
function overhangCentroids(position: Float32Array, normal: Float32Array, criticalAngleDeg: number) {
  const out: Array<[number, number, number]> = [];
  for (let f = 0; f < position.length / 9; f++) {
    const i0 = f * 9;
    // up is +Z in these fixtures, so lean is measured off the normal's Z.
    const leanDeg = (Math.asin(Math.max(-1, Math.min(1, -normal[i0 + 2]))) * 180) / Math.PI;
    if (leanDeg <= criticalAngleDeg) continue;
    const i1 = i0 + 3, i2 = i0 + 6;
    out.push([
      (position[i0] + position[i1] + position[i2]) / 3,
      (position[i0 + 1] + position[i1 + 1] + position[i2 + 1]) / 3,
      (position[i0 + 2] + position[i1 + 2] + position[i2 + 2]) / 3,
    ]);
  }
  return out;
}

describe("generateSupportPaths root anchoring", () => {
  it("starts every branch on the surface, never at a mid-air averaged point", () => {
    const { position, normal } = buildScatteredOverhangMesh(300, 100, 40, 11);
    const criticalAngleDeg = 45;
    const result = generateSupportPaths(position, normal, new THREE.Vector3(0, 0, 1), criticalAngleDeg);
    expect(result.paths.length).toBeGreaterThan(0);

    // A "root" is a branch's free upper end: it appears as the HIGHER end
    // of some segment and never as the lower end of any other. A merge
    // junction always appears as both (lower end of the two segments that
    // formed it, higher end of the one descending from it), so this set
    // isolates exactly the points generation chose to start from.
    const key = (v: THREE.Vector3) => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
    const higherEnds = new Map<string, THREE.Vector3>();
    const lowerEnds = new Set<string>();
    for (const path of result.paths) {
      const [a, b] = path.points;
      const hi = a.z >= b.z ? a : b;
      const lo = a.z >= b.z ? b : a;
      higherEnds.set(key(hi), hi);
      lowerEnds.add(key(lo));
    }
    const roots = [...higherEnds].filter(([k]) => !lowerEnds.has(k)).map(([, v]) => v);
    expect(roots.length).toBeGreaterThan(0);

    const centroids = overhangCentroids(position, normal, criticalAngleDeg);
    for (const root of roots) {
      const onSurface = centroids.some(
        ([x, y, z]) => Math.abs(root.x - x) < 1e-4 && Math.abs(root.y - y) < 1e-4 && Math.abs(root.z - z) < 1e-4,
      );
      expect(onSurface).toBe(true);
    }
  });
});

describe("generateSupportPaths branch angle constraint", () => {
  it("never emits a segment steeper than the critical overhang angle from vertical", () => {
    const { position, normal } = buildScatteredOverhangMesh(300, 100, 40, 7);
    const criticalAngleDeg = 15; // strict on purpose, to stress the constraint
    const result = generateSupportPaths(position, normal, new THREE.Vector3(0, 0, 1), criticalAngleDeg);
    expect(result.paths.length).toBeGreaterThan(0);

    let nonVerticalSegments = 0;
    for (const path of result.paths) {
      const [a, b] = path.points;
      const dz = Math.abs(a.z - b.z);
      const horiz = Math.hypot(a.x - b.x, a.y - b.y);
      if (horiz < 1e-6) continue; // straight-down segment (bridge or final tip->plate), trivially fine
      nonVerticalSegments++;
      const angleFromVerticalDeg = (Math.atan2(horiz, dz) * 180) / Math.PI;
      expect(angleFromVerticalDeg).toBeLessThanOrEqual(criticalAngleDeg + 0.5); // small float-precision epsilon
    }
    // A merge-heavy scene like this should produce at least some actual
    // (non-vertical) connector segments — otherwise the assertion above
    // never exercises the constraint at all.
    expect(nonVerticalSegments).toBeGreaterThan(0);
  });

  it("finds the same roots regardless of angle limit, and stays within a generous limit too", () => {
    const { position, normal } = buildScatteredOverhangMesh(300, 100, 40, 7);
    const permissive = generateSupportPaths(position, normal, new THREE.Vector3(0, 0, 1), 85);
    const strict = generateSupportPaths(position, normal, new THREE.Vector3(0, 0, 1), 15);
    // Root clustering happens before any merge-angle logic runs, so the
    // angle limit shouldn't change how many roots there are to begin with.
    expect(permissive.rootCount).toBe(strict.rootCount);

    for (const path of permissive.paths) {
      const [a, b] = path.points;
      const horiz = Math.hypot(a.x - b.x, a.y - b.y);
      if (horiz < 1e-6) continue;
      const dz = Math.abs(a.z - b.z);
      expect((Math.atan2(horiz, dz) * 180) / Math.PI).toBeLessThanOrEqual(85.5);
    }
  });
});

describe("generateSupportPaths style", () => {
  it("'snug' finds the same roots as 'organic' but never merges — one straight vertical segment per root", () => {
    const { position, normal } = buildScatteredOverhangMesh(300, 100, 40, 7);
    const up = new THREE.Vector3(0, 0, 1);
    const organic = generateSupportPaths(position, normal, up, 45, { style: "organic" });
    const snug = generateSupportPaths(position, normal, up, 45, { style: "snug" });

    expect(snug.rootCount).toBe(organic.rootCount);
    // Organic merges roots into fewer, branching trunks — so unless
    // nothing was close enough to merge, it should produce fewer or
    // differently-shaped paths than one-segment-per-root.
    expect(snug.paths.length).toBe(snug.rootCount);

    for (const path of snug.paths) {
      const [a, b] = path.points;
      // Every snug segment is a pure vertical drop (root straight down to
      // its landing) — x/y never change within one segment.
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(0, 6);
    }
  });

  it("'grid' anchors roots to a regular lattice, still one straight vertical segment per root", () => {
    const { position, normal } = buildScatteredOverhangMesh(300, 100, 40, 7);
    const up = new THREE.Vector3(0, 0, 1);
    const grid = generateSupportPaths(position, normal, up, 45, { style: "grid" });

    expect(grid.rootCount).toBeGreaterThan(0);
    expect(grid.paths.length).toBe(grid.rootCount);

    for (const path of grid.paths) {
      const [a, b] = path.points;
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(0, 6);
    }

    // Lattice-snapped roots should land on a shared, regularly-spaced set
    // of (x,y) values — the defining difference from "organic"/"snug",
    // which anchor to the scattered real overhang positions instead.
    // With >1 distinct x value, the spacing between consecutive sorted
    // values should be consistent (a real lattice), not arbitrary.
    const xs = [...new Set(grid.paths.map((p) => Number(p.points[0].x.toFixed(4))))].sort((a, b) => a - b);
    if (xs.length > 2) {
      const gaps = xs.slice(1).map((x, i) => x - xs[i]);
      const minGap = Math.min(...gaps);
      for (const gap of gaps) {
        // Every gap should be a near-integer multiple of the smallest gap
        // (the lattice spacing) — not scattered arbitrary distances.
        const ratio = gap / minGap;
        expect(Math.abs(ratio - Math.round(ratio))).toBeLessThan(0.05);
      }
    }
  });

  it("defaults to 'organic' when style is omitted", () => {
    const { position, normal } = buildScatteredOverhangMesh(300, 100, 40, 7);
    const up = new THREE.Vector3(0, 0, 1);
    const withDefault = generateSupportPaths(position, normal, up, 45);
    const explicit = generateSupportPaths(position, normal, up, 45, { style: "organic" });
    expect(withDefault.paths.length).toBe(explicit.paths.length);
    expect(withDefault.rootCount).toBe(explicit.rootCount);
  });
});
