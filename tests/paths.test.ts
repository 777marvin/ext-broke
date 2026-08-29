/**
 * BRK-016: runtime user data lives under a stable, versioned root OUTSIDE
 * the swappable installation directory. The installer tree is treated as
 * read-only; one legacy migration moves old artifacts into the new layout
 * exactly once.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyRuntimeData, runtimeDir } from '../paths';

const savedDataDir = process.env.BROKE_DATA_DIR;
const tmpRoots: string[] = [];
after(() => {
  if (savedDataDir === undefined) delete process.env.BROKE_DATA_DIR;
  else process.env.BROKE_DATA_DIR = savedDataDir;
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

describe('runtimeDir (BRK-016)', () => {
  it('honors BROKE_DATA_DIR as the runtime root override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-data-'));
    tmpRoots.push(dir);
    process.env.BROKE_DATA_DIR = dir;
    try {
      assert.equal(runtimeDir(), dir);
    } finally {
      delete process.env.BROKE_DATA_DIR;
    }
  });

  it('defaults to a versioned .broke-data root NEXT TO (not inside) the installation', () => {
    delete process.env.BROKE_DATA_DIR;
    try {
      const dir = runtimeDir();
      // <install>/../.broke-data/v1 - a sibling of the install dir, outside
      // the swap path of the updater.
      assert.ok(dir.endsWith(join('.broke-data', 'v1')), `unexpected runtime dir: ${dir}`);
    } finally {
      if (savedDataDir === undefined) delete process.env.BROKE_DATA_DIR;
      else process.env.BROKE_DATA_DIR = savedDataDir;
    }
  });
});

describe('migrateLegacyRuntimeData (BRK-016)', () => {
  it('moves legacy artifacts from the install dir into the new layout and is idempotent', () => {
    const legacy = mkdtempSync(join(tmpdir(), 'broke-legacy-'));
    const target = mkdtempSync(join(tmpdir(), 'broke-target-'));
    tmpRoots.push(legacy, target);
    // Legacy layout: loose files + dirs next to the code.
    writeFileSync(join(legacy, 'config.json'), '{"enabled":true}');
    writeFileSync(join(legacy, 'stats.jsonl'), '{"taskId":"t1"}');
    writeFileSync(join(legacy, 'measure.jsonl'), '');
    mkdirSync(join(legacy, 'snapshots', 'task-1'), { recursive: true });
    writeFileSync(join(legacy, 'snapshots', 'task-1', 'a.json'), '{}');
    mkdirSync(join(legacy, 'index', '0123456789abcdef'), { recursive: true });
    writeFileSync(join(legacy, 'index', '0123456789abcdef', 'index.json'), '{}');
    mkdirSync(join(legacy, 'errors'), { recursive: true });
    writeFileSync(join(legacy, 'errors', 'e-1.json'), '{}');

    migrateLegacyRuntimeData(legacy, target);
    assert.equal(existsSync(join(target, 'config.json')), true, 'config moved');
    assert.equal(existsSync(join(target, 'ledgers', 'stats.jsonl')), true, 'stats moved into ledgers/');
    assert.equal(existsSync(join(target, 'ledgers', 'measure.jsonl')), true, 'measure moved into ledgers/');
    assert.equal(existsSync(join(target, 'snapshots', 'task-1', 'a.json')), true, 'snapshots moved');
    assert.equal(existsSync(join(target, 'index', '0123456789abcdef', 'index.json')), true, 'index moved');
    assert.equal(existsSync(join(target, 'errors', 'e-1.json')), true, 'errors moved');
    // The install tree no longer carries runtime data.
    assert.equal(existsSync(join(legacy, 'config.json')), false, 'legacy config removed (moved, not copied)');
    assert.equal(existsSync(join(legacy, 'stats.jsonl')), false);
    assert.equal(existsSync(join(legacy, 'snapshots')), false);

    // Second run: marker short-circuits, nothing doubles or errors.
    writeFileSync(join(target, 'ledgers', 'stats.jsonl'), '{"taskId":"t2"}');
    migrateLegacyRuntimeData(legacy, target);
    assert.equal(readFileSync(join(target, 'ledgers', 'stats.jsonl'), 'utf-8'), '{"taskId":"t2"}', 'idempotent: second run is a no-op');
  });

  it('never overwrites newer data at the target (safe against partial migrations)', () => {
    const legacy = mkdtempSync(join(tmpdir(), 'broke-legacy2-'));
    const target = mkdtempSync(join(tmpdir(), 'broke-target2-'));
    tmpRoots.push(legacy, target);
    writeFileSync(join(legacy, 'config.json'), '{"from":"legacy"}');
    writeFileSync(join(target, 'config.json'), '{"from":"new"}');
    migrateLegacyRuntimeData(legacy, target);
    const kept = JSON.parse(readFileSync(join(target, 'config.json'), 'utf-8')) as { from: string };
    assert.equal(kept.from, 'new', 'existing destination data wins');
    assert.equal(existsSync(join(legacy, 'config.json')), true, 'the legacy file stays when it cannot be moved');
  });

  it('treats missing legacy artifacts as a no-op (fresh installs)', () => {
    const legacy = mkdtempSync(join(tmpdir(), 'broke-legacy3-'));
    const target = mkdtempSync(join(tmpdir(), 'broke-target3-'));
    tmpRoots.push(legacy, target);
    assert.doesNotThrow(() => migrateLegacyRuntimeData(legacy, target));
  });
});
