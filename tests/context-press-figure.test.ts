/**
 * The Context Press illustration must draw MEASURED state, and the arithmetic
 * behind it is what those honesty claims depend on. These tests exercise the
 * real function instead of grepping the JSX for source text, so a refactor that
 * keeps the expressions but changes their meaning now fails.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { contextPressFigure, contextPressTicks, type ContextShape } from '../context-press-figure';

/**
 * `scripts/context-press-figure.js` is the same arithmetic hand-copied into plain
 * JavaScript, because the host JSX template is a string with no module system and
 * composeUiTemplate injects it as source. A hand copy drifts silently, so it is
 * loaded here and checked against the module for the same inputs.
 */
const injected = new Function(`${readFileSync('scripts/context-press-figure.js', 'utf8')}
  return { contextPressFigure, contextPressTicks };`)() as {
  contextPressFigure: typeof contextPressFigure;
  contextPressTicks: typeof contextPressTicks;
};

const CASES: Array<{ shape: ContextShape | null; limit: number; barWidth: number }> = [
  { shape: null, limit: 60_000, barWidth: 520 },
  { shape: { totalChars: 0, protectedChars: 0 }, limit: 60_000, barWidth: 520 },
  { shape: { totalChars: 40_000, protectedChars: 10_000 }, limit: 60_000, barWidth: 520 },
  { shape: { totalChars: 90_000, protectedChars: 10_000 }, limit: 60_000, barWidth: 520 },
  { shape: { totalChars: 60_000, protectedChars: 1 }, limit: 60_000, barWidth: 520 },
  { shape: { totalChars: 5_000, protectedChars: 5_000 }, limit: 60_000, barWidth: 520 },
  { shape: { totalChars: 40_000, protectedChars: 10_000 }, limit: 0, barWidth: 520 },
  { shape: { totalChars: 12_345, protectedChars: 6_789 }, limit: 30_000, barWidth: 300 },
];

describe('context press figure: injected runtime twin', () => {
  it('produces identical numbers to the tested module', () => {
    for (const testCase of CASES) {
      const fromModule = contextPressFigure(testCase);
      const fromScript = injected.contextPressFigure(testCase);
      assert.deepEqual(fromScript, fromModule, `figure differs for ${JSON.stringify(testCase)}`);
    }
  });

  it('produces identical ticks to the tested module', () => {
    for (const limit of [0, 800, 60_000, 1_000_000]) {
      assert.deepEqual(injected.contextPressTicks(limit, 32, 520), contextPressTicks(limit, 32, 520), `ticks differ for ${limit}`);
    }
  });
});

describe('context press figure geometry', () => {
  it('draws nothing and claims nothing when the context was never measured', () => {
    const f = contextPressFigure({ shape: null, limit: 60_000 });
    assert.equal(f.measured, false);
    assert.equal(f.chars, 0);
    assert.equal(f.pct, 0, 'an unmeasured context has no percentage, not a zero measurement');
    assert.equal(f.over, false);
    assert.equal(f.fillW, 0);
    assert.equal(f.fillPct, 0);
    assert.equal(f.sealedW, 0);
    assert.equal(f.openW, 0);
  });

  it('splits the bar proportionally to the measured characters', () => {
    const f = contextPressFigure({ shape: { totalChars: 40_000, protectedChars: 10_000 }, limit: 60_000 });
    assert.equal(f.fillW, 40_000 / 60_000 * 520);
    assert.equal(f.sealedW, f.fillW * 0.25, 'the sealed head is the protected share of the fill');
    assert.equal(f.openW, f.fillW * 0.75, 'the open rest is the remainder');
    assert.ok(Math.abs(f.sealedW + f.openW - f.fillW) < 1e-9, 'head and rest are exactly the fill');
    assert.ok(Math.abs(f.sealedShare + f.openShare - 100) < 1e-9, 'the shares cover 100 percent');
    assert.equal(f.openChars, 30_000);
  });

  it('prints the real percentage while only the drawn bar clamps', () => {
    const over = contextPressFigure({ shape: { totalChars: 90_000, protectedChars: 10_000 }, limit: 60_000 });
    assert.equal(over.pct, 150, 'the printed value stays true');
    assert.equal(over.over, true);
    assert.equal(over.fillW, 520, 'the drawn bar stops at the scale');
    assert.equal(over.fillPct, 100);
    assert.ok(Math.abs(over.sealedW + over.openW - 520) < 1e-9, 'the split still covers the clamped fill');
    const at = contextPressFigure({ shape: { totalChars: 60_000, protectedChars: 1 }, limit: 60_000 });
    assert.equal(at.over, false, 'exactly at the limit is not over it');
    assert.equal(at.pct, 100);
  });

  it('reports everything as sealed when no region is compressible', () => {
    const f = contextPressFigure({ shape: { totalChars: 5_000, protectedChars: 5_000 }, limit: 60_000 });
    assert.equal(f.openW, 0, 'no open segment is drawn');
    assert.equal(f.sealedW, f.fillW);
    assert.equal(f.openShare, 0);
  });

  it('draws no fill but keeps the scale without a configured limit', () => {
    const f = contextPressFigure({ shape: { totalChars: 40_000, protectedChars: 10_000 }, limit: 0 });
    assert.equal(f.measured, true, 'the measurement exists, the scale does not');
    assert.equal(f.fillW, 0, 'no scale means no fill');
    assert.equal(f.pct, 0, 'and no percentage, because there is no denominator');
    assert.equal(f.over, false, 'nothing can be over a limit that is not set');
    assert.deepEqual(contextPressTicks(0), [], 'and no ticks to draw');
  });

  it('derives tick labels from the limit instead of hardcoding them', () => {
    const ticks = contextPressTicks(60_000, 32, 520);
    assert.equal(ticks.length, 5);
    assert.deepEqual(ticks.map(t => t.label), ['0', '15k', '30k', '45k', '60k']);
    assert.deepEqual(ticks.map(t => t.anchor), ['start', 'middle', 'middle', 'middle', 'end']);
    assert.equal(ticks[0].x, 32);
    assert.equal(ticks[4].x, 32 + 520);
    assert.deepEqual(contextPressTicks(800, 32, 520).map(t => t.label), ['0', '200', '400', '600', '800']);
  });
});