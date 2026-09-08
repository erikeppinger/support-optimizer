import { describe, it, expect } from "vitest";
import { CHAIN_PALETTES, CHAIN_PALETTE_LABELS } from "./chain-palettes";

describe("chain-palettes", () => {
  it("every palette has a matching label", () => {
    expect(Object.keys(CHAIN_PALETTE_LABELS).sort()).toEqual(Object.keys(CHAIN_PALETTES).sort());
  });

  it("every color in every palette is a valid RGB triple in [0,1]", () => {
    for (const [id, palette] of Object.entries(CHAIN_PALETTES)) {
      expect(palette.length).toBeGreaterThan(0);
      for (const [r, g, b] of palette) {
        for (const channel of [r, g, b]) {
          expect(channel, `${id}: channel out of range`).toBeGreaterThanOrEqual(0);
          expect(channel, `${id}: channel out of range`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("no palette repeats a color within itself", () => {
    for (const [id, palette] of Object.entries(CHAIN_PALETTES)) {
      const keys = palette.map(([r, g, b]) => `${r.toFixed(3)},${g.toFixed(3)},${b.toFixed(3)}`);
      expect(new Set(keys).size, `${id} has a duplicate color`).toBe(keys.length);
    }
  });

  it("okabe-ito omits black (would be invisible against the dark viewer background)", () => {
    const hasNearBlack = CHAIN_PALETTES["okabe-ito"].some(([r, g, b]) => r < 0.05 && g < 0.05 && b < 0.05);
    expect(hasNearBlack).toBe(false);
  });

  it("viridis spans from its dark-purple to yellow anchor across the requested sample count", () => {
    const viridis = CHAIN_PALETTES.viridis;
    const first = viridis[0];
    const last = viridis[viridis.length - 1];
    // Anchor 0: #440154 (dark purple, low R/G, low-mid B); anchor end: #fde725 (yellow, high R/G, low B).
    expect(first[0]).toBeCloseTo(0x44 / 255, 2);
    expect(first[2]).toBeCloseTo(0x54 / 255, 2);
    expect(last[0]).toBeCloseTo(0xfd / 255, 2);
    expect(last[2]).toBeCloseTo(0x25 / 255, 2);
  });
});
