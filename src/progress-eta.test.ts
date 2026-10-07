import { describe, it, expect } from "vitest";
import { etaTracker, formatRemaining } from "./progress-eta";

function clock() {
  let t = 0;
  return { now: () => t, advance: (s: number) => { t += s * 1000; } };
}

describe("etaTracker", () => {
  it("extrapolates from the rate measured after the threshold", () => {
    const c = clock();
    const eta = etaTracker(0.1, c.now);
    c.advance(5);
    expect(eta(0.2)).toBe(""); // first update past the threshold sets the baseline
    c.advance(10);
    expect(eta(0.4)).toBe(" · about 30 s left"); // 20% in 10 s → 60% in 30 s
  });

  it("ignores a slow setup phase before the threshold", () => {
    const c = clock();
    const eta = etaTracker(0.2, c.now);
    c.advance(70); // e.g. building the proxy
    expect(eta(0.21)).toBe("");
    c.advance(34);
    expect(eta(0.22)).toBe(" · about 44 min left"); // 1% per 34 s, 78% to go
  });

  it("stays silent before the threshold, with under two seconds measured, and once done", () => {
    const c = clock();
    const eta = etaTracker(0.2, c.now);
    expect(eta(0.15)).toBe("");
    expect(eta(0.3)).toBe("");
    c.advance(1);
    expect(eta(0.5)).toBe("");
    expect(eta(1)).toBe("");
  });
});

describe("formatRemaining", () => {
  it("rounds to readable steps", () => {
    expect(formatRemaining(4)).toBe("a few seconds left");
    expect(formatRemaining(23)).toBe("about 25 s left");
    expect(formatRemaining(150)).toBe("about 3 min left");
  });
});
