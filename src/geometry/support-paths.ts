import * as THREE from "three";
import { leanAngleDegrees } from "./overhang-cost";
import { rayTriangleT } from "./raycast";

export interface SupportPath {
  points: THREE.Vector3[];
}

export interface SupportPathsResult {
  paths: SupportPath[];
  rootCount: number;
  totalLength: number;
}

/**
 * Three illustrative styles, all sharing the same underlying overhang
 * clustering and landing-raycast machinery below — see generateSupportPaths.
 * - "organic": roots follow the overhang's own shape and merge into
 *   branches as they descend toward the plate.
 * - "snug": the same shape-following roots as "organic", but each drawn
 *   as its own independent straight vertical column instead of merging.
 * - "grid": roots snapped to a regular lattice instead of the overhang's
 *   own shape, each its own straight vertical column.
 */
export type SupportStyle = "organic" | "snug" | "grid";

export interface SupportPathOptions {
  /** Overhang points within this many buckets get clustered into one
   * root, and roots within it get considered for branch-merging. Given
   * as a fraction of the model's bounding radius. */
  bucketSizeFraction?: number;
  mergeRadiusFraction?: number;
  /** How far each merge step drops toward the plate, as a fraction of
   * bounding radius — controls how "branchy" vs. how "tall the trunk
   * is before merging" the tree looks. */
  mergeDropFraction?: number;
  maxRoots?: number;
  style?: SupportStyle;
}

const DEFAULTS = {
  bucketSizeFraction: 0.04,
  mergeRadiusFraction: 0.12,
  mergeDropFraction: 0.05,
  maxRoots: 200,
  style: "organic" as SupportStyle,
};

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

interface Root {
  position: THREE.Vector3;
  area: number;
  landing: THREE.Vector3;
  landingHeight: number;
}

/**
 * Illustrative support paths (see SupportStyle for the three styles): NOT
 * a real support generator or slicer simulation, just a plausible-looking
 * visualization of where supports would roughly go, for UI comparison
 * purposes.
 *
 * Overhang face centroids are always clustered into a manageable number
 * of "roots" (grid-bucketed, area-weighted) the same way regardless of
 * style. "organic" and "snug" anchor each root to the real triangle
 * centroid nearest its bucket's weighted average, tightly following the
 * overhang's own shape; "grid" instead anchors each root to its bucket's
 * regular lattice cell center, raycasting down from above the model to
 * find whatever real surface point sits there. Either way, each root is
 * then raycast straight down to find its landing point (build plate, or
 * another part of the mesh if one occludes it first — bridging).
 *
 * For "organic" only, roots that land on the plate get greedily merged
 * pairwise by proximity as they "descend" toward it, approximating how
 * tree supports fuse into fewer trunks near the bed — each merge step's
 * own connecting segments are kept within `criticalAngleDeg` of vertical
 * (skipping a pair rather than joining them at a shallower, unprintable
 * angle), the same limit applied to the model's own overhangs, since a
 * support branch is printed the same way the part is; roots landing
 * elsewhere (bridging onto the model itself) are drawn as independent
 * straight (always vertical, always printable) segments regardless of
 * style, since merging only makes geometric sense between branches
 * heading to the same target. "snug" and "grid" skip merging entirely —
 * every root gets its own independent straight column.
 */
