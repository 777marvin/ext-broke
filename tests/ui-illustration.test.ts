/**
 * The Context Press illustration must draw MEASURED state: the printed context
 * count against maxContextChars, a bar whose sealed head and open rest are
 * proportional to the real characters, a limit line at the configured scale and
 * a separate receipt for the cumulative estimate. These are source-level
 * assertions on the assembled fragment - the geometry itself is verified in the
 * browser, but the honesty rules (no invented numbers, no guessed split, an
 * explicit unmeasured state) have to survive refactors.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { composeUiTemplate } from '../scripts/ui-template-source.cjs';

const ui = composeUiTemplate(readFileSync('scripts/context-press-ui.jsx', 'utf8'));
const style = readFileSync('scripts/context-press-style.js', 'utf8');

describe('context press illustration', () => {
  it('reads the measured context against the configured limit', () => {
    assert.match(ui, /viewBox="0 0 960 300"/, 'the drawing uses the wide figure canvas');
    assert.match(ui, /aria-label=\{cpAria\}/, 'the drawing carries the measured values as text');
    assert.match(ui, /data\?\.contextShape/, 'the numbers come from the measured context shape');
    assert.match(ui, /const cpLimit = maxCtx > 0 \? maxCtx : 0/, 'the scale is the configured limit');
    assert.match(ui, /const cpPct = cpShape && cpLimit > 0 \? Math\.round\(\(cpChars \/ cpLimit\) \* 100\) : 0/, 'the printed percentage keeps the real value');
    assert.match(ui, /const cpFillW = cpShape && cpLimit > 0 \? Math\.min\(1, cpChars \/ cpLimit\) \* cpBarW : 0/, 'only the drawn bar is clamped');
    assert.match(ui, /const cpOver = !!cpShape && cpLimit > 0 && cpChars > cpLimit/, 'over limit is a measured comparison, not a guess');
    assert.match(ui, /% \\u00b7 over limit/, 'the over-limit state is labelled in the header');
    assert.doesNotMatch(ui, /cpShort\(Math\.round\(\(maxCtx \* i\) \/ 4\)\)/, 'the old fixed four-step scale is gone');
  });

  it('splits the bar into a sealed head and an open rest', () => {
    assert.match(ui, /const cpSealedW = cpChars > 0 \? \(cpSealed \/ cpChars\) \* cpFillW : 0/, 'the sealed head is the protected share of the fill');
    assert.match(ui, /const cpOpenW = Math\.max\(0, cpFillW - cpSealedW\)/, 'the open rest is the remainder of the fill');
    assert.match(ui, /\{cpSealedW > 0 \? <rect className="cp-fig-sealed"/, 'an empty protected tail draws no sealed head');
    assert.match(ui, /url\(#cpBarClip\)/, 'the fill is clipped to the bar instead of overflowing the scale');
    assert.match(ui, /Sealed, never trimmed/, 'the sealed part is named');
    assert.match(ui, /Open to trimming/, 'the open part is named');
    assert.match(ui, /\{cpShape \? `\$\{cpFormat\(cpSealed\)\} chars` : '\\u2014'\}/, 'the sealed count is printed, never colour alone');
    assert.match(ui, /\{cpShape \? `\$\{cpFormat\(cpOpen\)\} chars` : '\\u2014'\}/, 'the open count is printed as well');
  });

  it('draws the limit line and ticks from the configured limit', () => {
    assert.match(ui, /const cpTicks = cpLimit > 0/, 'ticks only exist with a real scale');
    assert.match(ui, /label: index === 0 \? '0' : cpShort\(cpLimit \* share\)/, 'tick labels are derived from the limit');
    assert.match(ui, /\{`limit \$\{cpFormat\(cpLimit\)\}`\}/, 'the limit line prints the limit it marks');
    assert.match(ui, /strokeDasharray=\{cpShape \? undefined : '7 6'\}/, 'an unmeasured bar is an empty dashed track');
  });

  it('keeps the cumulative estimate in its own receipt', () => {
    assert.match(ui, /cost\?\.savedUsd/, 'the money value comes from the modelled cost, not a constant');
    assert.match(ui, /const cpMoneyText = cpUsdText \? `\\u2248 \$\{cpUsdText\}` : 'n\/a'/, 'an unknown price renders as n/a, a known one carries the estimate marker');
    assert.doesNotMatch(ui, /\$0\.00/, 'no hardcoded placeholder amount');
    assert.match(ui, /no model price known/, 'an unknown price is named instead of zeroed');
    assert.match(ui, /estimated at/, 'the money is qualified as an estimate');
    assert.match(ui, /\{cpUsdText && cpPriceLabel \?/, 'the model label is visible, not aria-only');
    assert.match(ui, /redirected from repeated context/, 'the token saving is what the receipt counts');
    assert.match(ui, /Saved so far/, 'the receipt is cumulative, not a per-run figure');
    assert.doesNotMatch(ui, /diverted/, 'the per-run split is no longer called a diverted saving');
  });

  it('keeps an honest unmeasured state', () => {
    assert.match(ui, /CONTEXT \\u00b7 NOT MEASURED YET/, 'an unobserved context says so in the header');
    assert.match(ui, /The first measured run fills this bar/, 'the empty bar explains itself instead of showing a guess');
    assert.match(ui, /No guessed split\. The next request will be measured\./, 'the unmeasured footnote names the guarantee');
    assert.match(ui, /const cpNumText = cpShape \? cpFormat\(cpChars\) : '\\u2014'/, 'an unmeasured count prints a dash, never a zero');
  });

  it('repeats the same numbers in a compact variant for narrow dialogs', () => {
    assert.match(ui, /className="cp-figure-wide"/, 'the wide canvas is addressable');
    assert.match(ui, /className="cp-figure-compact" aria-hidden="true"/, 'the compact block is decorative because the svg already carries the description');
    assert.match(ui, /className="cp-fig-value">\{?<strong>\{cpNumText\}/, 'the compact block prints the same count as the canvas');
    assert.match(style, /\.cp-figure-compact\{display:none/, 'the compact block is off by default');
    assert.match(style, /@media\(max-width:800px\)\{[^}]*svg\.cp-figure-wide\{display:none\}[^}]*\.cp-figure-compact\{display:block\}/, 'narrow dialogs switch to the compact block');
    assert.match(style, /\.cp-figure-compact \.cp-fig-track\{/, 'the compact block keeps a real track');
  });

  it('keeps a real replay and the old decoration is gone', () => {
    assert.match(style, /@keyframes cp-fill/, 'the replay keeps a real animation');
    assert.match(style, /\.cp-replaying \.cp-fig-sealed/, 'the replay animates the measured fill');
    assert.match(style, /prefers-reduced-motion[^}]*}/, 'reduced motion still disables the replay');
    assert.match(style, /forced-colors:active/, 'high contrast still has a mapping');
    assert.doesNotMatch(ui, /cp-coin|cpFlap|cpGateY|cpSealW|cpCoins/, 'the coin tray and flap gate are gone');
    assert.doesNotMatch(style, /cp-coin|cp-drop/, 'the coin animation is gone from the stylesheet');
    assert.doesNotMatch(ui, /cp-pages|cp-press/, 'the decorative sheet stack stays gone');
  });
});
