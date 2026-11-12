import { open, stat, type FileHandle } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { ledgerFiles, MAX_MEASURE_FILE_BYTES, MAX_RECORD_HEADROOM_BYTES, MAX_ROTATED_FILES, MEASURE_PATH, measurementRevision } from './tokens';

export type StatisticsQuery = { scope: 'task' | 'retained'; page: number };
type Pass = 'structural' | 'error' | 'truncate' | 'summarize';
type PassChars = Record<Pass, number>;
export type StatisticsRun = {
  at: number; charsBefore: number; charsAfter: number; netChars: number;
  passChars: Record<Pass, number | null>; reconciliationChars: number | null;
};
export type StatisticsTaskExtras = {
  providerUsage: null | { provenance: 'last-available-completed-call'; sentTokens: number;
    cacheReadTokens: number | null; cacheWriteTokens: number | null };
  avoidedChars: { slice: number | null; search: number | null; flush: number | null };
};
export type StatisticsPage = {
  scope: 'task' | 'retained'; state: 'ready' | 'empty' | 'no-task' | 'partial';
  recordingEnabled: boolean; generatedAt: number; retainedFrom: number | null; retainedTo: number | null;
  /** Skipped records that count here: all of them in retained scope, only this task's records otherwise. */
  skippedRecords: number;
  /** Skipped ledger lines no task can be derived from (unparseable). Always global, never task-scoped. */
  unattributedRecords: number; unknownPassRecords: number;
  summary: null | { runs: number; charsBefore: number; charsAfter: number; netChars: number;
    passChars: PassChars; reconciliationChars: number | null };
  page: number; pageSize: 60; totalRuns: number; taskExtras: StatisticsTaskExtras | null; runs: StatisticsRun[];
};
export type StatisticsErrorCode = 'invalid-query' | 'read-failed' | 'data-limit' | 'unsafe-totals' | 'task-unavailable';
export class StatisticsError extends Error {
  constructor(readonly code: StatisticsErrorCode) {
    super({ 'invalid-query': 'Choose a valid statistics scope and page.',
      'read-failed': 'Recorded history could not be read. Retry to refresh it.',
      'data-limit': 'Recorded history exceeds the safe reading limit. Full totals are unavailable.',
      'unsafe-totals': 'Recorded history totals exceed the safe numeric range.',
      'task-unavailable': 'The current task could not be resolved. Reopen this panel to retry.' }[code]);
    this.name = 'StatisticsError';
  }
}

const PASSES: Pass[] = ['structural', 'error', 'truncate', 'summarize'];
/**
 * `appendJsonLine` checks the file size BEFORE appending, so each of the
 * `MAX_ROTATED_FILES + 1` files can hold one record past the rotation trigger.
 * The read budget must cover that ceiling: a tighter cap rejects the ledger's
 * own steady state with 'data-limit' instead of guarding against runaway data.
 */
export const MAX_LEDGER_READ_BYTES = (MAX_ROTATED_FILES + 1) * (MAX_MEASURE_FILE_BYTES + MAX_RECORD_HEADROOM_BYTES);
/** The shortest record is ~194 bytes, so the byte budget allows ~108k lines. */
export const MAX_LEDGER_READ_LINES = 250_000;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const counter = (value: unknown): number | null => integer(value) && value >= 0 ? value : null;
const safe = (value: number): number => { if (!Number.isSafeInteger(value)) throw new StatisticsError('unsafe-totals'); return value; };

/** Only scope/page can cross the renderer boundary; paths and caller task IDs cannot. */
export function validateStatisticsQuery(raw: unknown): StatisticsQuery {
  const query = object(raw);
  if (!query || Object.keys(query).some(key => key !== 'scope' && key !== 'page') ||
      (query.scope !== 'task' && query.scope !== 'retained') || !integer(query.page) || query.page < 0) {
    throw new StatisticsError('invalid-query');
  }
  return { scope: query.scope, page: query.page };
}

