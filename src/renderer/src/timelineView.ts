/** The visible slice of the timeline, in seconds. */
export interface View {
  start: number;
  span: number;
}

/** tightest zoom: a few words fill the track */
export const MIN_SPAN = 5;

/** keep the window inside [0, duration] and no narrower than MIN_SPAN */
export function clampView(v: View, duration: number): View {
  const span = Math.min(
    Math.max(v.span, Math.min(MIN_SPAN, duration)),
    duration,
  );
  const start = Math.min(Math.max(v.start, 0), duration - span);
  return { start, span };
}

/** zoom by `factor` (>1 = in) keeping time `at` under the same pixel */
export function zoomAt(
  v: View,
  factor: number,
  at: number,
  duration: number,
): View {
  const frac = (at - v.start) / v.span;
  const span = v.span / factor;
  return clampView({ start: at - frac * span, span }, duration);
}

export const pan = (v: View, dt: number, duration: number): View =>
  clampView({ start: v.start + dt, span: v.span }, duration);

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** ruler tick times for the window, ~at most `max` of them on round steps */
export function ticks(v: View, max = 8): number[] {
  const step = STEPS.find((s) => v.span / s <= max) ?? 3600;
  const out: number[] = [];
  for (
    let t = Math.ceil(v.start / step) * step;
    t <= v.start + v.span;
    t += step
  )
    out.push(t);
  return out;
}

/** page the window along when the playhead runs off it (or was never in it) */
export function followView(v: View, t: number, duration: number): View {
  if (t >= v.start && t <= v.start + v.span * 0.9) return v;
  return clampView({ start: t - v.span * 0.1, span: v.span }, duration);
}
