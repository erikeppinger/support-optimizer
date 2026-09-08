import * as THREE from "three";
import { createTextSprite } from "./text-sprite";

const AXIS_LENGTH = 30;

const AXES: Array<{ dir: THREE.Vector3; color: number; label: string }> = [
  { dir: new THREE.Vector3(1, 0, 0), color: 0xff5555, label: "X" },
  { dir: new THREE.Vector3(0, 1, 0), color: 0x55dd55, label: "Y" },
  { dir: new THREE.Vector3(0, 0, 1), color: 0x5599ff, label: "Z (up / print axis)" },
];

/** Colored arrows + text labels along +X/+Y/+Z at the origin, so the
 * build plate's orientation (and which axis is the print-up direction)
 * is legible at a glance. Always renders on top so it stays visible
 * regardless of what's in front of it. */
export function createAxesGizmo(): THREE.Group {
  const group = new THREE.Group();

  for (const { dir, color, label } of AXES) {
    const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), AXIS_LENGTH, color, AXIS_LENGTH * 0.18, AXIS_LENGTH * 0.1);
    (arrow.line.material as THREE.Material).depthTest = false;
    (arrow.cone.material as THREE.Material).depthTest = false;
    arrow.renderOrder = 998;
    group.add(arrow);

    const cssColor = `#${color.toString(16).padStart(6, "0")}`;
    const sprite = createTextSprite(label, cssColor);
    sprite.position.copy(dir).multiplyScalar(AXIS_LENGTH + 6);
    group.add(sprite);
  }

  return group;
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
