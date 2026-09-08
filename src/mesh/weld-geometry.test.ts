import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { weldGeometryForExport } from "./weld-geometry";
import { marchingCubes } from "../geometry/marching-cubes";
import type { VoxelGrid } from "../geometry/voxelize";
import { voxelIndex } from "../geometry/voxelize";
import { voxelizeAtoms } from "../geometry/pdb";

/** Every triangle edge in a closed (2-manifold, no boundary) mesh belongs
 * to exactly 2 triangles. Any edge belonging to a different count means
 * the surface isn't closed there — exactly what a slicer's "open edges"
 * warning flags. Requires an INDEXED geometry (shared vertices), which is
 * why every check below runs on weldGeometryForExport's output, not the
 * raw non-indexed marching-cubes triangle soup. */
function countNonManifoldEdges(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  if (!index) throw new Error("expected an indexed geometry");
  const edgeCounts = new Map<string, number>();
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      const key = x < y ? `${x}_${y}` : `${y}_${x}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }
  let nonManifold = 0;
  for (const count of edgeCounts.values()) if (count !== 2) nonManifold++;
  return nonManifold;
}

function buildSolidSphereGrid(n: number, radiusVoxels: number): VoxelGrid {
  const solid = new Uint8Array(n * n * n);
  const grid: VoxelGrid = { nx: n, ny: n, nz: n, voxelSize: 1, origin: new THREE.Vector3(0, 0, 0), solid };
  const c = (n - 1) / 2;
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const d = Math.hypot(x - c, y - c, z - c);
        if (d <= radiusVoxels) solid[voxelIndex(grid, x, y, z)] = 1;
      }
    }
  }
  return grid;
}

describe("weldGeometryForExport", () => {
  it("welds a non-indexed triangle soup into a connected indexed mesh", () => {
    // A single triangle has no shared edges with anything — welding just
    // needs to not crash and should produce exactly 3 unique vertices.
    const position = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(position, 3)); // arbitrary flat normal stand-in
    const welded = weldGeometryForExport(geometry);
    expect(welded.getIndex()).not.toBeNull();
    expect(welded.attributes.position.count).toBe(3);
  });

  it("produces zero non-manifold edges for plain binary-field marching cubes (a clean solid sphere)", () => {
    const grid = buildSolidSphereGrid(24, 9);
    const raw = marchingCubes(grid);
    const welded = weldGeometryForExport(raw);
    expect(countNonManifoldEdges(welded)).toBe(0);
  });

  it("produces zero non-manifold edges for the SES field path (a small multi-atom cluster)", () => {
    // Several overlapping/adjacent atoms — closer to real protein data
    // than a single isolated sphere, and specifically exercises the
    // signed-distance-field marching-cubes path (not the binary one).
    const atoms = [
      { x: 0, y: 0, z: 0, radius: 1.7, chain: "A" },
      { x: 1.4, y: 0.3, z: 0, radius: 1.55, chain: "A" },
      { x: -1.2, y: 1.0, z: 0.4, radius: 1.7, chain: "A" },
      { x: 0.5, y: -1.3, z: 0.8, radius: 1.52, chain: "A" },
      { x: 0.2, y: 0.6, z: 1.6, radius: 1.8, chain: "A" },
    ];
    const grid = voxelizeAtoms(atoms, 40);
    const raw = marchingCubes(grid);
    const welded = weldGeometryForExport(raw);
    expect(countNonManifoldEdges(welded)).toBe(0);
  });
});
