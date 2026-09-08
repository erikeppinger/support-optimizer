import * as THREE from "three";
import { leanAngleDegrees } from "./overhang-cost";
import { raycastNearest } from "./raycast";

export interface SearchOptions {
  criticalAngleDeg: number;
  coarseSamples?: number;
  refineTopK?: number;
  refineGridSize?: number;
  refineAngleRadiusDeg?: number;
  onProgress?: (fraction: number) => void;
}

export interface OrientationCandidate {
  up: THREE.Vector3;
  cost: number;
  contactArea: number;
}

const DEFAULT_COARSE_SAMPLES = 32;
const DEFAULT_REFINE_TOP_K = 3;
const DEFAULT_REFINE_GRID_SIZE = 4;
const DEFAULT_REFINE_ANGLE_RADIUS_DEG = 12;

// Mechanical/CAD-style parts (boxes, drilled channels, flat-walled
// features) very often have their true optimum sitting exactly on one of
// their own local axes — e.g. standing a horizontal bore upright makes
// its whole wall vertical (zero overhang) instead of half-overhanging.
// A general sphere sampling can land tens of degrees away from a point
// like that and never refine into it, even though the basin around it
// isn't especially narrow — so these 6 directions are always evaluated
// as guaranteed candidates, on top of (not instead of) the sphere sweep.
const AXIS_ALIGNED_DIRECTIONS: THREE.Vector3[] = [
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
];

// Support cost alone can leave a razor-balanced orientation (e.g. a cube
// tipped onto one corner, or edge-on) tied with — or even ahead of — a
// flat, stable rest: every face angle is still under the critical angle,
// so the metric sees zero overhang either way, even though no one would
// print balanced on a point or edge. That's not a rare edge case: any
// sufficiently simple/symmetric shape has a wide flat "plateau" of
// zero-cost orientations, so the deciding factor in practice is often
// build-plate contact area (a stand-in for adhesion/stability), not
// support cost. `score` blends the two: `stabilityWeight` is in units of
// length (a fraction of the model's own size), so `stabilityWeight *
// contactArea` is a support-cost-like volume — comparable to `cost`
// rather than swamped by or swamping it regardless of model scale.
const STABILITY_WEIGHT_FRACTION = 0.15;

function scoreOf(candidate: OrientationCandidate, stabilityWeight: number): number {
  return candidate.cost - stabilityWeight * candidate.contactArea;
}

function computeBoundingRadius(position: Float32Array): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < position.length; i += 3) {
    const x = position[i], y = position[i + 1], z = position[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
}

/**
 * A uniformly random 3D rotation, via Marsaglia's method for a uniform
 * point on the unit 3-sphere (a uniformly random unit quaternion — any
 * of its 4 components can stand in for "w", the construction is
 * symmetric in all 4). Applied once per search to the whole coarse
 * sample set (see searchBestOrientation): the Fibonacci grid below and
 * AXIS_ALIGNED_DIRECTIONS are both fixed patterns in absolute space, so
 * without this, how well they happen to land near a narrow true optimum
 * would be silently decided once by wherever a structure's own file
 * coordinates (e.g. a PDB/CIF's deposited frame — arbitrary, not
 * normalized to the molecule's shape) happen to point it, rather than
 * being independent of that.
 */
export function randomRotation(): THREE.Quaternion {
  let x1: number, x2: number, s1: number;
  do {
    x1 = Math.random() * 2 - 1;
    x2 = Math.random() * 2 - 1;
    s1 = x1 * x1 + x2 * x2;
  } while (s1 >= 1);
  let x3: number, x4: number, s2: number;
  do {
    x3 = Math.random() * 2 - 1;
    x4 = Math.random() * 2 - 1;
    s2 = x3 * x3 + x4 * x4;
  } while (s2 >= 1);
  const scale = Math.sqrt((1 - s1) / s2);
  return new THREE.Quaternion(x1, x2, x3 * scale, x4 * scale);
}

/**
 * Evenly distributed points on the unit sphere via a Fibonacci spiral — a
 * simpler substitute for icosphere subdivision with equivalent uniform
 * coverage. Parameterized so sample 0 is exactly (0,0,1) and the last
 * sample is exactly (0,0,-1), guaranteeing the model's current orientation
 * (and its flip) are always among the candidates (before the random
 * per-search rotation in searchBestOrientation is applied on top).
 */
export function sampleSphere(count: number): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const z = count === 1 ? 1 : 1 - (i / (count - 1)) * 2;
    const radiusAtZ = Math.sqrt(Math.max(0, 1 - z * z));
    const theta = goldenAngle * i;
    points.push(new THREE.Vector3(Math.cos(theta) * radiusAtZ, Math.sin(theta) * radiusAtZ, z));
  }
  return points;
}

/** A small grid of directions within `angleRadiusDeg` of `center`, for
 * local refinement around a promising coarse candidate. */
export function sampleCapAround(
  center: THREE.Vector3,
  gridSize: number,
  angleRadiusDeg: number,
): THREE.Vector3[] {
  const arbitrary = Math.abs(center.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(arbitrary, center).normalize();
  const v = new THREE.Vector3().crossVectors(center, u).normalize();

  const maxOffset = Math.tan(THREE.MathUtils.degToRad(angleRadiusDeg));
  const half = (gridSize - 1) / 2 || 1;
  const results: THREE.Vector3[] = [];
  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      const a = ((i - half) / half) * maxOffset;
      const b = ((j - half) / half) * maxOffset;
      results.push(center.clone().addScaledVector(u, a).addScaledVector(v, b).normalize());
    }
  }
  return results;
}

