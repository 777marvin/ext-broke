const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const helper = readFileSync(join(__dirname, 'ui-config-helper.js'), 'utf8');
exports.composeUiTemplate = (source) => source.replace('/* BROKE_CONFIG_DRAFT_HELPER */', helper);
