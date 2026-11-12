/**
 * Geometry for the Context Press illustration, extracted from
 * `scripts/context-press-ui.jsx` so it is testable as a function instead of
 * asserted as source text.
 *
 * Every value is derived from two measured inputs and nothing else: the shape of
 * the last observed context (`totalChars`, `protectedChars`) and the configured
 * limit. The rules the tests protect are the honesty rules:
 *
 *   - No measurement means no fill and no percentages, never a zero that looks
 *     like a measurement.
 *   - The PRINTED percentage keeps the real value; only the DRAWN bar clamps.
 *   - The sealed head and the open rest always add up to the drawn fill, and the
 *     shares always add up to 100.
 *
 * Pure arithmetic: no React, no DOM, no file I/O.
 */

export type ContextShape = { totalChars: number; protectedChars: number };
export type ContextPressFigureInput = {
  shape: ContextShape | null;
  /** `maxContextChars`; 0 means "no limit configured", which removes the scale. */
  limit: number;
  /** Width of the drawn bar in SVG user units. */
  barWidth?: number;
};
export type ContextPressFigure = {
  measured: boolean;
  /** Real characters, unclamped. */
  chars: number;
  /** Printed percentage of the limit; real value even past 100. */
  pct: number;
  /** True when the real characters exceed the limit. */
  over: boolean;
  /** Drawn width of the fill, clamped to the bar. */
  fillW: number;
  /** Drawn percentage of the bar, clamped to 100. */
  fillPct: number;
  sealedChars: number;
  openChars: number;
  /** Drawn width of the sealed head, inside the fill. */
  sealedW: number;
  /** Drawn width of the open rest; the remainder of the fill. */
  openW: number;
  sealedShare: number;
  openShare: number;
};

const BAR_WIDTH = 520;

/** Derived scale for the ticks: 0, 25, 50, 75, 100 percent of the limit. */
export function contextPressTicks(limit: number, barX = 32, barWidth = BAR_WIDTH): Array<{ x: number; label: string; anchor: 'start' | 'middle' | 'end' }> {
  if (!(limit > 0)) return [];
  const short = (value: number): string => (value >= 1000 ? `${Math.round(value / 1000)}k` : String(value));
  return [0, 0.25, 0.5, 0.75, 1].map((share, index) => ({
    x: barX + share * barWidth,
    label: index === 0 ? '0' : short(limit * share),
    anchor: (index === 0 ? 'start' : index === 4 ? 'end' : 'middle') as 'start' | 'middle' | 'end',
  }));
}

/**
 * The one place that turns a measured shape into drawable numbers.
 *
 * `totalChars` is the pre-transform context the host actually sent, and
 * `protectedChars` is how much of it no pass may touch. `openChars` is what is
 * left: the part the passes are allowed to shorten.
 */
export function contextPressFigure({ shape, limit, barWidth = BAR_WIDTH }: ContextPressFigureInput): ContextPressFigure {
  const chars = shape?.totalChars ?? 0;
  const sealedChars = shape?.protectedChars ?? 0;
  const measured = shape !== null;
  const scaled = measured && limit > 0;
  const ratio = scaled ? chars / limit : 0;

  // The printed percentage is the truth; the drawn width is what the canvas can show.
  const pct = scaled ? Math.round(ratio * 100) : 0;
  const over = scaled && chars > limit;
  const fillW = scaled ? Math.min(1, ratio) * barWidth : 0;
  const fillPct = scaled ? Math.min(100, ratio * 100) : 0;

  // The split describes the measured context, so it is proportional to the real
  // characters - not to the clamped fill. Both parts together are the fill.
  const sealedW = chars > 0 ? (sealedChars / chars) * fillW : 0;
  const openW = Math.max(0, fillW - sealedW);
  const sealedShare = chars > 0 ? (sealedChars / chars) * 100 : 0;

  return {
    measured,
    chars,
    pct,
    over,
    fillW,
    fillPct,
    sealedChars,
    openChars: Math.max(chars - sealedChars, 0),
    sealedW,
    openW,
    sealedShare,
    openShare: Math.max(0, 100 - sealedShare),
  };
}