function taskExtras(raw: unknown): StatisticsTaskExtras {
  const source = object(raw);
  const usage = object(source?.providerUsage);
  const avoided = object(source?.avoidedChars);
  const sent = counter(usage?.sentTokens);
  return {
    providerUsage: sent === null ? null : { provenance: 'last-available-completed-call', sentTokens: sent,
      cacheReadTokens: counter(usage?.cacheReadTokens), cacheWriteTokens: counter(usage?.cacheWriteTokens) },
    avoidedChars: { slice: counter(avoided?.slice), search: counter(avoided?.search), flush: counter(avoided?.flush) },
  };
}

type StoredRun = StatisticsRun & { taskId: string };
type Snapshot = { generatedAt: number; revision: number; rows: StoredRun[]; skipped: Array<string | null> };
/**
 * One fingerprint per ledger file, in `ledgerFiles()` order. Any of the three
 * changing means the bytes are not the bytes we parsed: size for an appended
 * record, mtimeMs for a same-length rewrite, ino for a rotation that swapped the
 * file underneath. Absent files are part of the signature, so the first
 * appearance of a rotated file invalidates too.
 */
type LedgerSignature = string;

/**
 * Everything a query needs, named. The previous positional signature
 * (rawQuery, taskId, recordingEnabled, extras) put a `string | null` next to a
 * `boolean` and made the call site guess by position; these four travel together
 * from the same UI action and have no meaningful order.
 */
export type StatisticsRequest = {
  /** Untrusted renderer payload: only scope/page survive validation. */
  rawQuery: unknown;
  /** Host-resolved task, null for the retained scope or when no task is open. */
  taskId: string | null;
  recordingEnabled: boolean;
  /** Cached task counters (provider usage, avoided context). Never a ledger read. */
  extras: unknown;
};

/** Async bounded ledger reader. Never reads task content, provider APIs or configuration. */
export class StatisticsService {
  private cached: Snapshot | null = null;
  /** Fingerprint of the files `cached` was parsed from; null until the first read. */
  private signature: LedgerSignature | null = null;
  private pending: { revision: number; promise: Promise<Snapshot> } | null = null;
  constructor(private readonly filePath = MEASURE_PATH, private readonly now: () => number = Date.now) {}

  async query(request: StatisticsRequest): Promise<StatisticsPage> {
    const query = validateStatisticsQuery(request.rawQuery);
    const { taskId, recordingEnabled, extras } = request;
    const base: StatisticsPage = { scope: query.scope, state: 'empty', recordingEnabled, generatedAt: this.now(),
      retainedFrom: null, retainedTo: null, skippedRecords: 0, unattributedRecords: 0, unknownPassRecords: 0, summary: null,
      page: 0, pageSize: 60, totalRuns: 0, taskExtras: null, runs: [] };
    if (query.scope === 'task' && !taskId) return { ...base, state: 'no-task' };
    const snapshot = await this.snapshot();
    const rows = query.scope === 'retained' ? snapshot.rows : snapshot.rows.filter(row => row.taskId === taskId);
    base.generatedAt = snapshot.generatedAt;
    base.taskExtras = query.scope === 'task' ? taskExtras(extras) : null;
    // A task scope only counts records attributable to it: an unparseable line
    // is pushed with a null task id and belongs to no task, so it must not flip
    // a clean task to 'partial'. Retained scope reports every skipped record,
    // with the unattributable part broken out separately.
    base.skippedRecords = query.scope === 'retained' ? snapshot.skipped.length
      : snapshot.skipped.filter(id => id === taskId).length;
    base.unattributedRecords = snapshot.skipped.filter(id => id === null).length;
    base.unknownPassRecords = rows.filter(row => row.reconciliationChars === null).length;
    base.totalRuns = rows.length;
    base.state = base.skippedRecords || base.unknownPassRecords ? 'partial' : rows.length ? 'ready' : 'empty';
    if (!rows.length) return base;
    const passChars: PassChars = { structural: 0, error: 0, truncate: 0, summarize: 0 };
    let charsBefore = 0, charsAfter = 0;
    for (const row of rows) {
      charsBefore = safe(charsBefore + row.charsBefore);
      charsAfter = safe(charsAfter + row.charsAfter);
      for (const pass of PASSES) passChars[pass] = safe(passChars[pass] + (row.passChars[pass] ?? 0));
    }
    const netChars = safe(charsBefore - charsAfter);
    const passTotal = PASSES.reduce((sum, pass) => safe(sum + passChars[pass]), 0);
    base.summary = { runs: rows.length, charsBefore, charsAfter, netChars, passChars,
      reconciliationChars: base.unknownPassRecords ? null : safe(netChars - passTotal) };
    base.retainedFrom = rows[0].at;
    base.retainedTo = rows[rows.length - 1].at;
    base.page = Math.min(query.page, Math.ceil(rows.length / 60) - 1);
    const end = rows.length - base.page * 60;
    base.runs = rows.slice(Math.max(0, end - 60), end).map(({ taskId: _taskId, ...row }) => ({ ...row, passChars: { ...row.passChars } }));
    return base;
  }

