import * as THREE from "three";

export interface VoxelGrid {
  nx: number;
  ny: number;
  nz: number;
  voxelSize: number;
  /** World position of voxel (0,0,0)'s min corner. */
  origin: THREE.Vector3;
  /** nx*ny*nz, 1 = surface/solid voxel, indexed via voxelIndex(). */
  solid: Uint8Array;
  /**
   * Optional signed-distance field (same length/indexing as `solid`,
   * negative = inside, 0 = surface). When present, marchingCubes()
   * interpolates edge crossings against this continuous field instead of
   * the binary `solid` mask, producing a smooth iso-surface instead of the
   * blocky "always-midpoint" look — only meaningful for sources with a
   * real analytic distance (e.g. atom van-der-Waals spheres). Triangle-soup
   * voxelization (voxelizeSurface below) has no cheap analytic distance, so
   * it never sets this and marchingCubes falls back to binary as before.
   */
  field?: Float32Array;
}

export function voxelIndex(grid: VoxelGrid, x: number, y: number, z: number): number {
  return (z * grid.ny + y) * grid.nx + x;
}

/** Empty border voxelizeSurface pads around the mesh, guaranteeing a
 * flood-fill start point. Exported so other modules (e.g. void-region
 * classification) can tell padding apart from the mesh's own interior. */
export const PAD = 2;

/** Akenine-Möller triangle/box overlap test (13-axis SAT): 3 box-face
 * axes, 1 triangle-normal axis, 9 edge-cross-product axes. Triangle
 * vertices are pre-translated so the box center is the origin. */
function triangleBoxOverlap(
  hx: number, hy: number, hz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): boolean {
  if (Math.min(ax, bx, cx) > hx || Math.max(ax, bx, cx) < -hx) return false;
  if (Math.min(ay, by, cy) > hy || Math.max(ay, by, cy) < -hy) return false;
  if (Math.min(az, bz, cz) > hz || Math.max(az, bz, cz) < -hz) return false;

  const e0x = bx - ax, e0y = by - ay, e0z = bz - az;
  const e1x = cx - bx, e1y = cy - by, e1z = cz - bz;
  const e2x = ax - cx, e2y = ay - cy, e2z = az - cz;

  const nx = e0y * e1z - e0z * e1y;
  const ny = e0z * e1x - e0x * e1z;
  const nz = e0x * e1y - e0y * e1x;
  const planeD = nx * ax + ny * ay + nz * az;
  const r0 = hx * Math.abs(nx) + hy * Math.abs(ny) + hz * Math.abs(nz);
  if (Math.abs(planeD) > r0) return false;

  function axisTest(axx: number, axy: number, axz: number): boolean {
    const p0 = ax * axx + ay * axy + az * axz;
    const p1 = bx * axx + by * axy + bz * axz;
    const p2 = cx * axx + cy * axy + cz * axz;
    const r = hx * Math.abs(axx) + hy * Math.abs(axy) + hz * Math.abs(axz);
    return !(Math.min(p0, p1, p2) > r || Math.max(p0, p1, p2) < -r);
  }

  return (
    axisTest(0, -e0z, e0y) && axisTest(0, -e1z, e1y) && axisTest(0, -e2z, e2y) &&
    axisTest(e0z, 0, -e0x) && axisTest(e1z, 0, -e1x) && axisTest(e2z, 0, -e2x) &&
    axisTest(-e0y, e0x, 0) && axisTest(-e1y, e1x, 0) && axisTest(-e2y, e2x, 0)
  );
}

/**
 * Rasterizes a triangle-soup surface into a binary voxel grid: voxels the
 * surface passes through are marked solid. `targetResolution` is the
 * voxel count along the mesh's longest axis. A padded empty border is
 * added around the mesh so flood-fill always has a guaranteed-exterior
 * starting voxel.
 */
export function voxelizeSurface(position: Float32Array, targetResolution: number): VoxelGrid {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < position.length; i += 3) {
    const x = position[i], y = position[i + 1], z = position[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const dimX = maxX - minX, dimY = maxY - minY, dimZ = maxZ - minZ;
  const maxDim = Math.max(dimX, dimY, dimZ, 1e-6);
  const voxelSize = maxDim / targetResolution;

  const nx = Math.ceil(dimX / voxelSize) + PAD * 2;
  const ny = Math.ceil(dimY / voxelSize) + PAD * 2;
  const nz = Math.ceil(dimZ / voxelSize) + PAD * 2;

  const origin = new THREE.Vector3(
    minX - PAD * voxelSize,
    minY - PAD * voxelSize,
    minZ - PAD * voxelSize,
  );
  const solid = new Uint8Array(nx * ny * nz);
  const grid: VoxelGrid = { nx, ny, nz, voxelSize, origin, solid };

  const half = voxelSize / 2;
  const triCount = position.length / 9;

  for (let f = 0; f < triCount; f++) {
    const i0 = f * 9, i1 = i0 + 3, i2 = i0 + 6;
    const v0x = position[i0], v0y = position[i0 + 1], v0z = position[i0 + 2];
    const v1x = position[i1], v1y = position[i1 + 1], v1z = position[i1 + 2];
    const v2x = position[i2], v2y = position[i2 + 1], v2z = position[i2 + 2];

    const triMinX = Math.min(v0x, v1x, v2x), triMaxX = Math.max(v0x, v1x, v2x);
    const triMinY = Math.min(v0y, v1y, v2y), triMaxY = Math.max(v0y, v1y, v2y);
    const triMinZ = Math.min(v0z, v1z, v2z), triMaxZ = Math.max(v0z, v1z, v2z);

    const ix0 = Math.max(0, Math.floor((triMinX - origin.x) / voxelSize) - 1);
    const iy0 = Math.max(0, Math.floor((triMinY - origin.y) / voxelSize) - 1);
    const iz0 = Math.max(0, Math.floor((triMinZ - origin.z) / voxelSize) - 1);
    const ix1 = Math.min(nx - 1, Math.ceil((triMaxX - origin.x) / voxelSize) + 1);
    const iy1 = Math.min(ny - 1, Math.ceil((triMaxY - origin.y) / voxelSize) + 1);
    const iz1 = Math.min(nz - 1, Math.ceil((triMaxZ - origin.z) / voxelSize) + 1);

    for (let iz = iz0; iz <= iz1; iz++) {
      const centerZ = origin.z + (iz + 0.5) * voxelSize;
      for (let iy = iy0; iy <= iy1; iy++) {
        const centerY = origin.y + (iy + 0.5) * voxelSize;
        for (let ix = ix0; ix <= ix1; ix++) {
          const idx = voxelIndex(grid, ix, iy, iz);
          if (solid[idx]) continue;
          const centerX = origin.x + (ix + 0.5) * voxelSize;
          if (
            triangleBoxOverlap(
              half, half, half,
              v0x - centerX, v0y - centerY, v0z - centerZ,
              v1x - centerX, v1y - centerY, v1z - centerZ,
              v2x - centerX, v2y - centerY, v2z - centerZ,
            )
          ) {
            solid[idx] = 1;
          }
        }
      }
    }
  }

  return grid;
}
