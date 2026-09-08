/**
 * Exact squared Euclidean distance transform (Felzenszwalt & Huttenlocher,
 * "Distance Transforms of Sampled Functions", 2012): for a 1D array of
 * costs `f`, returns `d[x] = min_y( f[y] + (x-y)^2 )` in O(n). Applied
 * separably along X, then Y, then Z, this gives the exact 3D squared
 * Euclidean distance transform of a binary volume — the standard way to
 * compute "distance to nearest marked voxel" without an O(voxels^2) brute
 * force. Used by computeSESField (see pdb.ts) to find, for every grid
 * point, how far it is from the nearest solvent-accessible voxel.
 */
function distanceTransform1D(f: Float64Array, n: number, out: Float64Array) {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;

  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    out[q] = dx * dx + f[v[k]];
  }
}

/**
 * 3D exact Euclidean distance transform of a binary mask: returns, for
 * every voxel, the distance (in voxel units) to the nearest voxel where
 * `mask` is truthy. Separable (X pass, then Y, then Z), each pass exact
 * and O(n) per line, so the whole transform is O(nx*ny*nz) — essential for
 * this to be feasible at all on a hundred-plus-cubed grid; a brute-force
 * nearest-marked-voxel search would be O(voxels^2).
 */
export function distanceTransform3D(mask: Uint8Array, nx: number, ny: number, nz: number): Float32Array {
  const INF = 1e20;
  const idx = (x: number, y: number, z: number) => (z * ny + y) * nx + x;

  let f = new Float64Array(nx * ny * nz);
  for (let i = 0; i < f.length; i++) f[i] = mask[i] ? 0 : INF;

  // Pass 1: along X.
  {
    const line = new Float64Array(nx);
    const outLine = new Float64Array(nx);
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) line[x] = f[idx(x, y, z)];
        distanceTransform1D(line, nx, outLine);
        for (let x = 0; x < nx; x++) f[idx(x, y, z)] = outLine[x];
      }
    }
  }

  // Pass 2: along Y.
  {
    const line = new Float64Array(ny);
    const outLine = new Float64Array(ny);
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        for (let y = 0; y < ny; y++) line[y] = f[idx(x, y, z)];
        distanceTransform1D(line, ny, outLine);
        for (let y = 0; y < ny; y++) f[idx(x, y, z)] = outLine[y];
      }
    }
  }

  // Pass 3: along Z.
  {
    const line = new Float64Array(nz);
    const outLine = new Float64Array(nz);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        for (let z = 0; z < nz; z++) line[z] = f[idx(x, y, z)];
        distanceTransform1D(line, nz, outLine);
        for (let z = 0; z < nz; z++) f[idx(x, y, z)] = outLine[z];
      }
    }
  }

  const result = new Float32Array(nx * ny * nz);
  for (let i = 0; i < result.length; i++) result[i] = Math.sqrt(f[i]);
  return result;
}
