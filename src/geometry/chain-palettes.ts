export type RGB = [number, number, number];

export type ChainPaletteId = "default" | "okabe-ito" | "tol-muted" | "viridis";

const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

/** Linearly interpolates `count` evenly-spaced samples across a sequence
 * of anchor colors — used for Viridis below, which is normally defined by
 * a much larger reference lookup table than is worth reproducing exactly
 * for a discrete, per-chain qualitative use. */
function interpolatePalette(anchors: RGB[], count: number): RGB[] {
  const result: RGB[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const scaled = t * (anchors.length - 1);
    const idx = Math.min(anchors.length - 2, Math.floor(scaled));
    const frac = scaled - idx;
    const a = anchors[idx], b = anchors[idx + 1];
    result.push([a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac, a[2] + (b[2] - a[2]) * frac]);
  }
  return result;
}

// Deliberately avoids saturated pure red/blue, which the app already uses
// for overhang-safe/overhang-risk coloring in the other color view.
const DEFAULT_PALETTE: RGB[] = [
  hex(0xf2a53d), hex(0x4fc39a), hex(0xb07ae0), hex(0xe07aa8),
  hex(0x6aa8e0), hex(0xd0c04a), hex(0xe08a5a), hex(0x7ac45a),
  hex(0xa08a6a), hex(0x5ad4d0), hex(0xc47a4a), hex(0x9a9ae0),
];

// Okabe & Ito (2008) — the standard colorblind-safe qualitative palette,
// designed to stay distinguishable under all common forms of color vision
// deficiency (protanopia, deuteranopia, tritanopia). The canonical set
// also includes black; omitted here since it would be nearly invisible
// against this app's own dark viewer background rather than because it
// isn't part of the real palette.
const OKABE_ITO_PALETTE: RGB[] = [
  hex(0xe69f00), // orange
  hex(0x56b4e9), // sky blue
  hex(0x009e73), // bluish green
  hex(0xf0e442), // yellow
  hex(0x0072b2), // blue
  hex(0xd55e00), // vermillion
  hex(0xcc79a7), // reddish purple
];

// Paul Tol's "muted" qualitative scheme — another widely-used colorblind-
// safe palette, with more distinguishable steps than Okabe–Ito for
// telling apart a larger number of chains at once.
const TOL_MUTED_PALETTE: RGB[] = [
  hex(0xcc6677), // rose
  hex(0x332288), // indigo
  hex(0xddcc77), // sand
  hex(0x117733), // green
  hex(0x88ccee), // cyan
  hex(0x882255), // wine
  hex(0x44aa99), // teal
  hex(0x999933), // olive
  hex(0xaa4499), // purple
];

// Viridis is really a SEQUENTIAL (ordered) colormap — chain identity has
// no natural order — but it's colorblind-safe by design (perceptually
// near-uniform, and still readable converted to grayscale), which is
// presumably why it keeps coming up for this anyway. Sampled at 12 evenly
// spaced points by interpolating its 5 most commonly published anchor
// colors, rather than reproducing the full 256-entry reference table.
const VIRIDIS_ANCHORS: RGB[] = [hex(0x440154), hex(0x3b528b), hex(0x21908c), hex(0x5dc863), hex(0xfde725)];
const VIRIDIS_PALETTE = interpolatePalette(VIRIDIS_ANCHORS, 12);

export const CHAIN_PALETTES: Record<ChainPaletteId, RGB[]> = {
  default: DEFAULT_PALETTE,
  "okabe-ito": OKABE_ITO_PALETTE,
  "tol-muted": TOL_MUTED_PALETTE,
  viridis: VIRIDIS_PALETTE,
};

export const CHAIN_PALETTE_LABELS: Record<ChainPaletteId, string> = {
  default: "Default",
  "okabe-ito": "Okabe–Ito (colorblind-safe)",
  "tol-muted": "Tol Muted (colorblind-safe)",
  viridis: "Viridis (colorblind-safe)",
};
