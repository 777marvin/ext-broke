const { readFileSync } = require('node:fs');
const { join } = require('node:path');
exports.composeUiTemplate = (source) =>
  source.replace('/* BROKE_CONFIG_DRAFT_HELPER */', () => readFileSync(join(__dirname, 'ui-config-helper.js'), 'utf8'));
