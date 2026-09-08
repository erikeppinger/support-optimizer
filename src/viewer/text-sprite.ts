import * as THREE from "three";

export interface TextSpriteOptions {
  fontPx?: number;
  canvasWidth?: number;
  canvasHeight?: number;
  scaleWidth?: number;
  scaleHeight?: number;
  textAlign?: CanvasTextAlign;
}

/** A billboard text label (always faces the camera, renders on top of
 * everything) — shared by the axes gizmo and the before/after comparison
 * view's "Start" / "Optimized" captions. */
export function createTextSprite(text: string, cssColor: string, options: TextSpriteOptions = {}): THREE.Sprite {
  const {
    fontPx = 40,
    canvasWidth = 256,
    canvasHeight = 64,
    scaleWidth = 20,
    scaleHeight = 5,
    textAlign = "left",
  } = options;

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
  ctx.fillStyle = cssColor;
  ctx.textAlign = textAlign;
  ctx.textBaseline = "middle";
  const x = textAlign === "center" ? canvas.width / 2 : 4;
  ctx.fillText(text, x, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(scaleWidth, scaleHeight, 1);
  sprite.renderOrder = 999;
  return sprite;
}
