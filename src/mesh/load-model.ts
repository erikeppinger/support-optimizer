import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

const loader = new STLLoader();

/** Cross-section clip plane, shared by the material below. The viewer
 * sweeps `clipPlane.constant` to reveal internal cavities — the material
 * is already double-sided, so a cut face shows the inner surface (cavity
 * walls included) directly, with no separate cap geometry needed. */
export const clipPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 1e6);

export const MESH_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  vertexColors: true,
  metalness: 0.1,
  roughness: 0.6,
  side: THREE.DoubleSide,
  clippingPlanes: [clipPlane],
});

/** Same look as MESH_MATERIAL but with no clipping planes — for the
 * side-by-side comparison ghost, which sits offset in world-space X well
 * outside the live mesh's own bounds. clipPlane is positioned relative to
 * ONLY the live mesh's bounding box, so sharing MESH_MATERIAL (and its
 * clip plane) would put the entire comparison mesh on the "clipped away"
 * side whenever it's offset far enough left — cross-section is a
 * current-model inspection tool, so the comparison ghost simply shouldn't
 * participate in it at all. */
export const COMPARISON_MESH_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  vertexColors: true,
  metalness: 0.1,
  roughness: 0.6,
  side: THREE.DoubleSide,
});

/** Centers the mesh over the origin in X/Y and rests its lowest point
 * exactly on the Z=0 build plate — the print axis can't go negative. */
export function placeOnBuildPlate(geometry: THREE.BufferGeometry) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const centerX = (box.max.x + box.min.x) / 2;
  const centerY = (box.max.y + box.min.y) / 2;
  geometry.translate(-centerX, -centerY, -box.min.z);
}

/** Wraps a finished (position+normal populated) geometry into a mesh with
 * the app's shared material, placed on the build plate — the common tail
 * end of both the STL and PDB→mesh loading paths. */
export function buildMeshFromGeometry(geometry: THREE.BufferGeometry): THREE.Mesh {
  placeOnBuildPlate(geometry);
  // No castShadow/receiveShadow: shadow mapping is disabled renderer-wide
  // (see scene-setup.ts for why), so these would be inert flags implying
  // an effect that isn't there.
  return new THREE.Mesh(geometry, MESH_MATERIAL);
}

export function parseSTL(buffer: ArrayBuffer): THREE.Mesh {
  const geometry = loader.parse(buffer);
  geometry.computeVertexNormals();
  return buildMeshFromGeometry(geometry);
}

export async function loadSTLFile(file: File): Promise<THREE.Mesh> {
  const buffer = await file.arrayBuffer();
  return parseSTL(buffer);
}

/** Wires drag-and-drop of a single .stl, .pdb, .cif, or .3mf file onto
 * `dropTarget`. Parsing itself is left to the caller (`onFile`) since STL
 * parsing is synchronous while PDB/mmCIF import needs a Worker round-trip
 * (voxelize + marching cubes) — this just owns the drag UI feedback and
 * the file-type gate. `onDragStateChange` toggles UI feedback. */
export function enableModelDragAndDrop(
  dropTarget: HTMLElement,
  onFile: (file: File) => void,
  onDragStateChange?: (active: boolean) => void,
  onError?: (message: string) => void,
) {
  let dragDepth = 0;

  dropTarget.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    onDragStateChange?.(true);
  });

  dropTarget.addEventListener("dragover", (e) => {
    e.preventDefault();
  });

  dropTarget.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) onDragStateChange?.(false);
  });

  dropTarget.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    onDragStateChange?.(false);

    const file = e.dataTransfer?.files?.[0];
    if (!file) return;

    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".stl") && !lower.endsWith(".pdb") && !lower.endsWith(".cif") && !lower.endsWith(".3mf")) {
      onError?.(`"${file.name}" is not a supported file (.stl, .pdb, .cif, or .3mf)`);
      return;
    }

    onFile(file);
  });
}
