import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { DEFAULT_CONFIG } from '../config';
import { IndexCoordinator } from '../index-coordinator';

it('AUD-09: coordinator keeps project snapshots separate and uses the same root for rebuild, status and search', () => {
  const root = mkdtempSync(join(tmpdir(), 'broke-coordinator-'));
  const previous = process.env.BROKE_INDEX_DIR;
  process.env.BROKE_INDEX_DIR = join(root, '.index');
  try {
    writeFileSync(join(root, 'one.ts'), 'export const coordinatorNeedle = 1;');
    const service = new IndexCoordinator();
    assert.match(service.rebuild(root, DEFAULT_CONFIG.search), /index rebuilt - 1 file/);
    assert.match(service.status(root, DEFAULT_CONFIG.search), /files: 1/);
    assert.match(service.search(root, DEFAULT_CONFIG.search, { query: 'coordinatorNeedle' }).text, /one.ts/);
    assert.match(service.status(join(root, 'other-project'), DEFAULT_CONFIG.search), /no index yet/);
    assert.match(service.status(root, DEFAULT_CONFIG.search), /files: 1/);
  } finally {
    if (previous === undefined) delete process.env.BROKE_INDEX_DIR; else process.env.BROKE_INDEX_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

it('AUD-09: disabled refresh does no indexing and commit bursts retain a throttled snapshot until rebuild', () => {
  const root = mkdtempSync(join(tmpdir(), 'broke-refresh-'));
  const previous = process.env.BROKE_INDEX_DIR;
  process.env.BROKE_INDEX_DIR = join(root, '.index');
  try {
    const service = new IndexCoordinator();
    writeFileSync(join(root, 'one.ts'), 'export const refreshNeedle = 1;');
    service.refresh(root, { ...DEFAULT_CONFIG.search, enabled: false });
    assert.match(service.status(root, DEFAULT_CONFIG.search), /no index yet/);
    service.refresh(root, DEFAULT_CONFIG.search);
    assert.match(service.status(root, DEFAULT_CONFIG.search), /files: 1/);
    writeFileSync(join(root, 'two.ts'), 'export const laterFile = 2;');
    service.refresh(root, DEFAULT_CONFIG.search);
    assert.match(service.status(root, DEFAULT_CONFIG.search), /files: 1/);
    assert.match(service.rebuild(root, DEFAULT_CONFIG.search), /index rebuilt - 2 file/);
    assert.match(service.status(root, DEFAULT_CONFIG.search), /files: 2/);
  } finally {
    if (previous === undefined) delete process.env.BROKE_INDEX_DIR; else process.env.BROKE_INDEX_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
