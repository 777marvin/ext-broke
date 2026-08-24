/**
 * Tests for the self-update flow (/broke update). All I/O is injected
 * (UpdateDeps), so these run hermetically: no GitHub access, no system tar,
 * no npm - only real filesystem operations against temp directories.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  closeSync,
  cpSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  existsSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  compareSemver,
  MAX_PRESERVED_ERRORS_BYTES,
  normalizeTag,
  replaceInstallationInPlace,
  resolveLatestVersion,
  runUpdate,
  swapInstallDirectory,
} from '../update';

let tmp: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'broke-update-'));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Build a fake installed extension directory. */
function fakeInstall(version: string): string {
  const dir = join(tmp, `install-${version}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'broke', version }));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ version }));
  writeFileSync(join(dir, 'index.ts'), `// v${version}`);
  writeFileSync(join(dir, 'config.json'), '{"level":"truncate"}');
  writeFileSync(join(dir, 'stats.jsonl'), '{"taskId":"t"}\n');
  writeFileSync(join(dir, 'stats.jsonl.1'), '{"taskId":"older"}\n');
  writeFileSync(join(dir, 'measure.jsonl'), '{"runs":1}\n');
  mkdirSync(join(dir, 'errors'));
  writeFileSync(join(dir, 'errors', 'out.txt'), 'full tool output');
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'dep.js'), '// old dep');
  return dir;
}

interface FakeCalls {
  downloads: string[];
  npmCiDirs: string[];
}

/**
 * Fake UpdateDeps whose "tarball" extracts into one GitHub-style root
 * folder (`ext-broke-<version>/`) containing payloadFiles.
 */
function makeDeps(
  releaseTag: string | Error,
  payloadVersion: string,
  payloadFiles: Record<string, string>,
  opts: { failExtract?: Error; failNpm?: Error; calls?: FakeCalls } = {},
) {
  return {
    fetchJson: async (url: string) => {
      if (!url.includes('/releases/latest')) throw new Error(`unexpected url ${url}`);
      if (releaseTag instanceof Error) throw releaseTag;
      return { tag_name: releaseTag };
    },
    downloadTarball: async (_url: string, destFile: string) => {
      opts.calls?.downloads.push(_url);
      writeFileSync(destFile, 'tarball-bytes');
    },
    extractTarball: async (_archive: string, destDir: string) => {
      if (opts.failExtract) throw opts.failExtract;
      const root = join(destDir, `ext-broke-${payloadVersion}`);
      for (const [name, content] of Object.entries(payloadFiles)) {
        const p = join(root, name);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
      }
    },
    runNpmCi: async (dir: string) => {
      opts.calls?.npmCiDirs.push(dir);
      if (opts.failNpm) throw opts.failNpm;
      // Simulate what npm ci would produce in the staged payload.
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'fresh.js'), '// fresh dep');
    },
  };
}

function payloadV(target: string): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'broke', version: target }),
    'package-lock.json': JSON.stringify({ version: target, changed: true }),
    'index.ts': `// v${target} new code`,
    'README.md': 'readme',
  };
}

const V06_PAYLOAD = payloadV('0.6.0');

describe('normalizeTag', () => {
  it('accepts canonical and bare versions, rejects everything else', () => {
    assert.equal(normalizeTag('v0.6.0'), 'v0.6.0');
    assert.equal(normalizeTag('0.6.0'), 'v0.6.0');
    assert.equal(normalizeTag(' 1.2.3 '), 'v1.2.3');
    assert.equal(normalizeTag('main'), null);
    assert.equal(normalizeTag('v1.2'), null);
    assert.equal(normalizeTag('v1.2.3-rc1'), null); // pre-release tags are out of scope
    assert.equal(normalizeTag('../../etc'), null); // never reach a URL
    assert.equal(normalizeTag(''), null);
  });
});

describe('compareSemver', () => {
  it('orders numerically, not lexicographically', () => {
    assert.ok(compareSemver('0.10.0', '0.9.0') > 0);
    assert.ok(compareSemver('1.0.0', '0.99.99') > 0);
    assert.ok(compareSemver('0.5.1', '0.5.1') === 0);
    assert.ok(compareSemver('0.5.1', '0.5.2') < 0);
  });
});