/**
 * Total support cost for resting the mesh with `up` as the print-vertical
 * axis: sum over overhanging triangles of area × (height of open air below
 * them — either down to the build plate, or down to whatever mesh surface
 * occludes them first, found via raycasting). Operates on the same
 * non-indexed position/normal arrays STL geometry uses, where each vertex
 * belongs to exactly one triangle (so normal[i] is that triangle's flat
 * face normal for every vertex i of it).
 *
 * Rotating the mesh around `up` itself never changes this cost (support
 * only depends on which direction is "up", not on spin around it — a
 * rotation about the build axis leaves every point's height and every
 * face's downward visibility unchanged), so candidate orientations only
 * need to search the sphere of `up` directions, not azimuthal rotations.
 */
export interface OrientationCost {
  cost: number;
  /** Total area of triangles resting directly on the build plate. */
  contactArea: number;
}

export function evaluateOrientationCost(
  position: Float32Array,
  normal: Float32Array,
  up: THREE.Vector3,
  criticalAngleDeg: number,
): OrientationCost {
  const ux = up.x, uy = up.y, uz = up.z;
  const vertCount = position.length / 3;
  const triCount = vertCount / 3;

  let minProj = Infinity;
  for (let i = 0; i < vertCount; i++) {
    const b = i * 3;
    const proj = position[b] * ux + position[b + 1] * uy + position[b + 2] * uz;
    if (proj < minProj) minProj = proj;
  }

  const RAY_EPS = 1e-4;
  const CONTACT_EPS = 1e-3;
  let totalCost = 0;
  let contactArea = 0;

  for (let f = 0; f < triCount; f++) {
    const i0 = f * 9, i1 = i0 + 3, i2 = i0 + 6;

    const v0x = position[i0], v0y = position[i0 + 1], v0z = position[i0 + 2];
    const v1x = position[i1], v1y = position[i1 + 1], v1z = position[i1 + 2];
    const v2x = position[i2], v2y = position[i2 + 1], v2z = position[i2 + 2];

    const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
    const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
    const crx = e1y * e2z - e1z * e2y, cry = e1z * e2x - e1x * e2z, crz = e1x * e2y - e1y * e2x;
    const area = 0.5 * Math.sqrt(crx * crx + cry * cry + crz * crz);

    const p0 = v0x * ux + v0y * uy + v0z * uz;
    const p1 = v1x * ux + v1y * uy + v1z * uz;
    const p2 = v2x * ux + v2y * uy + v2z * uz;
    if (p0 - minProj < CONTACT_EPS && p1 - minProj < CONTACT_EPS && p2 - minProj < CONTACT_EPS) {
      contactArea += area;
    }

    const nAlongUp = normal[i0] * ux + normal[i0 + 1] * uy + normal[i0 + 2] * uz;
    if (leanAngleDegrees(nAlongUp) <= criticalAngleDeg) continue;

    const cx = (v0x + v1x + v2x) / 3, cy = (v0y + v1y + v2y) / 3, cz = (v0z + v1z + v2z) / 3;

    const plateHeight = cx * ux + cy * uy + cz * uz - minProj;
    let bestT = plateHeight;

    const ox = cx + ux * RAY_EPS, oy = cy + uy * RAY_EPS, oz = cz + uz * RAY_EPS;
    const dx = -ux, dy = -uy, dz = -uz;
    const occlusionT = raycastNearest(position, ox, oy, oz, dx, dy, dz, f);
    if (occlusionT < bestT) bestT = occlusionT;

    totalCost += area * Math.max(0, bestT);
  }

  return { cost: totalCost, contactArea };
}

export interface SearchResult {
  up: THREE.Vector3;
  cost: number;
  contactArea: number;
}

/** Coarse sphere search followed by local refinement around the best few
 * candidates. Synchronous and CPU-heavy — intended to run inside a Worker. */
export function searchBestOrientation(
  position: Float32Array,
  normal: Float32Array,
  options: SearchOptions,
): SearchResult {
  const {
    criticalAngleDeg,
    coarseSamples = DEFAULT_COARSE_SAMPLES,
    refineTopK = DEFAULT_REFINE_TOP_K,
    refineGridSize = DEFAULT_REFINE_GRID_SIZE,
    refineAngleRadiusDeg = DEFAULT_REFINE_ANGLE_RADIUS_DEG,
    onProgress,
  } = options;

  const stabilityWeight = STABILITY_WEIGHT_FRACTION * computeBoundingRadius(position);
  const compareCandidates = (a: OrientationCandidate, b: OrientationCandidate) =>
    scoreOf(a, stabilityWeight) - scoreOf(b, stabilityWeight);

  const rotation = randomRotation();
  const coarseDirs = [...AXIS_ALIGNED_DIRECTIONS, ...sampleSphere(coarseSamples)]
    .map((dir) => dir.clone().applyQuaternion(rotation));
  const totalSteps = coarseDirs.length + refineTopK * refineGridSize * refineGridSize;
  let done = 0;

  const candidates: OrientationCandidate[] = coarseDirs.map((up) => {
    const { cost, contactArea } = evaluateOrientationCost(position, normal, up, criticalAngleDeg);
    done++;
    onProgress?.(done / totalSteps);
    return { up, cost, contactArea };
  });

  candidates.sort(compareCandidates);
  const top = candidates.slice(0, refineTopK);

  for (const candidate of top) {
    for (const up of sampleCapAround(candidate.up, refineGridSize, refineAngleRadiusDeg)) {
      const { cost, contactArea } = evaluateOrientationCost(position, normal, up, criticalAngleDeg);
      candidates.push({ up, cost, contactArea });
      done++;
      onProgress?.(done / totalSteps);
    }
  }

  candidates.sort(compareCandidates);
  return candidates[0];
}
