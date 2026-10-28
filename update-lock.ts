/** Installation-scoped ownership survives swaps; every mutation uses one guard. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface UpdateLockClaim { path: string; token: string }
type LockResult = { ok: true; claim: UpdateLockClaim } | { ok: false; reason: string };
type Probe = (pid: number) => unknown;
const waitCell = new Int32Array(new SharedArrayBuffer(4));

export function updateLockPath(installDir: string): string {
  const absolute = resolve(installDir);
  // The installation itself may be absent during a swap. Its parent is stable.
  return join(realpathSync(dirname(absolute)), `${basename(absolute)}.update.lock`);
}

function withGuard<T>(path: string, action: () => T): T {
  const guard = `${path}.guard`;
  const deadline = Date.now() + 200;
  for (;;) {
    try { mkdirSync(guard, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`mutation guard is busy or abandoned: ${guard}`);
      Atomics.wait(waitCell, 0, 0, 5);
    }
  }
  // Never reap a guard: an interrupted critical section needs inspection.
  try { return action(); } finally { rmdirSync(guard); }
}

function provenDead(pid: number, probe: Probe): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { probe(pid); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

export function acquireUpdateLock(installDir: string, probe: Probe = (pid) => process.kill(pid, 0)): LockResult {
  try {
    return acquireFileLock(updateLockPath(installDir), probe, [join(installDir, '.update.lock'), join(`${installDir}.old`, '.update.lock')]);
  } catch (error) { return { ok: false, reason: String(error) }; }
}

/** Same ownership protocol for non-swappable extension-owned data operations. */
export function acquireFileLock(path: string, probe: Probe = (pid) => process.kill(pid, 0), legacyPaths: readonly string[] = []): LockResult {
  try {
    return withGuard(path, () => {
      for (const legacy of legacyPaths) {
        if (!existsSync(legacy)) continue;
        const pid = Number(readFileSync(legacy, 'utf-8').trim());
        if (!provenDead(pid, probe)) return { ok: false, reason: `legacy lock has a live or unknown owner: ${legacy}` };
        unlinkSync(legacy);
      }
      if (existsSync(path)) {
        const owner = JSON.parse(readFileSync(path, 'utf-8')) as { pid?: unknown; token?: unknown };
        if (typeof owner.pid !== 'number' || typeof owner.token !== 'string' || !owner.token || !provenDead(owner.pid, probe)) {
          return { ok: false, reason: `lock has a live or unknown owner: ${path}` };
        }
        unlinkSync(path);
      }
      const claim = { path, token: randomUUID() };
      writeFileSync(path, JSON.stringify({ pid: process.pid, token: claim.token }), { flag: 'wx', mode: 0o600 });
      return { ok: true, claim };
    });
  } catch (error) {
    return { ok: false, reason: `cannot establish ownership (${error instanceof Error ? error.message : String(error)})` };
  }
}

export function releaseUpdateLock(claim: UpdateLockClaim): boolean {
  try {
    return withGuard(claim.path, () => {
      const owner = JSON.parse(readFileSync(claim.path, 'utf-8')) as { pid?: unknown; token?: unknown };
      if (owner.pid !== process.pid || owner.token !== claim.token) return false;
      unlinkSync(claim.path);
      return true;
    });
  } catch { return false; }
}
