import * as THREE from "three";
import { edgeTable, triTable } from "three/examples/jsm/objects/MarchingCubes.js";
import type { VoxelGrid } from "./voxelize";
import { voxelIndex } from "./voxelize";

// Standard Lorensen/Cline cube-corner numbering (the same one edgeTable
// and triTable — reused from three.js's own metaball implementation —
// are built for): corner i sits at base + CORNER_OFFSETS[i] * voxelSize.
const CORNER_OFFSETS: Array<[number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];

// Which two corners each of the 12 cube edges connects.
const EDGE_CORNERS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * Remeshes a voxel grid's solid/empty boundary into a triangle surface.
 * When `grid.field` is absent (the common case — triangle-soup
 * voxelization has no analytic distance), occupancy is binary and every
 * edge crossing interpolates to exactly the midpoint — the classic
 * "smoothed voxels" marching-cubes look, limited by grid resolution. When
 * `grid.field` is present (e.g. an atom van-der-Waals union's signed
 * distance), edges interpolate against the real zero-crossing instead,
 * producing a smooth curved surface at the same grid resolution.
 */
export function marchingCubes(grid: VoxelGrid): THREE.BufferGeometry {
  const { nx, ny, nz, voxelSize, origin, solid, field } = grid;
  const isoValue = field ? 0 : 0.5;
  const positions: number[] = [];

  const cornerValue = new Float32Array(8);
  const cornerPos: THREE.Vector3[] = Array.from({ length: 8 }, () => new THREE.Vector3());
  const edgePoint: THREE.Vector3[] = Array.from({ length: 12 }, () => new THREE.Vector3());

  for (let z = 0; z < nz - 1; z++) {
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        let cubeindex = 0;
        for (let c = 0; c < 8; c++) {
          const [ox, oy, oz] = CORNER_OFFSETS[c];
          const cx = x + ox, cy = y + oy, cz = z + oz;
          const i = voxelIndex(grid, cx, cy, cz);
          const v = field ? field[i] : solid[i];
          cornerValue[c] = v;
          // "Outside" sets the bit, matching edgeTable/triTable's
          // convention: for the binary mask v<0.5 means empty/outside; for
          // a signed-distance field, positive means outside.
          const outside = field ? v > isoValue : v < isoValue;
          if (outside) cubeindex |= 1 << c;
          cornerPos[c].set(
            origin.x + cx * voxelSize,
            origin.y + cy * voxelSize,
            origin.z + cz * voxelSize,
          );
        }

        const bits = edgeTable[cubeindex];
        if (bits === 0) continue;

        for (let e = 0; e < 12; e++) {
          if (!(bits & (1 << e))) continue;
          const [ca, cb] = EDGE_CORNERS[e];
          const va = cornerValue[ca], vb = cornerValue[cb];
          const mu = Math.abs(vb - va) < 1e-6 ? 0.5 : (isoValue - va) / (vb - va);
          edgePoint[e].lerpVectors(cornerPos[ca], cornerPos[cb], mu);
        }

        const row = cubeindex * 16;
        for (let t = 0; t < 16; t += 3) {
          const e0 = triTable[row + t];
          if (e0 === -1) break;
          const e1 = triTable[row + t + 1];
          const e2 = triTable[row + t + 2];
          const p0 = edgePoint[e0], p1 = edgePoint[e1], p2 = edgePoint[e2];
          positions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}
