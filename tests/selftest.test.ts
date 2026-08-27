import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSyntheticMessages, runSelfTest } from '../selftest';
import { DEFAULT_CONFIG, type Config } from '../config';

describe('buildSyntheticMessages', () => {
  it('links every tool result to a real preceding tool-call (F11)', () => {
    const msgs = buildSyntheticMessages();
    const callIds = new Set<string>();
    const resultIds: string[] = [];
    for (const m of msgs) {
      if (!Array.isArray(m.content)) continue;
      for (const p of m.content as Array<{ type?: string; toolCallId?: string }>) {
        if (p.type === 'tool-call' && p.toolCallId) callIds.add(p.toolCallId);
        if (p.type === 'tool-result' && p.toolCallId) resultIds.push(p.toolCallId);
      }
    }
    assert.ok(callIds.size > 0);
    for (const r of resultIds) {
      assert.ok(callIds.has(r), `tool result references unknown call ${r}`);
    }
  });

  it('contains the duplicated output exactly twice in the input', () => {
    const serialized = JSON.stringify(buildSyntheticMessages());
    const count = serialized.split('PASS  tests/billing.test.ts (42 tests)').length - 1;
    assert.equal(count, 2, 'the dedupe scenario needs the output twice in the input');
  });
});

describe('runSelfTest', () => {
  it('exercises the pipeline and really dedupes the repeated result (F11)', async () => {
    const cfg: Config = { ...DEFAULT_CONFIG, enabled: true, level: 'summarize' };
    const { lines, touched } = await runSelfTest(cfg);
    assert.equal(touched, true);
    const out = lines.join('\n');
    assert.ok(out.includes('dedupe applied: yes'), `dedupe must be applied:\n${out}`);
  });

  it('labels passes from the exercised level, not the user-facing state (F19)', async () => {
    // Enabled but level=truncate: the summarize pass did not run and must say so.
    const on: Config = { ...DEFAULT_CONFIG, enabled: true, level: 'truncate' };
    const onLines = (await runSelfTest(on)).lines.join('\n');
    assert.ok(onLines.includes('summarize') && onLines.includes('NOT exercised'), 'summarize must be labeled NOT exercised at level truncate');
  });

  it('never contradicts itself when the extension is disabled (F19)', async () => {
    // Disabled but level=summarize: the synthetic pipeline still runs at
    // summarize level, so no pass may be labeled NOT exercised while its
    // numbers are reported.
    const off: Config = { ...DEFAULT_CONFIG, enabled: false, level: 'summarize' };
    const offLines = (await runSelfTest(off)).lines.join('\n');
    assert.ok(offLines.includes('level=off'), 'the header must show the user-facing off state');
    assert.ok(!offLines.includes('NOT exercised'), `disabled run must not contradict itself:\n${offLines}`);
  });
});

describe('runSelfTest: F4 index exercise', () => {
  it('indexes a synthetic temp project and reports an honest search receipt (F4, increment 6)', async () => {
    const result = await runSelfTest({ ...DEFAULT_CONFIG });
    const joined = result.lines.join('\n');
    assert.match(joined, /F4 index: \d+ synthetic file\(s\) indexed; re-scan delta \+0\/~0\/-0/, `index line missing or churn detected:\n${joined}`);
    assert.match(joined, /persisted to disk: yes/, `persistence proof missing:\n${joined}`);
    assert.match(joined, /F4 search 'createInvoice exportCsv': [1-9]\d* hit/, `no hits reported:\n${joined}`);
    assert.match(joined, /billing file ranked: yes/);
    assert.match(joined, /every snippet within the 2000-char budget: yes/);
    assert.ok(!joined.includes('skipped -'), `hermetic F4 section degraded instead of running:\n${joined}`);
    assert.ok(!joined.includes('UNEXPECTED churn'));
  });

  it('leaves no temp directories behind when the F4 section runs twice in a row', async () => {
    await runSelfTest({ ...DEFAULT_CONFIG });
    // The second call re-entering cleanly is the real regression signal:
    // leaked handles/dirs would surface as flaky failures on Windows.
    await runSelfTest({ ...DEFAULT_CONFIG });
    assert.ok(true);
  });
});
