import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createAxesGizmo } from "./axes-gizmo";

export interface Scene3D {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  axesGizmo: THREE.Group;
  buildPlate: THREE.GridHelper;
}

/** The grid's own baked geometry is a fixed 200x200 divided into 20 cells
 * — for a model bigger than that (a large multi-chain complex easily
 * exceeds 200mm), or a comparison view whose "start" ghost sits offset
 * well outside it, the plate visually reads as too small/model-off-the-
 * bed even though the camera frames everything correctly. Uniformly
 * scaling the whole helper (same trick scaleAxesGizmo uses) keeps the
 * grid's cell density constant and just resizes it to comfortably contain
 * `targetSize`. */
const BUILD_PLATE_BASE_SIZE = 200;

export function scaleBuildPlate(buildPlate: THREE.GridHelper, targetSize: number) {
  buildPlate.scale.setScalar(Math.max(1, targetSize / BUILD_PLATE_BASE_SIZE));
}

export function setupScene(container: HTMLElement): Scene3D {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1e);

  // Z is the print/build axis (matches STL convention and the overhang
  // math, which classifies faces against +Z), not Three.js's default Y-up.
  const camera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    0.1,
    2000,
  );
  camera.up.set(0, 0, 1);
  camera.position.set(80, 80, 80);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  // Shadow mapping is deliberately OFF. A DirectionalLight's shadow camera
  // is a fixed-size orthographic box (±5 world units by default) that does
  // not track the model — and models here are routinely 100-200mm across,
  // so only a small square patch of the surface fell inside it, rendering
  // as a visible hard-edged rectangle of self-shadowing acne on an
  // otherwise clean surface. Sizing the shadow camera to the model on
  // every load/scale/optimize would fix that, but self-shadowing adds very
  // little to a molecular surface that already reads well from diffuse
  // shading alone — and standard molecular viewers (PyMOL, ChimeraX) do
  // not shadow-map by default either.
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x2a2a2e, 1.0);
  hemi.position.set(0, 0, 1);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(60, 40, 100);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xaac8ff, 0.6);
  fill.position.set(-60, -40, 20);
  scene.add(fill);

  // Build plate grid in the XY plane at Z=0 (GridHelper defaults to XZ).
  const buildPlate = new THREE.GridHelper(BUILD_PLATE_BASE_SIZE, 20, 0x444444, 0x2a2a2a);
  buildPlate.rotation.x = Math.PI / 2;
  scene.add(buildPlate);

  const axesGizmo = createAxesGizmo();
  scene.add(axesGizmo);

  const resizeObserver = new ResizeObserver(() => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  });
  resizeObserver.observe(container);

  // Rendering unconditionally at full display refresh rate (60Hz+) even
  // when the camera is sitting still and nothing changed keeps the GPU
  // continuously busy for no visual benefit — noticeable in the desktop
  // build, where WebView2 has no browser-tab throttling to fall back on.
  // A full "render only when something actually changed" fix would need
  // every scene-mutating call site across main.ts (recolor, highlights,
  // clip plane, mesh swaps, …) to flag it, which is a lot of places to
  // get right in one pass — miss one and that change silently doesn't
  // appear until the next camera drag. Throttling the IDLE rate instead
  // is lower-risk: still genuinely continuous, just far less often, so
  // nothing can ever go stale — it only ever adds a little latency
  // (at most one idle interval) before a non-camera change shows up.
  const IDLE_FPS = 10;
  const IDLE_INTERVAL_MS = 1000 / IDLE_FPS;
  let lastRenderTime = -Infinity;

  function tick(now: number) {
    // OrbitControls.update() returns true while a drag or damping
    // inertia is actively moving the camera — the one case that needs
    // every frame, so it always renders regardless of the idle interval.
    const cameraMoving = controls.update();
    if (cameraMoving || now - lastRenderTime >= IDLE_INTERVAL_MS) {
      renderer.render(scene, camera);
      lastRenderTime = now;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  return { scene, camera, renderer, controls, axesGizmo, buildPlate };
}

export function frameObject(
  objects: THREE.Object3D | THREE.Object3D[],
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
) {
  const list = Array.isArray(objects) ? objects : [objects];
  const box = new THREE.Box3();
  for (const object of list) box.union(new THREE.Box3().setFromObject(object));
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z);
  const fitDist = maxDim / (2 * Math.tan((Math.PI * camera.fov) / 360));

  const direction = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(center.clone().add(direction.multiplyScalar(fitDist * 1.5)));
  camera.near = fitDist / 100;
  camera.far = fitDist * 100;
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.update();
}
