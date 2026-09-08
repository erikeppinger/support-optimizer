import type { VoxelGrid } from "./voxelize";
import { voxelIndex } from "./voxelize";

/**
 * BFS from voxel (0,0,0) — guaranteed empty by voxelizeSurface's padding
 * — through 6-connected empty (non-solid) voxels. Returns a same-sized
 * Uint8Array marking which empty voxels are reachable from outside the
 * mesh; any empty voxel left unmarked is an enclosed cavity.
 */
export function floodFillExterior(grid: VoxelGrid): Uint8Array {
  const { nx, ny, nz, solid } = grid;
  const reached = new Uint8Array(nx * ny * nz);

  // Manual index queue (not Array.shift, which is O(n)) sized to the
  // grid — a BFS visits each cell at most once.
  const queue = new Int32Array(nx * ny * nz);
  let head = 0, tail = 0;

  const start = voxelIndex(grid, 0, 0, 0);
  reached[start] = 1;
  queue[tail++] = start;

  const stepX = 1, stepY = nx, stepZ = nx * ny;

  while (head < tail) {
    const idx = queue[head++];
    const z = Math.floor(idx / stepZ);
    const y = Math.floor((idx - z * stepZ) / stepY);
    const x = idx - z * stepZ - y * stepY;

    if (x > 0) {
      const n = idx - stepX;
      if (!reached[n] && !solid[n]) { reached[n] = 1; queue[tail++] = n; }
    }
    if (x < nx - 1) {
      const n = idx + stepX;
      if (!reached[n] && !solid[n]) { reached[n] = 1; queue[tail++] = n; }
    }
    if (y > 0) {
      const n = idx - stepY;
      if (!reached[n] && !solid[n]) { reached[n] = 1; queue[tail++] = n; }
    }
    if (y < ny - 1) {
      const n = idx + stepY;
      if (!reached[n] && !solid[n]) { reached[n] = 1; queue[tail++] = n; }
    }
    if (z > 0) {
      const n = idx - stepZ;
      if (!reached[n] && !solid[n]) { reached[n] = 1; queue[tail++] = n; }
    }
    if (z < nz - 1) {
      const n = idx + stepZ;
      if (!reached[n] && !solid[n]) { reached[n] = 1; queue[tail++] = n; }
    }
  }

  return reached;
}
