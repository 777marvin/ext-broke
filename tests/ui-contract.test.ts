/**
 * BRK-024: the vendored host UI contract must exist, pin the version of
 * @aiderdesk/extensions the extension compiles against, and the UI
 * validator must pass against it WITHOUT the old permissive `any` fallback.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const contractPath = join('scripts', 'host-ui-contract.d.ts');

describe('vendored host UI contract (BRK-024)', () => {
  it('exists and pins the @aiderdesk/extensions version it was vendored from', () => {
    const contract = readFileSync(contractPath, 'utf8');
    const installed = JSON.parse(readFileSync(join('node_modules', '@aiderdesk', 'extensions', 'package.json'), 'utf8')) as {
      version: string;
    };
    const pinnedMajorMinor = installed.version.split('.').slice(0, 2).join('.');
    assert.match(contract, /@aiderdesk\/extensions/, 'the contract names the source package');
    assert.ok(
      contract.includes(`@aiderdesk/extensions ${pinnedMajorMinor}`),
      `contract pins @aiderdesk/extensions ${pinnedMajorMinor} (installed), got: ${contract.slice(0, 400)}`,
    );
  });

  it('declares real shapes for the host props the components consume - no any-fallback', () => {
    const contract = readFileSync(contractPath, 'utf8');
    for (const name of ['CheckboxProps', 'InputProps', 'SelectProps', 'UIComponents', 'ConfigComponentProps', 'UIComponentProps']) {
      assert.ok(contract.includes(`interface ${name}`) || contract.includes(`type ${name}`), `missing ${name}`);
    }
    // The HOST prop types must be structural, never `any`.
    assert.doesNotMatch(contract, /type (AgentProfile|Message|Model|ProviderProfile|TaskData) = any/);
  });

  it('the UI validator passes both components and never falls back to any-typed props', () => {
    const run = spawnSync(process.execPath, ['scripts/validate-extension-ui.mjs', 'ConfigComponent.jsx', 'StatusBadge.jsx'], {
      encoding: 'utf-8',
    });
    assert.equal(run.status, 0, `validator failed:\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /2 passed, 0 failed/);
    assert.ok(!run.stdout.includes('permissive (any)'), 'the any-fallback warning must be gone');
  });
});
