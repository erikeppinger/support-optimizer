import * as THREE from "three";

export const DEFAULT_CRITICAL_ANGLE_DEG = 45;

// Exported as plain hex, not just the THREE.Color instances below, so the
// UI (main.ts's overhang legend) can put the exact same colors in a CSS
// swatch without redeclaring them — one source of truth for what "the
// overhang colors" actually are.
export const SAFE_COLOR_HEX = 0x8899ee;
export const OVERHANG_COLOR_HEX = 0xe23b3b;
const SAFE_COLOR = new THREE.Color(SAFE_COLOR_HEX);
const OVERHANG_COLOR = new THREE.Color(OVERHANG_COLOR_HEX);

/** Degrees a face leans past vertical, from its normal's Z component.
 * 0 = vertical wall (self-supporting), 90 = flat downward overhang
 * (worst case). Upward-facing normals clamp to 0 (never an overhang). */
export function leanAngleDegrees(normalZ: number): number {
  const clamped = Math.max(-1, Math.min(1, -normalZ));
  return Math.max(0, Math.asin(clamped) * (180 / Math.PI));
}

/**
 * Colors each triangle red where it overhangs past `criticalAngleDeg` from
 * vertical. Reads per-face normals from `geometry.attributes.normal`, so
 * the geometry must be non-indexed with flat (unshared) vertex normals —
 * true for STL-loaded geometry after `computeVertexNormals()`, since no
 * vertices are shared between triangles.
 */
export function applyOverhangColors(
  geometry: THREE.BufferGeometry,
  criticalAngleDeg: number,
): void {
  const normal = geometry.attributes.normal;
  const count = normal.count;

  let colorAttr = geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
  if (!colorAttr || colorAttr.count !== count) {
    colorAttr = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    geometry.setAttribute("color", colorAttr);
  }

  for (let i = 0; i < count; i++) {
    const overhang = leanAngleDegrees(normal.getZ(i)) > criticalAngleDeg;
    const c = overhang ? OVERHANG_COLOR : SAFE_COLOR;
    colorAttr.setXYZ(i, c.r, c.g, c.b);
  }
  colorAttr.needsUpdate = true;
}

/**
 * Like applyOverhangColors, but starting from a per-vertex base color
 * (typically per-chain subunit coloring) instead of a flat safe/overhang
 * pair: a safe face keeps its base color exactly, an overhang face gets
 * the SAME pure OVERHANG_COLOR the plain (non-subunit) overhang view
 * uses — not blended with the chain color underneath it.
 *
 * A blended version was tried first (mixing OVERHANG_COLOR into the base
 * color rather than replacing it, so a face's chain stayed visually
 * traceable even while flagged) but proved hard to actually see: several
 * chain colors sit close enough to the overhang red in hue or lightness
 * that a partial mix toward it barely changes their appearance, so
 * "needs support" stopped reading as a reliable signal for exactly the
 * chains it needs to be reliable for. Using the identical, un-mixed red
 * every other overhang view in the app already uses trades "which chain
 * is this overhang on" (still inferable from context — the surrounding
 * safe faces keep their real chain color right up to the boundary) for
 * an unambiguous, always-visible flag.
 *
 * `baseColor` and `geometry`'s vertex count must agree (both indexed the
 * same way position/normal are) — the caller's responsibility, same as
 * applyOverhangColors' own precondition on `normal`.
 */
export function applySubunitColorsWithOverhangHighlight(
  geometry: THREE.BufferGeometry,
  baseColor: Float32Array,
  criticalAngleDeg: number,
): void {
  const normal = geometry.attributes.normal;
  const count = normal.count;
  const out = new Float32Array(baseColor.length);

  for (let i = 0; i < count; i++) {
    const overhang = leanAngleDegrees(normal.getZ(i)) > criticalAngleDeg;
    const b = i * 3;
    if (overhang) {
      out[b] = OVERHANG_COLOR.r;
      out[b + 1] = OVERHANG_COLOR.g;
      out[b + 2] = OVERHANG_COLOR.b;
    } else {
      out[b] = baseColor[b];
      out[b + 1] = baseColor[b + 1];
      out[b + 2] = baseColor[b + 2];
    }
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(out, 3));
}