describe('resolveLatestVersion', () => {
  it('prefers /releases/latest', async () => {
    const urls: string[] = [];
    const res = await resolveLatestVersion(async (url) => {
      urls.push(url);
      return { tag_name: 'v0.6.0' };
    });
    assert.deepEqual(res, { tag: 'v0.6.0', version: '0.6.0' });
    assert.match(urls[0], /\/releases\/latest$/);
  });

  it('falls back to the highest-semver tag when there is no release', async () => {
    const res = await resolveLatestVersion(async (url) => {
      if (url.includes('/releases/latest')) throw new Error('HTTP 404');
      return [
        { name: 'v0.4.0' },
        { name: 'not-a-tag' },
        { name: 'v0.10.0' },
        { name: 'v0.9.0' },
      ];
    });
    assert.deepEqual(res, { tag: 'v0.10.0', version: '0.10.0' });
  });

  it('fails with a reason when nothing valid is found', async () => {
    await assert.rejects(
      resolveLatestVersion(async () => {
        throw new Error('HTTP 403 rate limited');
      }),
      /rate limited/,
    );
  });
});

describe('runUpdate (install)', () => {
  it('updates in place, preserves runtime state and refreshes deps on lockfile change', async () => {
    const install = fakeInstall('0.5.1');
    const calls: FakeCalls = { downloads: [], npmCiDirs: [] };
    const hookLog: string[] = [];
    const res = await runUpdate(
      { mode: 'install' },
      {
        onBeforeSwap: () => hookLog.push('before'),
        onAfterSwap: () => hookLog.push('after'),
      },
      makeDeps('v0.6.0', '0.6.0', V06_PAYLOAD, { calls }),
      install,
    );

    assert.ok(res.ok, res.message);
    assert.equal(res.updated, true);
    assert.equal(res.currentVersion, '0.5.1');
    assert.equal(res.targetVersion, '0.6.0');
    assert.match(res.message, /updated: v0\.5\.1 → v0\.6\.0/);
    assert.match(res.message, /Restart AiderDesk/);
    assert.deepEqual(hookLog, ['before', 'after']);

    // New code is installed.
    assert.equal(JSON.parse(readFileSync(join(install, 'package.json'), 'utf-8')).version, '0.6.0');
    assert.match(readFileSync(join(install, 'index.ts'), 'utf-8'), /new code/);
    assert.equal(readFileSync(join(install, '.deployed-version'), 'utf-8').trim(), 'v0.6.0');
    // Runtime state survived.
    assert.equal(readFileSync(join(install, 'config.json'), 'utf-8'), '{"level":"truncate"}');
    assert.equal(existsSync(join(install, 'stats.jsonl')), true);
    assert.equal(existsSync(join(install, 'stats.jsonl.1')), true);
    assert.equal(existsSync(join(install, 'measure.jsonl')), true);
    assert.equal(readFileSync(join(install, 'errors', 'out.txt'), 'utf-8'), 'full tool output');
    // Dependencies were refreshed inside the staged payload (lockfile changed).
    assert.equal(calls.npmCiDirs.length, 1);
    assert.equal(existsSync(join(install, 'node_modules', 'fresh.js')), true);
    // The tarball URL contains exactly the validated tag.
    assert.equal(calls.downloads[0], 'https://github.com/777marvin/ext-broke/archive/refs/tags/v0.6.0.tar.gz');
    // No leftovers.
    assert.equal(existsSync(`${install}.old`), false);
  });

  it('is a no-op when already on the latest release', async () => {
    const install = fakeInstall('0.6.0');
    const calls: FakeCalls = { downloads: [], npmCiDirs: [] };
    const res = await runUpdate({ mode: 'install' }, {}, makeDeps('v0.6.0', '0.6.0', V06_PAYLOAD, { calls }), install);
    assert.ok(res.ok, res.message);
    assert.equal(res.updated, false);
    assert.match(res.message, /already on v0\.6\.0/);
    assert.equal(calls.downloads.length, 0);
    assert.match(readFileSync(join(install, 'index.ts'), 'utf-8'), /^\/\/ v0\.6\.0$/); // old file untouched
  });

  it('installs an explicitly requested older tag as a downgrade', async () => {
    const install = fakeInstall('0.6.0');
    const res = await runUpdate(
      { mode: 'install', tag: 'v0.5.1' },
      {},
      makeDeps('v0.5.1', '0.5.1', payloadV('0.5.1')),
      install,
    );
    assert.ok(res.ok, res.message);
    assert.equal(res.updated, true);
    assert.match(res.message, /downgraded: v0\.6\.0 → v0\.5\.1/);
    assert.equal(JSON.parse(readFileSync(join(install, 'package.json'), 'utf-8')).version, '0.5.1');
  });

  it('reinstalls the same explicit version (repair path)', async () => {
    const install = fakeInstall('0.6.0');
    const res = await runUpdate({ mode: 'install', tag: '0.6.0' }, {}, makeDeps('v0.6.0', '0.6.0', V06_PAYLOAD), install);
    assert.ok(res.ok, res.message);
    assert.equal(res.updated, true);
    assert.match(res.message, /reinstalled: v0\.6\.0 → v0\.6\.0/);
  });

  it('refuses an invalid explicit tag before any network call', async () => {
    const install = fakeInstall('0.5.1');
    const res = await runUpdate({ mode: 'install', tag: '../../evil' }, {}, makeDeps(new Error('must not be called'), '0.0.0', {}), install);
    assert.equal(res.ok, false);
    assert.match(res.message, /invalid version/);
  });

  it('refuses to run inside a git checkout', async () => {
    const install = fakeInstall('0.5.1');
    mkdirSync(join(install, '.git'));
    const res = await runUpdate({ mode: 'install' }, {}, makeDeps(new Error('must not be called'), '0.0.0', {}), install);
    assert.equal(res.ok, false);
    assert.match(res.message, /git checkout/);
    assert.match(res.message, /deploy\.ps1/);
  });

  it('leaves the installation unchanged when extraction fails', async () => {
    const install = fakeInstall('0.5.1');
    const res = await runUpdate(
      { mode: 'install' },
      {},
      makeDeps('v0.6.0', '0.6.0', V06_PAYLOAD, { failExtract: new Error('corrupt archive') }),
      install,
    );
    assert.equal(res.ok, false);
    assert.match(res.message, /unchanged/);
    assert.equal(JSON.parse(readFileSync(join(install, 'package.json'), 'utf-8')).version, '0.5.1');
    assert.equal(existsSync(`${install}.old`), false);
    assert.equal(existsSync(join(install, 'errors', 'out.txt')), true);
  });

  it('aborts without swapping when the dependency refresh fails', async () => {
    const install = fakeInstall('0.5.1');
    const res = await runUpdate(
      { mode: 'install' },
      {},
      makeDeps('v0.6.0', '0.6.0', V06_PAYLOAD, { failNpm: new Error('npm ci exploded') }),
      install,
    );
    assert.equal(res.ok, false);
    assert.match(res.message, /npm ci exploded/);
    assert.match(res.message, /unchanged/);
    assert.equal(JSON.parse(readFileSync(join(install, 'package.json'), 'utf-8')).version, '0.5.1');
    assert.equal(existsSync(`${install}.old`), false);
  });

  it('serializes concurrent updates with a busy message', async () => {
    const install = fakeInstall('0.5.1');
    let releaseDownload!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const slow = makeDeps('v0.7.0', '0.7.0', payloadV('0.7.0'));
    slow.downloadTarball = async (_url, destFile) => {
      await gate;
      writeFileSync(destFile, 'x');
    };

    const first = runUpdate({ mode: 'install' }, {}, slow, install);
    const second = await runUpdate({ mode: 'install' }, {}, makeDeps('v0.7.0', '0.7.0', payloadV('0.7.0')), install);
    assert.equal(second.ok, false);
    assert.match(second.message, /already running/);

    releaseDownload();
    const done = await first;
    assert.ok(done.ok, done.message);
    assert.equal(JSON.parse(readFileSync(join(install, 'package.json'), 'utf-8')).version, '0.7.0');
  });
});

