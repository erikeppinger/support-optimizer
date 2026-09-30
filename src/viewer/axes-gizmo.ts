import * as THREE from "three";
import { createTextSprite } from "./text-sprite";

const AXIS_LENGTH = 30;

// Default: the conventional red/green/blue-per-axis look. Red and green
// together, on the same two axes most likely to sit close on screen, is
// one of the specific pairings red-green color vision deficiency (by far
// the most common type) can't reliably tell apart — see
// setAxesGizmoColorMode / the "Colorblind-safe colors" toggle in main.ts.
const DEFAULT_AXES = [0xff5555, 0x55dd55, 0x5599ff];
// Okabe-Ito orange/reddish-purple/sky-blue — same colorblind-safe family
// used elsewhere in the app (CHAIN_PALETTES, overhang-cost's colorblind
// mode) wherever the toggle is on, pairwise distinguishable under every
// common form of color vision deficiency, not just red-green.
const COLORBLIND_AXES = [0xe69f00, 0xcc79a7, 0x56b4e9];

const AXES: Array<{ dir: THREE.Vector3; label: string }> = [
  { dir: new THREE.Vector3(1, 0, 0), label: "X" },
  { dir: new THREE.Vector3(0, 1, 0), label: "Y" },
  { dir: new THREE.Vector3(0, 0, 1), label: "Z (up / print axis)" },
];

/** Colored arrows + text labels along +X/+Y/+Z at the origin, so the
 * build plate's orientation (and which axis is the print-up direction)
 * is legible at a glance. Always renders on top so it stays visible
 * regardless of what's in front of it.
 *
 * A label's color is baked into its own canvas texture at creation time
 * (see createTextSprite) — there's no material property to flip later —
 * so switching color sets means building a whole new gizmo (see
 * disposeAxesGizmo) rather than updating this one in place. Cheap either
 * way: 3 arrows plus 3 small canvas sprites, only ever rebuilt on an
 * explicit, rare user toggle. */
export function createAxesGizmo(colorblindSafe = false): THREE.Group {
  const group = new THREE.Group();
  const colors = colorblindSafe ? COLORBLIND_AXES : DEFAULT_AXES;

  AXES.forEach(({ dir, label }, i) => {
    const color = colors[i];
    const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), AXIS_LENGTH, color, AXIS_LENGTH * 0.18, AXIS_LENGTH * 0.1);
    (arrow.line.material as THREE.Material).depthTest = false;
    (arrow.cone.material as THREE.Material).depthTest = false;
    arrow.renderOrder = 998;
    group.add(arrow);

    const cssColor = `#${color.toString(16).padStart(6, "0")}`;
    const sprite = createTextSprite(label, cssColor);
    sprite.position.copy(dir).multiplyScalar(AXIS_LENGTH + 6);
    group.add(sprite);
  });

  return group;
}

/** Frees every GPU resource a gizmo built by createAxesGizmo holds —
 * arrow line/cone geometries+materials, and each label sprite's own
 * canvas texture+material — so swapping color sets (remove old, dispose,
 * create+add new) doesn't leak. */
export function disposeAxesGizmo(gizmo: THREE.Group) {
  gizmo.traverse((obj) => {
    if (obj instanceof THREE.ArrowHelper) {
      obj.line.geometry.dispose();
      (obj.line.material as THREE.Material).dispose();
      obj.cone.geometry.dispose();
      (obj.cone.material as THREE.Material).dispose();
    } else if (obj instanceof THREE.Sprite) {
      const material = obj.material as THREE.SpriteMaterial;
      material.map?.dispose();
      material.dispose();
    }
  });
}

/** Rescales the gizmo so its arrows read as "roughly as big as the
 * model" regardless of the loaded mesh's units — a fixed size would
 * dwarf a small part (or vanish next to a large one). */
export function scaleAxesGizmo(gizmo: THREE.Group, targetArrowLength: number) {
  gizmo.scale.setScalar(targetArrowLength / AXIS_LENGTH);
}

/** Tucks the gizmo into the -X/-Y corner of `box` instead of sitting at
 * the world origin (which, for a model centered over the build plate via
 * placeOnBuildPlate, means directly on/under the model — exactly what a
 * corner-anchored indicator is meant to avoid). The arrows point in their
 * own +X/+Y/+Z directions from the gizmo's origin, so the origin is placed
 * one full (scaled) arrow-length-plus-gap short of the box's own corner —
 * that way the arrow TIPS land just outside the box, never crossing into
 * it, rather than the arrows starting at the corner and reaching inward
 * across the model. */
export function positionAxesGizmoAtCorner(gizmo: THREE.Group, box: THREE.Box3, worldArrowLength: number) {
  const gap = worldArrowLength * 0.15;
  const offset = worldArrowLength + gap;
  gizmo.position.set(box.min.x - offset, box.min.y - offset, 0);
}
