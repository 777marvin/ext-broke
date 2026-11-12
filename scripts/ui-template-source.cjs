const { readFileSync } = require('node:fs');
const { join } = require('node:path');
/**
 * The Context Press figure helpers live in `scripts/context-press-figure.js`
 * (compiled from the tested TypeScript module) so the geometry can be unit-tested
 * instead of asserted against JSX source text. The host template is plain JSX
 * text with no module system, so the helpers arrive as injected source - the same
 * mechanism the draft helper already uses. `tests/context-press-figure.test.ts`
 * imports the module directly, which is what keeps the two copies from drifting.
 */
const figureHelper = () =>
  readFileSync(join(__dirname, 'context-press-figure.js'), 'utf8').replace(/^export /gm, '');
exports.composeUiTemplate = (source) =>
  source
    .replace('/* BROKE_CONFIG_DRAFT_HELPER */', () => readFileSync(join(__dirname, 'ui-config-helper.js'), 'utf8'))
    .replace('/* BROKE_CONTEXT_PRESS_UI */', () =>
      readFileSync(join(__dirname, 'context-press-style.js'), 'utf8') + '\n' +
      figureHelper() + '\n' +
      readFileSync(join(__dirname, 'context-press-ui.jsx'), 'utf8'));