describe('runUpdate (check)', () => {
  it('reports an available newer release without touching anything', async () => {
    const install = fakeInstall('0.5.1');
    const res = await runUpdate({ mode: 'check' }, {}, makeDeps('v0.6.0', '0.6.0', V06_PAYLOAD), install);
    assert.ok(res.ok, res.message);
    assert.equal(res.updated, false);
    assert.match(res.message, /v0\.6\.0 is available \(installed: v0\.5\.1\)/);
    assert.equal(JSON.parse(readFileSync(join(install, 'package.json'), 'utf-8')).version, '0.5.1');
  });

  it('reports up-to-date', async () => {
    const install = fakeInstall('0.6.0');
    const res = await runUpdate({ mode: 'check' }, {}, makeDeps('v0.6.0', '0.6.0', V06_PAYLOAD), install);
    assert.ok(res.ok, res.message);
    assert.match(res.message, /already on v0\.6\.0/);
  });
});

describe('swapInstallDirectory / replaceInstallationInPlace', () => {
  it('swaps atomically: new content in, backup gone', () => {
    const install = join(tmp, `swap-${Math.random().toString(36).slice(2)}`);
    mkdirSync(install);
    writeFileSync(join(install, 'old.txt'), 'old');
    const payload = join(tmp, `payload-${Math.random().toString(36).slice(2)}`);
    mkdirSync(payload);
    writeFileSync(join(payload, 'new.txt'), 'new');

    assert.equal(swapInstallDirectory(install, payload, 'v9.9.9'), 'swapped');
    assert.equal(readFileSync(join(install, 'new.txt'), 'utf-8'), 'new');
    assert.equal(existsSync(join(install, 'old.txt')), false);
    assert.equal(existsSync(`${install}.old`), false);
    assert.equal(readFileSync(join(install, '.deployed-version'), 'utf-8').trim(), 'v9.9.9');
  });

  it('recovers a stale backup left by an interrupted swap', () => {
    const install = join(tmp, `stale-${Math.random().toString(36).slice(2)}`);
    mkdirSync(install);
    writeFileSync(join(install, 'current.txt'), 'current');
    const backup = `${install}.old`;
    mkdirSync(backup);
    writeFileSync(join(backup, 'ancient.txt'), 'ancient');
    const payload = join(tmp, `stale-payload-${Math.random().toString(36).slice(2)}`);
    mkdirSync(payload);
    writeFileSync(join(payload, 'new.txt'), 'new');

    assert.equal(swapInstallDirectory(install, payload, 'v1.0.0'), 'swapped'); // stale backup dropped
    assert.equal(existsSync(backup), false);
    assert.equal(readFileSync(join(install, 'new.txt'), 'utf-8'), 'new');
  });

  it('in-place fallback fully replaces content and removes the backup', () => {
    const install = join(tmp, `inplace-${Math.random().toString(36).slice(2)}`);
    mkdirSync(install);
    writeFileSync(join(install, 'only-old.txt'), 'legacy');
    writeFileSync(join(install, 'shared.txt'), 'old shared');
    const payload = join(tmp, `inplace-payload-${Math.random().toString(36).slice(2)}`);
    mkdirSync(payload);
    writeFileSync(join(payload, 'shared.txt'), 'new shared');

    replaceInstallationInPlace(install, payload, 'v8.8.8');
    assert.equal(readFileSync(join(install, 'shared.txt'), 'utf-8'), 'new shared');
    assert.equal(existsSync(join(install, 'only-old.txt')), false); // full replacement
    assert.equal(existsSync(`${install}.old`), false);
    assert.equal(readFileSync(join(install, '.deployed-version'), 'utf-8').trim(), 'v8.8.8');
  });

  it('rolls back completely when staging hits an unmovable entry', () => {
    const install = join(tmp, `lockmove-${Math.random().toString(36).slice(2)}`);
    mkdirSync(install);
    for (const name of ['a-old.txt', 'b-old.txt', 'c-old.txt']) {
      writeFileSync(join(install, name), 'old');
    }
    const payload = join(tmp, `lockmove-payload-${Math.random().toString(36).slice(2)}`);
    mkdirSync(payload);
    writeFileSync(join(payload, 'new.txt'), 'new');

    // The historical corruption: entry #2 cannot be renamed (transient lock)
    // and the old code aborted mid-loop, stranding the leading entries in the
    // backup. The hardened version must put everything back.
    let calls = 0;
    assert.throws(
      () =>
        replaceInstallationInPlace(install, payload, 'v7.7.7', {
          rename: (from, to) => {
            calls += 1;
            if (calls === 2) throw new Error('EPERM: locked by another process');
            renameSync(from, to);
          },
        }),
        /cannot stage 'b-old\.txt'.*previous installation is intact/s,
    );
    for (const name of ['a-old.txt', 'b-old.txt', 'c-old.txt']) {
      assert.equal(readFileSync(join(install, name), 'utf-8'), 'old', name);
    }
    assert.equal(existsSync(join(install, 'new.txt')), false); // nothing copied
    assert.equal(existsSync(`${install}.old`), false); // backup fully folded back
  });

  it('detects an incomplete in-place copy and restores the previous installation', () => {
    const install = join(tmp, `partial-${Math.random().toString(36).slice(2)}`);
    mkdirSync(install);
    writeFileSync(join(install, 'keep.txt'), 'keep');
    const payload = join(tmp, `partial-payload-${Math.random().toString(36).slice(2)}`);
    mkdirSync(payload);
    writeFileSync(join(payload, 'new.txt'), 'new');

    // Simulate a copier dying part-way: some files land, one goes missing.
    assert.throws(
      () =>
        replaceInstallationInPlace(install, payload, 'v6.6.6', {
          copyRaw: (from, to) => {
            cpSync(from, to, { recursive: true });
            rmSync(join(to, 'new.txt'), { force: true });
          },
        }),
        /payload copy incomplete/,
    );
    assert.equal(readFileSync(join(install, 'keep.txt'), 'utf-8'), 'keep'); // restored
    assert.equal(existsSync(join(install, 'new.txt')), false); // partial copy wiped
    assert.equal(existsSync(`${install}.old`), false);
  });

  it('verifies the rename-swap copy and restores the backup on mismatch', () => {
    const install = join(tmp, `swapverify-${Math.random().toString(36).slice(2)}`);
    mkdirSync(install);
    writeFileSync(join(install, 'old.txt'), 'old');
    const payload = join(tmp, `swapverify-payload-${Math.random().toString(36).slice(2)}`);
    mkdirSync(payload);
    writeFileSync(join(payload, 'new.txt'), 'new');

    assert.throws(
      () =>
        swapInstallDirectory(install, payload, 'v5.5.5', {
          copyRaw: (from, to) => {
            cpSync(from, to, { recursive: true });
            rmSync(join(to, 'new.txt'), { force: true });
          },
        }),
        /payload copy incomplete/,
    );
    assert.equal(readFileSync(join(install, 'old.txt'), 'utf-8'), 'old'); // backup moved back
    assert.equal(existsSync(join(install, 'new.txt')), false);
    assert.equal(existsSync(`${install}.old`), false);
  });
});

