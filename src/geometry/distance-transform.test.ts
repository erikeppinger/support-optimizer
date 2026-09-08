import { describe, it, expect } from "vitest";
import { distanceTransform3D } from "./distance-transform";

function idx(nx: number, ny: number, x: number, y: number, z: number) {
  return (z * ny + y) * nx + x;
}

describe("distanceTransform3D", () => {
  it("is zero at the single marked voxel and grows radially from it", () => {
    const n = 11;
    const mask = new Uint8Array(n * n * n);
    const center = 5;
    mask[idx(n, n, center, center, center)] = 1;

    const d = distanceTransform3D(mask, n, n, n);

    expect(d[idx(n, n, center, center, center)]).toBeCloseTo(0, 6);
    expect(d[idx(n, n, center + 1, center, center)]).toBeCloseTo(1, 6);
    expect(d[idx(n, n, center + 3, center, center)]).toBeCloseTo(3, 6);
    expect(d[idx(n, n, center + 3, center + 4, center)]).toBeCloseTo(5, 6); // 3-4-5 triangle
    expect(d[idx(n, n, 0, 0, 0)]).toBeCloseTo(Math.sqrt(3 * center * center), 6);
  });

  it("gives linear distance to a marked plane", () => {
    const nx = 10, ny = 10, nz = 10;
    const mask = new Uint8Array(nx * ny * nz);
    // Mark the entire z=0 plane.
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) mask[idx(nx, ny, x, y, 0)] = 1;

    const d = distanceTransform3D(mask, nx, ny, nz);
    for (let z = 0; z < nz; z++) {
      expect(d[idx(nx, ny, 5, 5, z)]).toBeCloseTo(z, 6);
    }
  });

  it("returns zero everywhere when every voxel is marked", () => {
    const n = 6;
    const mask = new Uint8Array(n * n * n).fill(1);
    const d = distanceTransform3D(mask, n, n, n);
    for (const v of d) expect(v).toBeCloseTo(0, 6);
  });

  it("finds the nearer of two marked voxels", () => {
    const n = 21;
    const mask = new Uint8Array(n * n * n);
    mask[idx(n, n, 2, 10, 10)] = 1;
    mask[idx(n, n, 18, 10, 10)] = 1;
    const d = distanceTransform3D(mask, n, n, n);
    // Point near the left marker should be close to distance-to-left, not
    // accidentally influenced by the far marker.
    expect(d[idx(n, n, 5, 10, 10)]).toBeCloseTo(3, 6);
    expect(d[idx(n, n, 15, 10, 10)]).toBeCloseTo(3, 6);
  });
});
