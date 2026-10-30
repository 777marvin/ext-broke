#!/usr/bin/env node
'use strict';

/**
 * Zero-build TypeScript bootstrap for broke's Multi-Agent CLI and MCP server.
 *
 * Uses Node.js (>= 22.15) built-in `module.registerHooks` +
 * `module.stripTypeScriptTypes` to resolve extensionless `.ts` imports and
 * strip TypeScript syntax on the fly as CommonJS, preserving `__dirname` and
 * `require.main` without any `dist/` build step or external runtime loader.
 */

const { existsSync, readFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const mod = require('node:module');

const origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const type = typeof args[0] === 'string' ? args[0] : warning && warning.name;
  if (type === 'ExperimentalWarning') return;
  return origEmitWarning(warning, ...args);
};

if (typeof mod.registerHooks === 'function' && typeof mod.stripTypeScriptTypes === 'function') {
  mod.registerHooks({
    resolve(specifier, context, nextResolve) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.endsWith('.ts') && !specifier.endsWith('.js') && !specifier.endsWith('.cjs') && !specifier.endsWith('.json')) {
        const baseDir = context.parentURL && context.parentURL.startsWith('file:')
          ? dirname(fileURLToPath(context.parentURL))
          : join(__dirname, '..');
        const tsCandidate = resolve(baseDir, `${specifier}.ts`);
        if (existsSync(tsCandidate)) {
          return nextResolve(`${specifier}.ts`, context);
        }
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith('file:') && url.endsWith('.ts')) {
        const filePath = fileURLToPath(url);
        const source = readFileSync(filePath, 'utf-8');
        const stripped = mod.stripTypeScriptTypes(source, {
          mode: 'transform',
          sourceUrl: filePath,
        });
        const prelude = [
          `import { createRequire as __brokeCreateRequire } from 'node:module';`,
          `import { fileURLToPath as __brokeFileURLToPath } from 'node:url';`,
          `import { dirname as __brokeDirname } from 'node:path';`,
          `const __filename = __brokeFileURLToPath(import.meta.url);`,
          `const __dirname = __brokeDirname(__filename);`,
          `const require = __brokeCreateRequire(import.meta.url);`,
        ].join(' ');
        return {
          format: 'module',
          shortCircuit: true,
          source: `${prelude}\n${stripped}`,
        };
      }
      return nextLoad(url, context);
    },
  });
}

const cliEntry = pathToFileURL(join(__dirname, '..', 'cli.ts')).href;
import(cliEntry).then(
  ({ runCli }) =>
    runCli(process.argv.slice(2)).then(({ exitCode, output }) => {
      if (output) process.stdout.write(`${output}\n`);
      if (exitCode !== 0) process.exitCode = exitCode;
    }),
  (err) => {
    process.stderr.write(`broke fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
