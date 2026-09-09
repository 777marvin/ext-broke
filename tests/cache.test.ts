import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { clearTask, isSent, markSent, ledgerStats } from '../cache';
import type { ContextMessage } from '@aiderdesk/extensions';

/**
 * The sent-ledger is the heart of the cache-friendly mode: it remembers
 * which messages were already sent to the model (as part of a previous
 * onOptimizeMessages return) so the passes can leave that prefix
 * byte-stable. Fehlerrichtung ist bewusst konservativ: ein faelschlich
 * als gesendet behandeltes Nachricht kostet nur eine verpasste
 * Kompressions-Chance, niemals einen Cache-Bruch.
 */

const msg = (id: string, text: string, role: 'user' | 'assistant' | 'tool' = 'assistant'): ContextMessage =>
  ({
    id,
    role,
    content: role === 'tool' ? [{ type: 'text', output: { value: text } }] : text,
  }) as unknown as ContextMessage;

describe('sent-ledger mark/is', () => {
  beforeEach(() => clearTask('t1'));

  it('messages returned in a previous optimize run are sent', () => {
    markSent('t1', [msg('a', 'hello'), msg('b', 'world')]);
    assert.equal(isSent('t1', msg('a', 'hello')), true);
    assert.equal(isSent('t1', msg('b', 'world')), true);
  });

  it('an unknown message is not sent', () => {
    markSent('t1', [msg('a', 'hello')]);
    assert.equal(isSent('t1', msg('x', 'new')), false);
  });

  it('same id but different content is NOT sent (host edit or re-merge source)', () => {
    // Run 1 emitted merged(id=a, 'hello world'); run 2 sees original a
    // ('hello') again - it must stay compressible so the pipeline can
    // re-derive the exact bytes it sent before.
    markSent('t1', [msg('a', 'hello world')]);
    assert.equal(isSent('t1', msg('a', 'hello')), false);
  });

  it('same content under a different id is still matched (host id churn must not un-freeze)', () => {
    // If the host ever regenerates ids for unchanged history, freezing by
    // id alone would break byte stability - the serialized fallback keeps
    // the freeze. False-positive direction is conservative (only loses a
    // compression chance, never breaks a cache).
    markSent('t1', [msg('a', 'stable text')]);
    assert.equal(isSent('t1', msg('zz', 'stable text')), true);
  });

  it('role and tool framing participate in the match', () => {
    markSent('t1', [msg('a', 'payload', 'tool')]);
    assert.equal(isSent('t1', msg('a', 'payload', 'tool')), true);
    assert.equal(isSent('t1', msg('a', 'payload', 'assistant')), false);
  });
});

describe('sent-ledger bounds and hygiene', () => {
  beforeEach(() => clearTask('t1'));

  it('evicts the oldest entries beyond the per-task cap (FIFO)', () => {
    const first = msg('first', 'first');
    markSent('t1', [first]);
    for (let i = 0; i < 2100; i++) markSent('t1', [msg(`m${i}`, `text ${i}`)]);
    // The cap keeps the NEWEST entries; the oldest (first, m0, ...) fall out.
    assert.equal(isSent('t1', first), false);
    assert.equal(isSent('t1', msg('m2099', 'text 2099')), true);
    assert.ok(ledgerStats('t1').entries <= 2000, `entries ${ledgerStats('t1').entries} within cap`);
  });

  it('re-marking the same id with new content keeps both contents tracked (bytes, not ids, are the contract)', () => {
    markSent('t1', [msg('a', 'one')]);
    markSent('t1', [msg('a', 'two')]);
    assert.equal(isSent('t1', msg('a', 'two')), true);
    // 'one' was genuinely sent earlier - its bytes are cached, so freezing
    // it stays correct. Content matching has no "replacement" concept.
    assert.equal(isSent('t1', msg('a', 'one')), true);
    assert.equal(ledgerStats('t1').entries, 2);
  });

  it('tasks are isolated from each other', () => {
    markSent('t1', [msg('a', 'task one')]);
    markSent('t2', [msg('a', 'task two')]);
    assert.equal(isSent('t1', msg('a', 'task one')), true);
    assert.equal(isSent('t2', msg('a', 'task one')), false);
    clearTask('t2');
    assert.equal(isSent('t2', msg('a', 'task two')), false);
    assert.equal(isSent('t1', msg('a', 'task one')), true);
  });

  it('caps tracked tasks (LRU) so a long session cannot grow unbounded', () => {
    for (let i = 0; i < 60; i++) markSent(`task-${i}`, [msg('a', `content ${i}`)]);
    // Oldest task evicted, newest still tracked.
    assert.ok(ledgerStats('task-0').tracked === false);
    assert.ok(ledgerStats('task-59').tracked === true);
    assert.equal(isSent('task-59', msg('a', 'content 59')), true);
  });

  it('CACHE-003: touching an older task keeps it in LRU cache ahead of inactive tasks', () => {
    markSent('lru-old', [msg('a', 'initial')]);
    assert.ok(ledgerStats('lru-old').tracked === true);

    for (let i = 0; i < 45; i++) {
      markSent(`lru-fill-${i}`, [msg('a', `content ${i}`)]);
    }

    // Touch lru-old to refresh its recency
    assert.equal(isSent('lru-old', msg('a', 'initial')), true);

    // Add 10 more tasks (total exceeds 50 task limit)
    for (let i = 45; i < 55; i++) {
      markSent(`lru-fill-${i}`, [msg('a', `content ${i}`)]);
    }

    assert.ok(ledgerStats('lru-old').tracked === true, 'recently touched task is NOT evicted');
    assert.ok(ledgerStats('lru-fill-0').tracked === false, 'untouched old task is evicted first');
  });

  it('never throws on hostile input (host surface must stay unbreakable)', () => {
    assert.doesNotThrow(() => markSent('t1', [null as never, undefined as never, { id: '', content: '' } as never]));
    assert.doesNotThrow(() => markSent('t1', []));
    assert.doesNotThrow(() => isSent('t1', null as never));
    assert.equal(isSent('t1', null as never), false);
    assert.doesNotThrow(() => clearTask('never-seen'));
    // Messages without a usable id fall back to serialization matching.
    markSent('t1', [{ role: 'assistant', content: 'no id here' } as never]);
    assert.equal(isSent('t1', { role: 'assistant', content: 'no id here' } as never), true);
  });
});