  /**
   * The snapshot is revision-authoritative for THIS process and
   * signature-authoritative for every other writer.
   *
   * measurementRevision() is process-local, so it is the cheapest possible
   * freshness test for our own persistRunRecord()/clearTaskStats() calls: one
   * integer comparison, no I/O. It cannot see another process (the CLI/MCP
   * agents append to the same ledger, docs/agents/multi-agent-setup.md), so the
   * second gate is a per-file fingerprint of size + mtimeMs + ino. In the
   * steady state that is four stat() calls and zero bytes parsed; a changed
   * fingerprint triggers the full read immediately, so an external write is
   * visible on the next poll instead of at the next own write.
   *
   * Only an in-flight read for the SAME revision is shared: concurrent callers
   * collapse onto one read, which is what keeps a 5 s poll cheap.
   *
   * Measured cost of the fingerprint on Windows/NTFS, 4 stat() calls over an
   * empty ledger, 2000 samples: median 49 us, p95 153 us, p99 245 us. At the
   * 5 s poll that is ~0.005 % of one core, against ~20 MiB parsed per read for
   * a full refresh. `ino` is 0 on filesystems that do not report one; size and
   * mtimeMs then carry the append and rewrite cases.
   */
  private async snapshot(): Promise<Snapshot> {
    const revision = measurementRevision();
    // Fingerprint BEFORE deciding: this is the state the cached bytes describe.
    const signature = await this.ledgerSignature();
    if (this.cached?.revision === revision && this.signature === signature) return this.cached;
    // A foreign write invalidates the cached bytes; a changed revision means our
    // own persistRunRecord()/clearTaskStats() did. Both re-read immediately.
    if (this.pending?.revision === revision) return this.pending.promise;
    const promise = this.read(revision).then(snapshot => {
      if (measurementRevision() !== revision) return snapshot; // superseded mid-read
      this.cached = snapshot;
      // Store the PRE-read fingerprint: a write that lands during the read then
      // differs on the next poll, so it is seen instead of being masked by it.
      this.signature = signature;
      return snapshot;
    }).finally(() => { if (this.pending?.promise === promise) this.pending = null; });
    this.pending = { revision, promise };
    return promise;
  }

