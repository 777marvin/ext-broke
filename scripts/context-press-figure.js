/**
 * Runtime twin of `context-press-figure.ts`, injected into the JSX template by
 * `composeUiTemplate` (the host template has no module system, so the helpers
 * have to arrive as source).
 *
 * The TypeScript module is the tested source of truth. This file exists only
 * because a JSX string cannot `import`. To stop the two from drifting apart,
 * `tests/context-press-figure.test.ts` also loads this file and asserts it
 * produces the same numbers as the module for the same inputs.
 *
 * Keep the arithmetic identical. No React, no DOM, no I/O.
 */

var BAR_WIDTH = 520;

function contextPressFigure(input) {
  var shape = input.shape;
  var limit = input.limit;
  var barWidth = input.barWidth === undefined ? BAR_WIDTH : input.barWidth;
  var measured = shape !== null && shape !== undefined;
  var chars = measured ? shape.totalChars : 0;
  var sealedChars = measured ? shape.protectedChars : 0;
  var scaled = measured && limit > 0;
  var ratio = scaled ? chars / limit : 0;
  return {
    measured: measured,
    chars: chars,
    pct: scaled ? Math.round(ratio * 100) : 0,
    over: scaled && chars > limit,
    fillW: scaled ? Math.min(1, ratio) * barWidth : 0,
    fillPct: scaled ? Math.min(100, ratio * 100) : 0,
    sealedChars: sealedChars,
    openChars: Math.max(chars - sealedChars, 0),
    sealedW: chars > 0 ? (sealedChars / chars) * (scaled ? Math.min(1, ratio) * barWidth : 0) : 0,
    openW: Math.max(0, (scaled ? Math.min(1, ratio) * barWidth : 0) - (chars > 0 ? (sealedChars / chars) * (scaled ? Math.min(1, ratio) * barWidth : 0) : 0)),
    sealedShare: chars > 0 ? (sealedChars / chars) * 100 : 0,
    openShare: Math.max(0, 100 - (chars > 0 ? (sealedChars / chars) * 100 : 0)),
  };
}

function contextPressTicks(limit, barX, barWidth) {
  var left = barX === undefined ? 32 : barX;
  var width = barWidth === undefined ? BAR_WIDTH : barWidth;
  if (!(limit > 0)) return [];
  return [0, 0.25, 0.5, 0.75, 1].map(function (share, index) {
    var value = limit * share;
    return {
      x: left + share * width,
      label: index === 0 ? '0' : (value >= 1000 ? Math.round(value / 1000) + 'k' : String(value)),
      anchor: index === 0 ? 'start' : index === 4 ? 'end' : 'middle',
    };
  });
}