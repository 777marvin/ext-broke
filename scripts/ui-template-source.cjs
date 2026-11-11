const { readFileSync } = require('node:fs');
const { join } = require('node:path');
exports.composeUiTemplate = (source) =>
  source
    .replace('/* BROKE_CONFIG_DRAFT_HELPER */', () => readFileSync(join(__dirname, 'ui-config-helper.js'), 'utf8'))
    .replace('/* BROKE_CONTEXT_PRESS_UI */', () =>
      readFileSync(join(__dirname, 'context-press-style.js'), 'utf8') + '\n' +
      readFileSync(join(__dirname, 'context-press-ui.jsx'), 'utf8'));