  /**
   * Fingerprint of the four ledger files, oldest rotation first. Every file
   * contributes an entry - including a missing one - so a file appearing,
   * disappearing or being replaced by a rotation changes the string.
   *
   * `ino` is the Windows file id and the POSIX inode; it is what catches a
   * rename-based rotation whose replacement is the same size as the original.
   * On a filesystem that reports no ino, size and mtimeMs still carry the
   * append and rewrite cases.
   */
  private async ledgerSignature(): Promise<LedgerSignature> {
    const files = ledgerFiles(this.filePath);
    const stamps = await Promise.all(files.map(async file => {
      try {
        const info = await stat(file);
        return `${info.size}:${info.mtimeMs}:${info.ino}`;
      } catch {
        return '-'; // missing or unreadable: one shared "absent" marker
      }
    }));
    return stamps.join('|');
  }

  private async read(revision: number): Promise<Snapshot> {
    const handles: FileHandle[] = [];
    const rows: StoredRun[] = [];
    const skipped: Array<string | null> = [];
    let lines = 0, bytes = 0, declaredBytes = 0;
    const consume = (line: string) => {
      if (++lines > MAX_LEDGER_READ_LINES) throw new StatisticsError('data-limit');
      if (!line.trim()) return;
      let value: unknown;
      try { value = JSON.parse(line); } catch { skipped.push(null); return; }
      const record = object(value);
      const taskId = typeof record?.taskId === 'string' && record.taskId.length ? record.taskId : null;
      if (!record || record.kind !== 'run' || !taskId || !integer(record.at) ||
          counter(record.charsBefore) === null || counter(record.charsAfter) === null) { skipped.push(taskId); return; }
      const passChars = Object.fromEntries(PASSES.map(pass => [pass, counter(record[`${pass}Chars`])])) as Record<Pass, number | null>;
      const charsBefore = record.charsBefore as number, charsAfter = record.charsAfter as number;
      const netChars = charsBefore - charsAfter;
      const passTotal = PASSES.reduce((sum, pass) => sum + (passChars[pass] ?? 0), 0);
      // An individually unsafe attribution is unknown, while measured sizes remain usable.
      const complete = PASSES.every(pass => passChars[pass] !== null) && Number.isSafeInteger(passTotal) && Number.isSafeInteger(netChars - passTotal);
      rows.push({ taskId, at: record.at, charsBefore, charsAfter, netChars, passChars,
        reconciliationChars: complete ? netChars - passTotal : null });
    };
    try {
      for (const path of ledgerFiles(this.filePath)) {
        let handle: FileHandle;
        try { handle = await open(path, 'r'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        handles.push(handle);
        const stat = await handle.stat();
        if (!stat.isFile()) throw new StatisticsError('read-failed');
        declaredBytes += stat.size;
        if (declaredBytes > MAX_LEDGER_READ_BYTES) throw new StatisticsError('data-limit');
      }
      const buffer = Buffer.alloc(64 * 1024);
      for (const handle of handles) {
        const decoder = new StringDecoder('utf8');
        let fragments: string[] = [];
        const chunk = (text: string) => {
          const pieces = text.split('\n');
          for (let index = 0; index < pieces.length - 1; index++) {
            fragments.push(pieces[index]); consume(fragments.join('')); fragments = [];
          }
          if (pieces[pieces.length - 1]) fragments.push(pieces[pieces.length - 1]);
        };
        for (;;) {
          const result = await handle.read(buffer, 0, Math.min(buffer.length, MAX_LEDGER_READ_BYTES - bytes + 1), null);
          if (!result.bytesRead) break;
          bytes += result.bytesRead;
          if (bytes > MAX_LEDGER_READ_BYTES) throw new StatisticsError('data-limit');
          chunk(decoder.write(buffer.subarray(0, result.bytesRead)));
        }
        chunk(decoder.end());
        if (fragments.length) consume(fragments.join(''));
      }
      rows.sort((a, b) => a.at - b.at);
      return { generatedAt: this.now(), revision, rows, skipped };
    } catch (error) {
      throw error instanceof StatisticsError ? error : new StatisticsError('read-failed');
    } finally {
      await Promise.all(handles.map(handle => handle.close().catch(() => undefined)));
    }
  }
}
