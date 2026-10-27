/**
 * BRK-016: runtime user data lives under a stable, versioned root OUTSIDE
 * the swappable installation directory. The installer tree is treated as
 * read-only; one legacy migration moves old artifacts into the new layout
 * exactly once.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyRuntimeData, runtimeDir } from '../paths';
import { acquireFileLock, releaseUpdateLock } from '../update-lock';

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
  it('AUD-05: refuses another migration owner without moving legacy files', () => {
    const legacy = mkdtempSync(join(tmpdir(), 'broke-owned-'));
    const target = mkdtempSync(join(tmpdir(), 'broke-owned-target-'));
    tmpRoots.push(legacy, target);
    writeFileSync(join(legacy, 'config.json'), 'source');
    const owner = acquireFileLock(`${target}.migration.lock`);
    assert.ok(owner.ok);
    try {
      assert.equal(migrateLegacyRuntimeData(legacy, target), false);
      assert.equal(readFileSync(join(legacy, 'config.json'), 'utf-8'), 'source');
    } finally { releaseUpdateLock(owner.claim); }
  });

  it('AUD-05: never publishes ledger data through a destination directory link', () => {
    const legacy = mkdtempSync(join(tmpdir(), 'broke-link-'));
    const target = mkdtempSync(join(tmpdir(), 'broke-link-target-'));
    const outside = mkdtempSync(join(tmpdir(), 'broke-link-outside-'));
    tmpRoots.push(legacy, target, outside);
    writeFileSync(join(legacy, 'stats.jsonl'), 'synthetic private ledger');
    try { symlinkSync(outside, join(target, 'ledgers'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch { return; }
    assert.equal(migrateLegacyRuntimeData(legacy, target), false);
    assert.equal(existsSync(join(outside, 'stats.jsonl')), false);
    assert.equal(existsSync(join(legacy, 'stats.jsonl')), true);
  });
  it('AUD-05: fills missing descendants after a historical partial copy even with an old marker', () => {
    const legacy = mkdtempSync(join(tmpdir(), 'broke-partial-'));
    const target = mkdtempSync(join(tmpdir(), 'broke-partial-target-'));
    tmpRoots.push(legacy, target);
    mkdirSync(join(legacy, 'snapshots'));
    mkdirSync(join(target, 'snapshots'));
    writeFileSync(join(legacy, 'snapshots', 'a.json'), 'first');
    writeFileSync(join(legacy, 'snapshots', 'b.json'), 'second');
    writeFileSync(join(target, 'snapshots', 'a.json'), 'first');
    writeFileSync(join(target, '.migrated-v1'), 'premature historical marker');
    assert.equal(migrateLegacyRuntimeData(legacy, target), true);
    assert.equal(readFileSync(join(target, 'snapshots', 'b.json'), 'utf-8'), 'second');
    assert.equal(existsSync(join(legacy, 'snapshots')), false);
  });

  for (const corrupt of [false, true]) {
    it(`AUD-05: ${corrupt ? 'corrupt' : 'interrupted'} staging never becomes final and a retry succeeds`, () => {
      const legacy = mkdtempSync(join(tmpdir(), 'broke-copy-fault-'));
      const target = mkdtempSync(join(tmpdir(), 'broke-copy-target-'));
      tmpRoots.push(legacy, target);
      writeFileSync(join(legacy, 'config.json'), '{"complete":"original"}');
      const migrate = migrateLegacyRuntimeData as (from: string, to: string, options?: { copyFile: (from: string, to: string) => void }) => boolean;
      assert.equal(migrate(legacy, target, { copyFile: (_from, to) => {
        writeFileSync(to, 'partial');
        if (!corrupt) throw new Error('injected copy failure');
      } }), false);
      assert.equal(existsSync(join(target, 'config.json')), false);
      assert.equal(existsSync(join(target, '.migrated-v1')), false);
      assert.equal(readFileSync(join(legacy, 'config.json'), 'utf-8'), '{"complete":"original"}');
      assert.equal(migrateLegacyRuntimeData(legacy, target), true);
      assert.equal(readFileSync(join(target, 'config.json'), 'utf-8'), '{"complete":"original"}');
    });
  }

  it('AUD-05: preserves conflicting files, complements missing files and reports incomplete migration', () => {
    const legacy = mkdtempSync(join(tmpdir(), 'broke-conflict-'));
    const target = mkdtempSync(join(tmpdir(), 'broke-conflict-target-'));
    tmpRoots.push(legacy, target);
    mkdirSync(join(legacy, 'snapshots')); mkdirSync(join(target, 'snapshots'));
    writeFileSync(join(legacy, 'snapshots', 'shared.json'), 'legacy');
    writeFileSync(join(target, 'snapshots', 'shared.json'), 'new');
    writeFileSync(join(legacy, 'snapshots', 'missing.json'), 'missing');
    assert.equal(migrateLegacyRuntimeData(legacy, target), false);
    assert.equal(readFileSync(join(target, 'snapshots', 'shared.json'), 'utf-8'), 'new');
    assert.equal(readFileSync(join(legacy, 'snapshots', 'shared.json'), 'utf-8'), 'legacy');
    assert.equal(readFileSync(join(target, 'snapshots', 'missing.json'), 'utf-8'), 'missing');
    assert.equal(existsSync(join(target, '.migrated-v1')), false);
  });
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

  it('DATA-001: does not write .migrated-v1 marker on failed migration and allows retry', () => {
    const legacy = mkdtempSync(join(tmpdir(), 'broke-legacy-fail-'));
    const invalidTarget = join(tmpdir(), `broke-file-target-${Date.now()}`);
    // Write a file where target directory should be, making subdirectory creation fail
    writeFileSync(invalidTarget, 'blocking file');
    tmpRoots.push(legacy, invalidTarget);

    writeFileSync(join(legacy, 'config.json'), '{"enabled":true}');

    const ok1 = migrateLegacyRuntimeData(legacy, invalidTarget);
    assert.equal(ok1, false, 'migration reports failure when moves fail');
    assert.equal(existsSync(join(invalidTarget, '.migrated-v1')), false, 'marker is NOT written on failure');
    assert.equal(existsSync(join(legacy, 'config.json')), true, 'legacy file preserved for retry');

    // Clean up blocking file and provide valid directory
    rmSync(invalidTarget, { force: true });
    mkdirSync(invalidTarget, { recursive: true });

    const ok2 = migrateLegacyRuntimeData(legacy, invalidTarget);
    assert.equal(ok2, true, 'subsequent retry succeeds');
    assert.equal(existsSync(join(invalidTarget, 'config.json')), true, 'file successfully migrated on retry');
    assert.equal(existsSync(join(invalidTarget, '.migrated-v1')), true, 'marker written on complete success');
  });
});