export function generateSupportPaths(
  position: Float32Array,
  normal: Float32Array,
  up: THREE.Vector3,
  criticalAngleDeg: number,
  options: SupportPathOptions = {},
): SupportPathsResult {
  const {
    bucketSizeFraction = DEFAULTS.bucketSizeFraction,
    mergeRadiusFraction = DEFAULTS.mergeRadiusFraction,
    mergeDropFraction = DEFAULTS.mergeDropFraction,
    maxRoots = DEFAULTS.maxRoots,
    style = DEFAULTS.style,
  } = options;

  const boundingRadius = computeBoundingRadius(position);
  const bucketSize = Math.max(boundingRadius * bucketSizeFraction, 1e-6);
  const mergeRadius = boundingRadius * mergeRadiusFraction;
  const mergeDrop = boundingRadius * mergeDropFraction;

  const ux = up.x, uy = up.y, uz = up.z;
  const vertCount = position.length / 3;
  const triCount = vertCount / 3;

  // Orthonormal basis spanning the plane perpendicular to `up`, for
  // bucketing overhang points into a 2D grid.
  const arbitrary = Math.abs(uz) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const uAxis = new THREE.Vector3().crossVectors(arbitrary, up).normalize();
  const vAxis = new THREE.Vector3().crossVectors(up, uAxis).normalize();

  // minProj (height) plus u/vOrigin anchor the bucket grid to this mesh's
  // OWN bounds rather than the world origin — otherwise two copies of the
  // same shape at different world positions (e.g. the before/after
  // comparison view) can bucket differently: an absolute grid falls on
  // different fractional offsets relative to each copy's own features,
  // occasionally splitting/merging clusters differently near a boundary
  // and skewing the very "before vs after" stats this is meant to show.
  // maxProj (only needed for "grid" style, to start its downward
  // find-the-real-surface raycast from safely above everything) is
  // tracked alongside for the same reason minProj is: cheap to get in
  // the same pass, and anchored to this mesh's own bounds.
  let minProj = Infinity, maxProj = -Infinity, uOrigin = Infinity, vOrigin = Infinity;
  for (let i = 0; i < vertCount; i++) {
    const b = i * 3;
    const x = position[b], y = position[b + 1], z = position[b + 2];
    const proj = x * ux + y * uy + z * uz;
    if (proj < minProj) minProj = proj;
    if (proj > maxProj) maxProj = proj;
    const uCoord = x * uAxis.x + y * uAxis.y + z * uAxis.z;
    if (uCoord < uOrigin) uOrigin = uCoord;
    const vCoord = x * vAxis.x + y * vAxis.y + z * vAxis.z;
    if (vCoord < vOrigin) vOrigin = vCoord;
  }

  // Bucket overhang triangle centroids (area-weighted) by (u,v) cell.
  // `anchor` is filled in by the second pass below: the real triangle
  // centroid nearest this bucket's area-weighted average. `gx`/`gy` (the
  // cell's own integer grid coordinates, parsed once from its key) are
  // only used by "grid" style, to anchor a root at the cell's center
  // instead of at `anchor`.
  interface Bucket { sumPos: THREE.Vector3; sumArea: number; anchor: THREE.Vector3; anchorDistSq: number; gx: number; gy: number; }
  const buckets = new Map<string, Bucket>();
  const p = new THREE.Vector3();

  /** Runs `visit` over every overhang triangle's centroid and its bucket
   * key — the exact same selection/area test both passes need, kept in one
   * place so they can never disagree about which triangles count. */
  function forEachOverhangCentroid(visit: (key: string, cx: number, cy: number, cz: number, area: number) => void) {
    for (let f = 0; f < triCount; f++) {
      const i0 = f * 9, i1 = i0 + 3, i2 = i0 + 6;
      const nAlongUp = normal[i0] * ux + normal[i0 + 1] * uy + normal[i0 + 2] * uz;
      if (leanAngleDegrees(nAlongUp) <= criticalAngleDeg) continue;

      const v0x = position[i0], v0y = position[i0 + 1], v0z = position[i0 + 2];
      const v1x = position[i1], v1y = position[i1 + 1], v1z = position[i1 + 2];
      const v2x = position[i2], v2y = position[i2 + 1], v2z = position[i2 + 2];

      const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
      const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
      const crx = e1y * e2z - e1z * e2y, cry = e1z * e2x - e1x * e2z, crz = e1x * e2y - e1y * e2x;
      const area = 0.5 * Math.sqrt(crx * crx + cry * cry + crz * crz);
      if (area < 1e-12) continue;

      const cx = (v0x + v1x + v2x) / 3, cy = (v0y + v1y + v2y) / 3, cz = (v0z + v1z + v2z) / 3;
      p.set(cx, cy, cz);
      const uCoord = p.dot(uAxis) - uOrigin, vCoord = p.dot(vAxis) - vOrigin;
      visit(`${Math.round(uCoord / bucketSize)},${Math.round(vCoord / bucketSize)}`, cx, cy, cz, area);
    }
  }

  forEachOverhangCentroid((key, cx, cy, cz, area) => {
    let bucket = buckets.get(key);
    if (!bucket) {
      const [gx, gy] = key.split(",").map(Number);
      bucket = { sumPos: new THREE.Vector3(), sumArea: 0, anchor: new THREE.Vector3(), anchorDistSq: Infinity, gx, gy };
      buckets.set(key, bucket);
    }
    bucket.sumPos.addScaledVector(p.set(cx, cy, cz), area);
    bucket.sumArea += area;
  });

  // Second pass: snap each bucket to a REAL triangle centroid — the one
  // closest to its area-weighted average. The average itself is a mean of
  // scattered points, so on a bumpy surface (a molecular surface
  // especially) it can land in the empty space between lobes rather than
  // on the surface at all — which drew a support branch visibly starting
  // in mid-air, touching nothing. A triangle centroid is by construction
  // always exactly on the surface, so anchoring there keeps every branch
  // rooted on real geometry while staying in the same place the weighted
  // average was pointing at.
  const bucketAverage = new THREE.Vector3();
  for (const bucket of buckets.values()) {
    bucketAverage.copy(bucket.sumPos).divideScalar(bucket.sumArea);
    bucket.anchor.copy(bucketAverage); // fallback; overwritten below
  }
  forEachOverhangCentroid((key, cx, cy, cz) => {
    const bucket = buckets.get(key);
    if (!bucket) return;
    bucketAverage.copy(bucket.sumPos).divideScalar(bucket.sumArea);
    const dx = cx - bucketAverage.x, dy = cy - bucketAverage.y, dz = cz - bucketAverage.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < bucket.anchorDistSq) {
      bucket.anchorDistSq = distSq;
      bucket.anchor.set(cx, cy, cz);
    }
  });

  let bucketList = Array.from(buckets.values());
  if (bucketList.length > maxRoots) {
    bucketList = bucketList.sort((a, b) => b.sumArea - a.sumArea).slice(0, maxRoots);
  }

  // Landing rays always travel straight along `up`, so a ray's (u,v)
  // coordinate never changes along its length — only triangles whose (u,v)
  // footprint actually contains that fixed point can ever be hit,
  // regardless of how far the ray travels. Binning every triangle by the
  // grid cell(s) its own (u,v) bounding box overlaps turns each landing
  // query from an O(triangles) brute-force scan into O(candidates in one
  // cell): a root's query cell is looked up directly (no neighbor search
  // needed) because a triangle was inserted into every cell its bbox
  // touches at build time, so if the query point truly falls inside a
  // triangle's footprint, that triangle is guaranteed to already be listed
  // under the query point's own cell.
  const cellTriangles = new Map<string, number[]>();
  for (let f = 0; f < triCount; f++) {
    const i0 = f * 9, i1 = i0 + 3, i2 = i0 + 6;
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const vi of [i0, i1, i2]) {
      const x = position[vi], y = position[vi + 1], z = position[vi + 2];
      const u = x * uAxis.x + y * uAxis.y + z * uAxis.z - uOrigin;
      const v = x * vAxis.x + y * vAxis.y + z * vAxis.z - vOrigin;
      if (u < uMin) uMin = u; if (u > uMax) uMax = u;
      if (v < vMin) vMin = v; if (v > vMax) vMax = v;
    }
    const cxMin = Math.floor(uMin / bucketSize), cxMax = Math.floor(uMax / bucketSize);
    const cyMin = Math.floor(vMin / bucketSize), cyMax = Math.floor(vMax / bucketSize);
    for (let cx = cxMin; cx <= cxMax; cx++) {
      for (let cy = cyMin; cy <= cyMax; cy++) {
        const key = `${cx},${cy}`;
        let list = cellTriangles.get(key);
        if (!list) { list = []; cellTriangles.set(key, list); }
        list.push(f);
      }
    }
  }

  /** Nearest downward hit among only the triangles binned under (u,v)'s
   * own cell — see cellTriangles above for why that's already complete. */
  function raycastNearestIndexed(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, u: number, v: number): number {
    const key = `${Math.floor(u / bucketSize)},${Math.floor(v / bucketSize)}`;
    const candidates = cellTriangles.get(key);
    if (!candidates) return Infinity;
    let best = Infinity;
    for (const g of candidates) {
      const j0 = g * 9, j1 = j0 + 3, j2 = j0 + 6;
      const t = rayTriangleT(
        ox, oy, oz, dx, dy, dz,
        position[j0], position[j0 + 1], position[j0 + 2],
        position[j1], position[j1 + 1], position[j1 + 2],
        position[j2], position[j2 + 1], position[j2 + 2],
      );
      if (t !== null && t < best) best = t;
    }
    return best;
  }

  // `rootPos` is an area-weighted average of several overhang triangle
  // centroids, so — unlike evaluateOrientationCost's per-triangle
  // raycasting, which offsets from and excludes one known face — it has
  // no single "own" triangle to skip, and typically sits right at (not
  // above) the local surface. A fixed tiny epsilon isn't reliably larger
  // than that local surface's own scale (especially after a coarse
  // marching-cubes remesh, whose triangle "steps" can be comparable to
  // or bigger than a fixed 1e-4), so the ray can immediately re-hit a
  // neighboring triangle of the same patch and report a near-zero
  // "landing" a few units away from any real support gap. Scaling the
  // offset to the bucket size (the local clustering scale) and treating
  // any hit closer than that as self-intersection noise — falling back
  // to the plate distance instead — fixes it robustly rather than
  // depending on tuning one fragile constant.
  const RAY_EPS = bucketSize * 0.5;
  const MIN_LANDING_T = bucketSize;
  const LANDING_TOLERANCE = boundingRadius * 0.02;

  /** Shared by every style: raycast straight down from `rootPos` (assumed
   * already ON the real surface) to find its landing point. */
  function buildRootFromPosition(rootPos: THREE.Vector3, sumArea: number): Root {
    const ox = rootPos.x + ux * RAY_EPS, oy = rootPos.y + uy * RAY_EPS, oz = rootPos.z + uz * RAY_EPS;
    const rootU = rootPos.dot(uAxis) - uOrigin, rootV = rootPos.dot(vAxis) - vOrigin;
    const t = raycastNearestIndexed(ox, oy, oz, -ux, -uy, -uz, rootU, rootV);
    const validT = Number.isFinite(t) && t > MIN_LANDING_T ? t : Infinity;
    const plateHeight = rootPos.dot(up) - minProj;
    const landingT = validT < plateHeight ? validT : plateHeight;
    const landing = rootPos.clone().addScaledVector(up, -landingT);
    return { position: rootPos, area: sumArea, landing, landingHeight: landing.dot(up) };
  }

  let roots: Root[];
  if (style === "grid") {
    // Anchor each root to its bucket's regular lattice cell CENTER
    // instead of a real overhang centroid — cast down from safely above
    // the whole model to find whatever real surface sits there (not
    // necessarily an overhang face itself, just wherever this grid
    // column would actually touch the part). A cell with no surface
    // directly under its exact center (possible even though the cell
    // contains overhang triangles off-center) is skipped rather than
    // drawing a column floating in mid-air.
    const topMargin = boundingRadius * 0.02;
    roots = bucketList.flatMap(({ gx, gy, sumArea }): Root[] => {
      const realU = gx * bucketSize, realV = gy * bucketSize;
      const top = new THREE.Vector3()
        .addScaledVector(uAxis, uOrigin + realU)
        .addScaledVector(vAxis, vOrigin + realV)
        .addScaledVector(up, maxProj + topMargin);
      const tTouch = raycastNearestIndexed(top.x, top.y, top.z, -ux, -uy, -uz, realU, realV);
      if (!Number.isFinite(tTouch)) return [];
      const rootPos = top.clone().addScaledVector(up, -tTouch);
      return [buildRootFromPosition(rootPos, sumArea)];
    });
  } else {
    roots = bucketList.map(({ anchor, sumArea }) => buildRootFromPosition(anchor.clone(), sumArea));
  }

  const paths: SupportPath[] = [];
  let totalLength = 0;
  function addSegment(a: THREE.Vector3, b: THREE.Vector3) {
    paths.push({ points: [a.clone(), b.clone()] });
    totalLength += a.distanceTo(b);
  }

  if (style !== "organic") {
    // "snug"/"grid" never merge — every root, plate-landing or bridging
    // alike, is just its own independent straight column from root to
    // landing (always vertical-or-bridging, so always within any
    // positive angle limit without needing the constraint machinery
    // below at all).
    for (const r of roots) addSegment(r.position, r.landing);
    return { paths, rootCount: roots.length, totalLength };
  }

  const plateRoots = roots.filter((r) => Math.abs(r.landingHeight - minProj) <= LANDING_TOLERANCE);
  const bridgeRoots = roots.filter((r) => Math.abs(r.landingHeight - minProj) > LANDING_TOLERANCE);

  for (const r of bridgeRoots) addSegment(r.position, r.landing);

  interface Tip { pos: THREE.Vector3; height: number; }
  const active: Tip[] = plateRoots.map((r) => ({ pos: r.position.clone(), height: r.position.dot(up) }));

  // Reusing the model's own critical overhang angle here: a support
  // branch is printed the same way the part is, so the same physical
  // limit on how far something can lean before it needs support under
  // IT applies to the branch's own material too. A merge step's two new
  // stems (tip -> merged midpoint) both run the same horizontal distance
  // (half the gap between the tips) over whichever tip's own vertical
  // drop is smaller — left unconstrained, a merge between two tips near
  // the far edge of mergeRadius can demand a much shallower angle than
  // that, especially with a small mergeDrop. requiredDropForAngle is the
  // minimum vertical drop that keeps a given horizontal run within the
  // limit; merges use at least that much (more than the nominal
  // mergeDrop only when actually needed).
  const maxBranchAngleRad = (criticalAngleDeg * Math.PI) / 180;
  function requiredDropForAngle(horizontalRun: number): number {
    return horizontalRun / Math.tan(maxBranchAngleRad);
  }

  while (active.length > 1) {
    // All pairs within mergeRadius, closest first — tried in that order
    // so the greedy "merge the nearest pair" behavior is unchanged
    // whenever the angle constraint isn't binding (the common case).
    const candidates: Array<{ i: number; j: number }> = [];
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        if (active[i].pos.distanceTo(active[j].pos) <= mergeRadius) candidates.push({ i, j });
      }
    }
    if (candidates.length === 0) break;
    candidates.sort((p, q) => active[p.i].pos.distanceTo(active[p.j].pos) - active[q.i].pos.distanceTo(active[q.j].pos));

    let mergedThisRound = false;
    for (const { i, j } of candidates) {
      const a = active[i], b = active[j];
      const heightDiff = a.height - b.height;
      const horizDist = Math.sqrt(Math.max(0, a.pos.distanceToSquared(b.pos) - heightDiff * heightDiff));
      const effectiveDrop = Math.max(mergeDrop, requiredDropForAngle(horizDist / 2));
      const idealNewHeight = Math.min(a.height, b.height) - effectiveDrop;
      // Satisfying the angle would need to drop past the plate — rather
      // than emit an over-angle segment, leave this pair unmerged this
      // round and try the next-closest candidate; if none qualify, both
      // fall through to the final loop below and route to the plate
      // independently (always a straight vertical drop, so always within
      // any positive angle limit).
      if (idealNewHeight < minProj - 1e-9) continue;

      const newHeight = Math.max(minProj, idealNewHeight);
      const mergedPos = a.pos.clone().add(b.pos).multiplyScalar(0.5);
      mergedPos.addScaledVector(up, newHeight - mergedPos.dot(up));

      addSegment(a.pos, mergedPos);
      addSegment(b.pos, mergedPos);

      const rest = active.filter((_, idx) => idx !== i && idx !== j);
      if (newHeight <= minProj + 1e-6) {
        active.length = 0;
        active.push(...rest);
      } else {
        active.length = 0;
        active.push(...rest, { pos: mergedPos, height: newHeight });
      }
      mergedThisRound = true;
      break;
    }
    if (!mergedThisRound) break;
  }

  for (const tip of active) {
    if (tip.height <= minProj + 1e-6) continue;
    const plateProjection = tip.pos.clone().addScaledVector(up, minProj - tip.height);
    addSegment(tip.pos, plateProjection);
  }

  return { paths, rootCount: roots.length, totalLength };
}
