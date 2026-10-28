import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { acquireUpdateLock, releaseUpdateLock, updateLockPath } from '../update-lock';

const root = mkdtempSync(join(tmpdir(), 'broke-lock-test-'));
after(() => rmSync(root, { recursive: true, force: true }));
let count = 0;
function install(): string { const dir = join(root, `install-${++count}`); mkdirSync(dir); return dir; }
function worker(): ChildProcess {
  return fork(join(__dirname, 'fixtures', 'update-lock-worker.ts'), [], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}
async function exchange(child: ChildProcess, kind: string, dir: string): Promise<{ ok: boolean }> {
  const response = once(child, 'message');
  child.send({ kind, install: dir });
  return (await response)[0];
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(); await exited;
}

describe('AUD-02 cross-process owner locks', () => {
  it('blocks a second process while the installation has been renamed away', { timeout: 15000 }, async () => {
    const dir = install(); const a = worker(); const b = worker();
    try {
      assert.equal((await exchange(a, 'acquire', dir)).ok, true);
      assert.equal((await exchange(a, 'swap', dir)).ok, true);
      assert.equal(existsSync(dir), false);
      assert.equal((await exchange(b, 'acquire', dir)).ok, false);
      assert.equal((await exchange(a, 'release', dir)).ok, true);
      assert.equal((await exchange(b, 'acquire', dir)).ok, true);
      assert.equal((await exchange(b, 'release', dir)).ok, true);
    } finally { await Promise.all([stop(a), stop(b)]); }
  });

  it('allows one successor after an owner process exits, including simultaneous reclaim attempts', { timeout: 15000 }, async () => {
    const dir = install(); const a = worker(); const b = worker(); const c = worker();
    try {
      assert.equal((await exchange(a, 'acquire', dir)).ok, true);
      await stop(a);
      const results = await Promise.all([exchange(b, 'acquire', dir), exchange(c, 'acquire', dir)]);
      assert.equal(results.filter((r) => r.ok).length, 1);
    } finally { await Promise.all([stop(a), stop(b), stop(c)]); }
  });

  it('never deletes another owner token on release', () => {
    const dir = install(); const result = acquireUpdateLock(dir);
    assert.ok(result.ok);
    const foreign = JSON.stringify({ pid: process.pid, token: 'replacement-owner' });
    writeFileSync(updateLockPath(dir), foreign);
    assert.equal(releaseUpdateLock(result.claim), false);
    assert.equal(readFileSync(updateLockPath(dir), 'utf-8'), foreign);
  });

  it('treats EPERM and unparseable ownership as busy, never as a dead process', () => {
    const dir = install(); const path = updateLockPath(dir);
    writeFileSync(path, JSON.stringify({ pid: 123, token: 'owner' }));
    const probe = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
    assert.equal(acquireUpdateLock(dir, probe).ok, false);
    assert.equal(JSON.parse(readFileSync(path, 'utf-8')).token, 'owner');
    writeFileSync(path, 'interrupted write');
    assert.equal(acquireUpdateLock(dir).ok, false);
    assert.equal(readFileSync(path, 'utf-8'), 'interrupted write');
  });

  it('refuses an abandoned mutation guard and an active legacy lock in a backup', () => {
    const dir = install(); mkdirSync(`${updateLockPath(dir)}.guard`);
    assert.equal(acquireUpdateLock(dir).ok, false);
    assert.equal(existsSync(updateLockPath(dir)), false);
    const legacy = install(); mkdirSync(`${legacy}.old`);
    writeFileSync(join(`${legacy}.old`, '.update.lock'), `${process.pid}\n`);
    assert.equal(acquireUpdateLock(legacy).ok, false);
  });
});