describe('errors/ archive preserve cap', () => {
  it('carries a small archive over without warnings', async () => {
    const install = fakeInstall('0.5.1');
    const res = await runUpdate({ mode: 'install' }, {}, makeDeps('v0.6.0', '0.6.0', V06_PAYLOAD), install);
    assert.ok(res.ok, res.message);
    assert.deepEqual(res.warnings ?? [], []);
    assert.equal(readFileSync(join(install, 'errors', 'out.txt'), 'utf-8'), 'full tool output');
  });

  it('warns and skips the archive when it exceeds the cap', async () => {
    const install = fakeInstall('0.5.1');
    // Sparse file: create empty, then extend to a huge LOGICAL size (what
    // statSync/dirSizeBytes report) without writing the bytes - instant.
    const fh = openSync(join(install, 'errors', 'huge.bin'), 'w');
    ftruncateSync(fh, MAX_PRESERVED_ERRORS_BYTES + 1);
    closeSync(fh);
    const res = await runUpdate({ mode: 'install' }, {}, makeDeps('v0.6.0', '0.6.0', V06_PAYLOAD), install);
    assert.ok(res.ok, res.message);
    assert.equal(res.warnings?.length, 1);
    assert.match(res.warnings?.[0] ?? '', /100 MB/);
    assert.equal(existsSync(join(install, 'errors', 'out.txt')), false); // archive skipped
    // The oversized archive stays untouched in the OLD folder... which was
    // swapped away, so verify via the message instead: update succeeded.
    assert.match(res.message, /updated: v0\.5\.1 → v0\.6\.0/);
  });
});
