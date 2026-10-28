import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runUpdateWithLifecycle } from '../update-lifecycle';
import type { UpdateResult } from '../update';

describe('AUD-09 update lifecycle', () => {
  for (const outcome of ['success', 'failure', 'throw', 'check']) {
    it(`restores configuration observation after ${outcome}`, async () => {
      let watching = true; let restores = 0;
      const events: string[] = [];
      const result: UpdateResult = { ok: outcome === 'success', updated: outcome === 'success', message: outcome };
      const run = runUpdateWithLifecycle({ mode: outcome === 'check' ? 'check' : 'install' }, {
        closeWatcher: () => { watching = false; },
        startWatcher: () => { watching = true; restores++; },
        progress: (message) => events.push(message),
      }, async (_request, hooks) => {
        if (outcome === 'check') return result;
        await hooks.onBeforeSwap?.();
        assert.equal(watching, false, 'the swap must not retain the directory handle');
        if (outcome === 'throw') throw new Error('synthetic runner failure');
        if (outcome === 'success') await hooks.onAfterSwap?.();
        return result;
      });
      if (outcome === 'throw') await assert.rejects(run, /synthetic runner failure/);
      else assert.equal(await run, result);
      assert.equal(watching, true);
      assert.equal(restores, outcome === 'check' ? 0 : 1);
      assert.equal(events.length, outcome === 'failure' || outcome === 'throw' ? 1 : 0);
    });
  }
});
