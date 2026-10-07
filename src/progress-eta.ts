/** Rough "time left" from reported progress. The rate is measured only from
 * the first update at or past `minFraction`, so a setup phase that moves the
 * bar at a different speed (file parsing, building the proxy) can't skew it.
 * Silent until two seconds of measured progress exist. */
export function etaTracker(minFraction = 0.1, now: () => number = () => performance.now()) {
  let base: { t: number; f: number } | null = null;
  return (fraction: number): string => {
    if (fraction < minFraction || fraction >= 1) return "";
    const t = now();
    if (!base) {
      base = { t, f: fraction };
      return "";
    }
    const elapsedS = (t - base.t) / 1000;
    const done = fraction - base.f;
    if (elapsedS < 2 || done <= 0) return "";
    return ` · ${formatRemaining((elapsedS * (1 - fraction)) / done)}`;
  };
}

export function formatRemaining(seconds: number): string {
  if (seconds < 10) return "a few seconds left";
  if (seconds < 60) return `about ${Math.round(seconds / 5) * 5} s left`;
  return `about ${Math.round(seconds / 60)} min left`;
}
