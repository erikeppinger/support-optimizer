import * as THREE from "three";

/** Layer height (model units, i.e. mm as printed) the tool-change count is
 * estimated at — the common 0.2 mm default. The count scales with
 * 1/layer height, but which orientation needs fewest changes does not. */
export const TOOL_CHANGE_LAYER_HEIGHT = 0.2;

/** Most distinct colors tracked per layer (one bit each). */
const MAX_COLORS = 32;

/**
 * One color index per triangle of a non-indexed geometry, from its first
 * vertex's RGB (this app colors whole triangles). Null when there are fewer
 * than 2 colors — nothing to change tools between — or more than
 * MAX_COLORS.
 */
export function triangleColorIndices(vertexColors: Float32Array): { index: Uint8Array; colorCount: number } | null {
  const triCount = vertexColors.length / 9;
  const index = new Uint8Array(triCount);
  const ids = new Map<string, number>();
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const key = `${Math.round(vertexColors[o] * 255)},${Math.round(vertexColors[o + 1] * 255)},${Math.round(vertexColors[o + 2] * 255)}`;
    let id = ids.get(key);
    if (id === undefined) {
      if (ids.size === MAX_COLORS) return null;
      id = ids.size;
      ids.set(key, id);
    }
    index[t] = id;
  }
  return ids.size >= 2 ? { index, colorCount: ids.size } : null;
}

/**
 * Estimated tool changes to print the model with `up` as the build
 * direction. The model is cut into layers of `layerHeight`; a color is in a
 * layer when one of its triangles crosses it (a chain's surface bounds its
 * material, so surface presence means material presence). Each layer
 * prints its colors one after another, starting with the tool the previous
 * layer ended on when that color is present — how slicers order tools — so
 * a layer with k colors costs k − 1 changes, plus one when it does not
 * contain the previous layer's last tool.
 */
export function countToolChanges(
  position: Float32Array,
  triColor: Uint8Array,
  up: THREE.Vector3,
  layerHeight = TOOL_CHANGE_LAYER_HEIGHT,
): number {
  const ux = up.x, uy = up.y, uz = up.z;
  const triCount = triColor.length;
  let minProj = Infinity, maxProj = -Infinity;
  for (let i = 0; i < position.length; i += 3) {
    const p = position[i] * ux + position[i + 1] * uy + position[i + 2] * uz;
    if (p < minProj) minProj = p;
    if (p > maxProj) maxProj = p;
  }
  const layerCount = Math.max(1, Math.ceil((maxProj - minProj) / layerHeight));
  // Layer l spans [l·h, (l+1)·h); sampled at its middle, like a slicer.
  const masks = new Uint32Array(layerCount);
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const p0 = position[o] * ux + position[o + 1] * uy + position[o + 2] * uz - minProj;
    const p1 = position[o + 3] * ux + position[o + 4] * uy + position[o + 5] * uz - minProj;
    const p2 = position[o + 6] * ux + position[o + 7] * uy + position[o + 8] * uz - minProj;
    const lo = Math.min(p0, p1, p2), hi = Math.max(p0, p1, p2);
    const first = Math.max(0, Math.ceil(lo / layerHeight - 0.5));
    const last = Math.min(layerCount - 1, Math.floor(hi / layerHeight - 0.5));
    const bit = 1 << triColor[t];
    for (let l = first; l <= last; l++) masks[l] |= bit;
  }

  let changes = 0;
  let current = -1;
  for (let l = 0; l < layerCount; l++) {
    const mask = masks[l];
    if (mask === 0) continue;
    const k = popcount(mask);
    if (current < 0) {
      changes += k - 1;
    } else if (mask & (1 << current)) {
      changes += k - 1;
    } else {
      changes += k;
    }
    // The layer ends on its last tool: keep the current one if it is the
    // only color here, otherwise the highest other color present.
    if (k === 1 || current < 0 || !(mask & (1 << current))) current = 31 - Math.clz32(mask);
    else current = 31 - Math.clz32(mask & ~(1 << current));
  }
  return changes;
}

function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
