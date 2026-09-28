/**
 * The pure formatter behind `/broke diff`.
 *
 * AiderDesk 0.84 moved updated-file diffs from "computed with the file list"
 * to "loaded lazily on demand" and exposed `TaskContext.getUpdatedFileDiff`
 * to extensions. That makes the uncommitted diff readable for the first time
 * without shelling out to git - and the diff is usually the single largest
 * block of text in a coding session, so it is exactly the kind of thing that
 * deserves a token budget rather than a raw dump.
 *
 * This module is deliberately pure: no IO, no host access, no clock. The
 * caller supplies the rows and gets back text that respects a char budget.
 * Every size it reports is a real measurement, and anything it could not
 * measure is named as unknown rather than counted as zero.
 */

/** One changed file, with the diff content the host returned for it. */
export interface DiffFileInput {
  /** Repository-relative path, as returned by getUpdatedFiles(). */
  path: string;
  /** Lines added, per the host's own accounting. */
  additions: number;
  /** Lines deleted, per the host's own accounting. */
  deletions: number;
  /** Unified diff text. Empty for binary files AND on host-side error. */
  diff: string;
  /**
   * Set when the file was never even READ, because the caller hit its
   * per-command read cap. This is a third state, distinct from both a
   * readable diff and a binary/unreadable one, and the digest must say so:
   * rendering it as "unreadable" would blame the file for a limit broke
   * imposed, and rendering it as a size would invent a measurement.
   */
  notRead?: boolean;
}

export interface DiffDigest {
  /** The rendered digest, ready to log. */
  text: string;
  /** How many changed files the host reported. */
  files: number;
  /** How many file blocks the budget allowed. */
  shown: number;
  /** How many files were left out. Always `files - shown`. */
  elided: number;
  /** Total diff chars the host returned, shown or not. */
  diffChars: number;
}

/** Default output budget - the same order of magnitude as summarize.maxSummaryChars. */
export const DEFAULT_DIFF_BUDGET_CHARS = 4000;

/**
 * Bounds for a user-supplied `/broke diff <chars>` budget. The floor keeps a
 * request from producing a header with nothing under it; the ceiling keeps a
 * paste from dumping a 5 MB diff into the context, which is the exact failure
 * this command exists to prevent.
 */
export const MIN_DIFF_BUDGET_CHARS = 200;
export const MAX_DIFF_BUDGET_CHARS = 100_000;

/**
 * Hard cap on how many diffs ONE `/broke diff` run will read.
 *
 * The char budget bounds the OUTPUT; this bounds the WORK. Each diff is one
 * host round-trip that runs git, so an unbounded read loop turns the command
 * into a minute-long hang on a repository with thousands of changed files -
 * to produce a digest whose budget would have cut most of them anyway. Files
 * past the cap are reported as not read.
 */
export const MAX_DIFF_FILES_READ = 200;

/**
 * The header and the elision line are accounting, not payload: they are
 * allowed to exceed the budget by this much so a tight budget still produces
 * an honest digest rather than a truncated sentence.
 */
export const DIFF_DIGEST_OVERHEAD_CHARS = 400;

const fmt = (n: number): string => n.toLocaleString('en-US');

/**
 * Render one file's block, cut at `available` chars. Returns the block and
 * the block's own length; the caller decides whether it fit.
 */
function renderBlock(input: DiffFileInput, available: number): { block: string; length: number } {
  const header = `${input.path} (+${input.additions}/-${input.deletions})`;
  // "Never read" is broke's own doing, so it gets its own wording: blaming
  // the file would be false, and a size would be invented.
  if (input.notRead) {
    const block = `${header}\n  (not read - broke stops after ${fmt(MAX_DIFF_FILES_READ)} diffs per run)`;
    return { block, length: block.length + 1 };
  }
  // An empty diff is the host's documented signal for "binary file" or "the
  // diff could not be read". It is NOT a size of zero and must never be
  // rendered as one - a file with no changes and a file whose content cannot
  // be shown are different facts.
  if (!input.diff.trim()) {
    const block = `${header}\n  (binary or unreadable - no diff available)`;
    return { block, length: block.length + 1 };
  }
  const body = input.diff.slice(0, Math.max(0, available));
  const cut = body.length < input.diff.length;
  const block = `${header}\n${body}${cut ? '\n  [diff truncated]' : ''}`;
  return { block, length: block.length + 1 };
}

/**
 * Build a budgeted digest of the uncommitted changes.
 *
 * The budget bounds the FILE BLOCKS. Files are shown in the order given (the
 * host's own ordering) and the walk stops at the first block that would not
 * fit, so the elision is a contiguous tail and `elided` is exact.
 */
export function formatDiffDigest(files: readonly DiffFileInput[], budgetChars: number): DiffDigest {
  const budget = Number.isFinite(budgetChars) && budgetChars > 0 ? Math.floor(budgetChars) : DEFAULT_DIFF_BUDGET_CHARS;

  // Only diffs the host actually returned text for count as a measured size.
  // A binary or unreadable file contributes nothing here AND is named in the
  // header - summing its absence into "0 chars of diff" would claim a
  // measurement that was never taken. A never-read file is a third bucket
  // again: broke did not ask, so it is not a size and not the file's fault.
  const notRead = files.filter((f) => f.notRead === true);
  const attempted = files.filter((f) => f.notRead !== true);
  const readable = attempted.filter((f) => f.diff.trim().length > 0);
  const unreadable = attempted.length - readable.length;
  const diffChars = readable.reduce((sum, f) => sum + f.diff.length, 0);
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);

  if (files.length === 0) {
    return {
      text: 'broke diff - no updated files in this task (nothing to summarize).',
      files: 0,
      shown: 0,
      elided: 0,
      diffChars: 0,
    };
  }

  // When nothing was readable, the size is not a zero - it is unknown. Never
  // print a number that could be misread as "these files have no changes".
  const sizeParts: string[] = [];
  if (readable.length > 0) {
    sizeParts.push(`${fmt(diffChars)} chars of diff across ${fmt(readable.length)} readable file${readable.length === 1 ? '' : 's'}`);
  } else if (notRead.length < files.length) {
    sizeParts.push('no readable diff text');
  }
  if (unreadable > 0) sizeParts.push(`${fmt(unreadable)} binary or unreadable (size unknown)`);
  if (notRead.length > 0) sizeParts.push(`${fmt(notRead.length)} not read (per-run read cap)`);
  const header =
    `broke diff - ${fmt(files.length)} changed file${files.length === 1 ? '' : 's'}, ` +
    `+${fmt(additions)}/-${fmt(deletions)} lines, ${sizeParts.join(', ')}.`;

  const blocks: string[] = [];
  let used = 0;
  for (const input of files) {
    const remaining = budget - used;
    if (remaining <= 0) break;
    const { block, length } = renderBlock(input, remaining);
    if (used + length > budget) break; // this block would overflow; stop honestly
    blocks.push(block);
    used += length;
  }

  const shown = blocks.length;
  const elided = files.length - shown;
  const parts = [header, ...blocks];
  if (elided > 0) {
    parts.push(
      `[${fmt(elided)} of ${fmt(files.length)} file${files.length === 1 ? '' : 's'} not shown - ` +
        `raise the budget (/broke diff <chars>) to see more]`,
    );
  }
  return { text: parts.join('\n\n'), files: files.length, shown, elided, diffChars };
}
