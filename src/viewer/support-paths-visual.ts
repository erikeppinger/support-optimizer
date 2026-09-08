import * as THREE from "three";
import type { SupportPathsResult } from "../geometry/support-paths";

const SUPPORT_COLOR = 0xffa726;

const SUPPORT_MATERIAL = new THREE.MeshStandardMaterial({ color: SUPPORT_COLOR, roughness: 0.5, metalness: 0.1 });

/** Renders each support path as a thin tube (readable at a glance,
 * distinct from the model's own overhang-colored surface). Radius scales
 * with the model so it looks reasonable at any import scale. */
export function buildSupportPathsGroup(result: SupportPathsResult, boundingRadius: number): THREE.Group {
  const group = new THREE.Group();
  const radius = Math.max(boundingRadius * 0.004, 1e-4);

  for (const path of result.paths) {
    if (path.points.length < 2) continue;
    const [a, b] = path.points;
    if (a.distanceTo(b) < 1e-9) continue;
    const curve = new THREE.LineCurve3(a, b);
    const tube = new THREE.TubeGeometry(curve, 1, radius, 6, false);
    group.add(new THREE.Mesh(tube, SUPPORT_MATERIAL));
  }

  return group;
}

export function disposeSupportPathsGroup(group: THREE.Group) {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
    }
  });
}
