/**
 * ST-Slicing (Semantic Context Thinning, F2): heuristic interface-view
 * extraction. Pure module - no I/O, no dependencies (Broke stays zod-only).
 *
 * The v1 parser is deliberately regex/line-based: it must never crash on
 * arbitrary input and always errs toward "pass through more" over "drop
 * something important". Callers (index.ts hooks) gate on size caps and fall
 * back to full content whenever the view looks wrong.
 */

export type SliceLang = 'ts' | 'py';

/** Extensions eligible for slicing, mapped to their parser language. */
export const SLICEABLE_EXT: Record<string, SliceLang> = {
  '.ts': 'ts',
  '.tsx': 'ts',
  '.js': 'ts',
  '.jsx': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.py': 'py',
};

/** Directories whose contents are never sliced (build output, deps, internals). */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'vendor',
  '.git',
  '.aider-desk',
  'coverage',
  '.next',
]);

export interface SlicedView {
  text: string;
  originalLines: number;
  keptLines: number;
}

/** Language for a file path, or null when the extension is not sliceable. */
export function sliceableLang(filePath: string): SliceLang | null {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return null;
  return SLICEABLE_EXT[filePath.slice(dot).toLowerCase()] ?? null;
}

/** False inside dependency/build/internal directories (checked per segment). */
export function isSliceablePath(filePath: string): boolean {
  const segments = filePath.split(/[\\/]/);
  return !segments.some((s) => SKIP_DIRS.has(s.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Shared line utilities
// ---------------------------------------------------------------------------

const BODY_ELLIPSIS_TS = '{ /* … */ }';
const ELLIPSIS_PY = '…';
const MAX_DOCSTRING_LINES = 5;
/** Runaway guard for statement readers (pathological files must not stall). */
const MAX_STATEMENT_LINES = 50;

/** Blank string literals and line comments so brackets inside them do not count. */
function stripStrings(line: string): string {
  let s = line.replace(/\/\/.*$/, '');
  s = s.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  s = s.replace(/`(?:[^`\\]|\\.)*`/g, '``');
  return s;
}

/** Net bracket depth delta of one line (heuristic: regex literals can skew it). */
function depthDelta(line: string): number {
  let d = 0;
  for (const ch of stripStrings(line)) {
    if (ch === '{' || ch === '(' || ch === '[') d++;
    else if (ch === '}' || ch === ')' || ch === ']') d--;
  }
  return d;
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

/**
 * Read one self-delimiting statement/block starting at `start`: consumed
 * until brackets re-balance and the line terminates (`;`, `}` or `)`), or -
 * for opener-less single lines like `import os` - immediately after the
 * first line that neither opens a bracket nor ends in a continuation char.
 */
function readBalanced(lines: string[], start: number): { text: string[]; end: number } {
  const acc: string[] = [];
  let depth = 0;
  let opened = false;
  for (let i = start; i < Math.min(lines.length, start + MAX_STATEMENT_LINES); i++) {
    const l = lines[i];
    acc.push(l);
    depth += depthDelta(l);
    if (depth > 0) opened = true;
    const t = l.trim();
    if (opened && depth <= 0) return { text: acc, end: i };
    const continues = /[=+:,([{|&?.\\{}]$/.test(t);
    if (!opened && depth <= 0 && !continues) return { text: acc, end: i };
  }
  return { text: acc, end: Math.min(start + MAX_STATEMENT_LINES, lines.length) - 1 };
}

/** Skip a `/* ... *&#47;` or line comment starting at `start`; returns the next index to process. */
function skipComment(lines: string[], start: number): number {
  const t = lines[start].trim();
  if (t.startsWith('//') || !t.startsWith('/*')) return start + 1;
  for (let i = start; i < lines.length; i++) {
    if (lines[i].includes('*/')) return i + 1;
  }
  return lines.length;
}

/** Advance past every line indented deeper than `ownerIndent` (Python block skip). */
function skipIndentedBlock(lines: string[], from: number, ownerIndent: number): number {
  let i = from;
  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim() === '' || indentOf(raw) > ownerIndent) {
      i++;
      continue;
    }
    break;
  }
  return i;
}

/**
 * Read a class header: consumed only up to the line containing the
 * body-opening `{` - never into the class body (a generic balanced reader
 * would swallow the whole class as one "statement").
 */
function readClassHeader(lines: string[], start: number): { text: string[]; end: number } {
  const acc: string[] = [];
  let paren = 0;
  const limit = Math.min(lines.length, start + 20);
  for (let i = start; i < limit; i++) {
    const stripped = stripStrings(lines[i]);
    let opened = false;
    for (let c = 0; c < stripped.length; c++) {
      const ch = stripped[c];
      if (ch === '(' || ch === '[') paren++;
      else if (ch === ')' || ch === ']') paren--;
      else if (ch === '{' && paren <= 0) {
        opened = true;
        break;
      }
    }
    acc.push(lines[i]);
    if (opened) return { text: acc, end: i };
  }
  return { text: acc, end: limit - 1 };
}

// ---------------------------------------------------------------------------
// TypeScript slicing
// ---------------------------------------------------------------------------

interface SliceOptions {
  /** When set, the declaration with this name keeps its FULL body (focus symbol). */
  fullSymbol?: string;
}

const TS_CLASS_RE = /^(?:(?:export|declare|abstract)\s+)*class\s+([\w$]+)/;
const TS_INTERFACE_RE = /^(?:(?:export|declare)\s+)*(?:abstract\s+)?(?:interface\s+[\w$]+|enum\s+[\w$]+|namespace\s+[\w$.]+)/;
const TS_TYPE_RE = /^(?:export\s+)?type\s+[\w$]+/;
const TS_FUNC_RE = /^(?:(?:export\s+)?(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([\w$]+)/;
const TS_CONST_FUNC_RE = /^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]*)?=\s*(?:async\s*)?[<(]/;
const TS_CONST_RE = /^(?:export\s+)?(?:const|let|var)\s+/;

interface MemberStatement {
  /** Consumed lines (signature portion only when hasBody). */
  text: string[];
  endIdx: number;
  /** True when the statement opens a `{ ... }` body (method). */
  hasBody: boolean;
  /** Signature lines up to (not including) the body `{`. */
  sigLines: string[];
  openLineIdx: number;
  openCol: number;
}

/**
 * Read one class/top-level member statement: stops at the body-opening `{`
 * (methods) or at the terminating `;` (properties, signature-only members).
 * Never crosses into a body - body skipping is a separate step.
 */
function readMemberStatement(lines: string[], start: number): MemberStatement | null {
  const prev: string[] = [];
  let paren = 0;
  const limit = Math.min(lines.length, start + MAX_STATEMENT_LINES);
  for (let i = start; i < limit; i++) {
    const l = lines[i];
    const stripped = stripStrings(l);
    for (let c = 0; c < stripped.length; c++) {
      const ch = stripped[c];
      if (ch === '(' || ch === '[') paren++;
      else if (ch === ')' || ch === ']') paren--;
      else if (ch === '{' && paren <= 0) {
        return {
          text: [...prev, l],
          endIdx: i,
          hasBody: true,
          sigLines: [...prev, l.slice(0, c).trimEnd()],
          openLineIdx: i,
          openCol: c,
        };
      } else if ((ch === ';' || ch === '}') && paren <= 0) {
        return { text: [...prev, l], endIdx: i, hasBody: false, sigLines: [], openLineIdx: -1, openCol: -1 };
      }
    }
    prev.push(l);
  }
  return null;
}

/** Skip a method body after its opening `{`; returns the index of the CLOSING line. */
function skipBraceBody(lines: string[], openLineIdx: number, openCol: number): number {
  let depth = 1 + depthDelta(stripStrings(lines[openLineIdx]).slice(openCol + 1));
  for (let i = openLineIdx + 1; i < lines.length; i++) {
    depth += depthDelta(lines[i]);
    if (depth <= 0) return i;
  }
  return lines.length - 1;
}

function emitElidedMethod(
  lines: string[],
  stmt: MemberStatement,
  push: (l: string) => void,
): number {
  stmt.sigLines.slice(0, -1).forEach(push);
  push(`${stmt.sigLines[stmt.sigLines.length - 1]} ${BODY_ELLIPSIS_TS}`);
  return skipBraceBody(lines, stmt.openLineIdx, stmt.openCol) + 1;
}

function sliceTs(lines: string[], opts: SliceOptions): string[] {
  const out: string[] = [];
  let blankEmitted = false;
  const push = (line: string): void => {
    if (line.trim() === '') {
      if (!blankEmitted) out.push('');
      blankEmitted = true;
      return;
    }
    out.push(line);
    blankEmitted = false;
  };

  const fullSymbol = opts.fullSymbol ?? null;
  let pendingDecorators: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();

    if (t === '') {
      push('');
      i++;
      continue;
    }
    if (t.startsWith('@')) {
      pendingDecorators.push(t);
      i++;
      continue;
    }
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) {
      i = skipComment(lines, i);
      continue;
    }

    // Imports and re-exports stay complete (multi-line included).
    if (
      (/^(?:import|export)\b/.test(t) && (t.includes(' from ') || /^import\s*['"]/.test(t) || /^export\s+(?:\*|\{)/.test(t))) ||
      /^import\s+\{/.test(t)
    ) {
      const st = readBalanced(lines, i);
      st.text.forEach(push);
      i = st.end + 1;
      continue;
    }

    // Full-block kinds: interfaces, enums, namespaces, ambient declares.
    if (TS_INTERFACE_RE.test(t)) {
      const block = readBalanced(lines, i);
      pendingDecorators.forEach(push);
      pendingDecorators = [];
      block.text.forEach(push);
      i = block.end + 1;
      continue;
    }

    // Type aliases stay complete - they are pure contract.
    if (TS_TYPE_RE.test(t)) {
      const st = readBalanced(lines, i);
      pendingDecorators.forEach(push);
      pendingDecorators = [];
      st.text.forEach(push);
      i = st.end + 1;
      continue;
    }

    // Classes: header + member signatures, bodies elided (or full when focus).
    const cls = t.match(TS_CLASS_RE);
    if (cls) {
      pendingDecorators.forEach(push);
      pendingDecorators = [];
      if (fullSymbol === cls[1]) {
        const block = readBalanced(lines, i);
        block.text.forEach(push);
        i = block.end + 1;
      } else {
        const header = readClassHeader(lines, i);
        header.text.forEach(push);
        i = scanClassMembers(lines, header.end + 1, push, fullSymbol);
      }
      continue;
    }

    // Named function declarations.
    const fn = t.match(TS_FUNC_RE);
    if (fn) {
      pendingDecorators.forEach(push);
      pendingDecorators = [];
      if (fullSymbol === fn[1]) {
        const block = readBalanced(lines, i);
        block.text.forEach(push);
        i = block.end + 1;
      } else {
        const stmt = readMemberStatement(lines, i);
        if (stmt?.hasBody) i = emitElidedMethod(lines, stmt, push);
        else if (stmt) {
          stmt.text.forEach(push);
          i = stmt.endIdx + 1;
        } else i++;
      }
      continue;
    }

    // Arrow-function consts behave like named functions.
    const arrowFn = t.match(TS_CONST_FUNC_RE);
    if (arrowFn) {
      pendingDecorators.forEach(push);
      pendingDecorators = [];
      if (fullSymbol === arrowFn[1]) {
        const block = readBalanced(lines, i);
        block.text.forEach(push);
        i = block.end + 1;
      } else {
        const stmt = readMemberStatement(lines, i);
        if (stmt?.hasBody) i = emitElidedMethod(lines, stmt, push);
        else if (stmt) {
          // Expression-bodied arrow (no braces): a one-liner API surface - keep it.
          stmt.text.forEach(push);
          i = stmt.endIdx + 1;
        } else i++;
      }
      continue;
    }

    // Value constants/lets: short ones survive, long initializers are elided.
    if (TS_CONST_RE.test(t)) {
      const st = readBalanced(lines, i);
      pendingDecorators.forEach(push);
      pendingDecorators = [];
      if (st.text.length <= 2) st.text.forEach(push);
      else push(`${st.text[0].trimEnd()} /* … */;`);
      i = st.end + 1;
      continue;
    }

    // Everything else is implementation detail - skipped in v1.
    i++;
  }
  return out;
}

/**
 * Scan class members from `start` until the class closes (returns the index
 * AFTER the closing brace). Keeps method signatures (bodies elided) and
 * decorated properties; drops plain property initializers (implementation
 * state, not contract).
 */
function scanClassMembers(lines: string[], start: number, push: (l: string) => void, fullSymbol: string | null): number {
  const decos: string[] = [];
  let i = start;
  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();

    if (t.startsWith('@')) {
      decos.push(t);
      i++;
      continue;
    }
    if (t === '' || t.startsWith('//') || t.startsWith('*')) {
      i++;
      continue;
    }
    if (t.startsWith('/*')) {
      i = skipComment(lines, i);
      continue;
    }
    if (t.startsWith('}')) {
      push('}');
      return i + 1; // class closed
    }

    const stmt = readMemberStatement(lines, i);
    if (!stmt) {
      i++;
      continue;
    }

    // Member name: first identifier directly followed by '<' or '(' .
    const joined = stmt.text.join('\n');
    const nameMatch = joined.match(/(?:^|\n|\s)([\w$]+)\s*[<(]/);
    const keepFull = !!fullSymbol && nameMatch?.[1] === fullSymbol;

    if (!stmt.hasBody) {
      // Property / signature-only member: keep only when decorated (or focus).
      if (decos.length > 0 || keepFull) {
        decos.forEach(push);
        stmt.text.forEach(push);
      }
      decos.length = 0;
      i = stmt.endIdx + 1;
      continue;
    }

    // Method with body.
    decos.forEach(push);
    decos.length = 0;
    if (keepFull) {
      const block = readBalanced(lines, i);
      block.text.forEach(push);
      i = block.end + 1;
    } else {
      i = emitElidedMethod(lines, stmt, push);
    }
  }
  push('}');
  return Math.min(i, lines.length);
}

// ---------------------------------------------------------------------------
// Python slicing
// ---------------------------------------------------------------------------

const PY_DEF_RE = /^(?:async\s+)?def\s+([\w$]+)/;
const PY_CLASS_RE = /^class\s+([\w$.]+)/;

/** Join a (possibly multi-line) def/class header into one logical signature line. */
function pySignature(lines: string[], start: number): { sig: string; end: number } {
  const acc: string[] = [];
  let depth = 0;
  for (let i = start; i < Math.min(lines.length, start + MAX_STATEMENT_LINES); i++) {
    acc.push(lines[i]);
    depth += depthDelta(lines[i]);
    const t = lines[i].trim();
    if (depth <= 0 && t.endsWith(':')) return { sig: acc.join(' ').replace(/\s+/g, ' ').trim(), end: i };
  }
  return { sig: acc.join(' ').replace(/\s+/g, ' ').trim(), end: Math.min(start + MAX_STATEMENT_LINES, lines.length) - 1 };
}

/** Skip a triple-quoted string block; returns the index AFTER the closing quotes. */
function skipTripleQuoted(lines: string[], start: number): number {
  const quote = lines[start].trim().slice(0, 3);
  const singleLine = lines[start].trim().length > 3 && lines[start].trim().endsWith(quote);
  if (singleLine) return start + 1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].includes(quote)) return i + 1;
  }
  return lines.length;
}

function slicePy(lines: string[], opts: SliceOptions): string[] {
  const out: string[] = [];
  let blankEmitted = false;
  const push = (line: string): void => {
    if (line.trim() === '') {
      if (!blankEmitted) out.push('');
      blankEmitted = true;
      return;
    }
    out.push(line);
    blankEmitted = false;
  };

  const fullSymbol = opts.fullSymbol ?? null;
  let i = 0;

  // Module docstring: first non-blank statement, capped at MAX_DOCSTRING_LINES content lines.
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && /^["']{3}/.test(lines[i].trim())) {
    const quote = lines[i].trim().slice(0, 3);
    if (skipTripleQuoted(lines, i) === i + 1) {
      push(lines[i]);
      i++;
    } else {
      push(lines[i]);
      let content = 0;
      i++;
      while (i < lines.length && !lines[i].includes(quote)) {
        if (content < MAX_DOCSTRING_LINES) push(lines[i]);
        else if (content === MAX_DOCSTRING_LINES) push('  …');
        content++;
        i++;
      }
      if (i < lines.length) {
        push(lines[i].trim());
        i++;
      }
    }
  }

  let pendingDeco: string[] = [];
  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();
    if (t === '') {
      push('');
      i++;
      continue;
    }
    if (t.startsWith('#')) {
      i++;
      continue;
    }
    if (t.startsWith('@')) {
      pendingDeco.push(t);
      i++;
      continue;
    }
    if (/^["']{3}/.test(t)) {
      i = skipTripleQuoted(lines, i);
      continue;
    }

    const def = t.match(PY_DEF_RE);
    if (def) {
      const ownerIndent = indentOf(raw);
      const { sig, end } = pySignature(lines, i);
      pendingDeco.forEach(push);
      pendingDeco = [];
      if (fullSymbol === def[1]) {
        // Focus symbol: keep the whole function verbatim.
        const blockEnd = skipIndentedBlock(lines, end + 1, ownerIndent);
        lines.slice(i, blockEnd).forEach(push);
        i = blockEnd;
      } else {
        push(`${sig} ${ELLIPSIS_PY}`);
        i = skipIndentedBlock(lines, end + 1, ownerIndent);
      }
      continue;
    }

    const cls = t.match(PY_CLASS_RE);
    if (cls) {
      pendingDeco.forEach(push);
      pendingDeco = [];
      if (fullSymbol === cls[1]) {
        const blockEnd = skipIndentedBlock(lines, i + 1, indentOf(raw));
        lines.slice(i, blockEnd).forEach(push);
        i = blockEnd;
      } else {
        push(raw.trimEnd());
        i = scanPyClassBody(lines, i + 1, indentOf(raw), push, fullSymbol);
      }
      continue;
    }

    if (/^(?:from|import)\s+/.test(t)) {
      const st = readBalanced(lines, i);
      st.text.forEach(push);
      i = st.end + 1;
      continue;
    }

    // Constants, bare code, everything else: implementation detail - skipped.
    i++;
  }
  return out;
}

/** Class-body scanner: keeps field annotations and def signatures, elides bodies. */
function scanPyClassBody(
  lines: string[],
  start: number,
  classIndent: number,
  push: (l: string) => void,
  fullSymbol: string | null,
): number {
  let pendingDeco: string[] = [];
  let i = start;
  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();
    if (t === '') {
      i++;
      continue;
    }
    const ind = indentOf(raw);
    if (ind <= classIndent) break; // class ended

    if (t.startsWith('#')) {
      i++;
      continue;
    }
    if (t.startsWith('@')) {
      pendingDeco.push(t);
      i++;
      continue;
    }
    if (/^["']{3}/.test(t)) {
      i = skipTripleQuoted(lines, i);
      continue;
    }

    const def = t.match(PY_DEF_RE);
    if (def) {
      const { sig, end } = pySignature(lines, i);
      pendingDeco.forEach(push);
      pendingDeco = [];
      if (fullSymbol === def[1]) {
        const blockEnd = skipIndentedBlock(lines, end + 1, ind);
        lines.slice(i, blockEnd).forEach(push);
        i = blockEnd;
      } else {
        push(`${sig} ${ELLIPSIS_PY}`);
        i = skipIndentedBlock(lines, end + 1, ind);
      }
      continue;
    }

    // Annotated field declarations are the data contract (dataclasses etc.).
    if (/^[\w]+\s*:\s*/.test(t) && !t.includes('(')) {
      pendingDeco.forEach(push);
      pendingDeco = [];
      push(raw.trimEnd());
      i++;
      continue;
    }

    i++;
  }
  return i;
}

// ---------------------------------------------------------------------------
// Public slicing API
// ---------------------------------------------------------------------------

export function sliceInterfaces(source: string, lang: SliceLang, opts: SliceOptions = {}): SlicedView {
  const lines = source.split('\n');
  const outLines = lang === 'ts' ? sliceTs(lines, opts) : slicePy(lines, opts);
  return { text: outLines.join('\n'), originalLines: lines.length, keptLines: outLines.length };
}

/** Case-insensitive path comparison across separators (Windows-safe). */
export function sameSlicePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

/**
 * Slice with focus resolution: when `currentPath` IS the focus file, the
 * full source passes through untouched (optionally reduced to nothing less
 * than the focus symbol's full body). Any other file is sliced normally.
 */
export function sliceWithFocus(
  source: string,
  lang: SliceLang,
  focus: { file: string; symbol?: string } | null,
  currentPath?: string | null,
): SlicedView {
  if (!focus || !currentPath || !sameSlicePath(focus.file, currentPath)) {
    return sliceInterfaces(source, lang);
  }
  const lines = source.split('\n');
  const passthrough = (): SlicedView => ({ text: source, originalLines: lines.length, keptLines: lines.length });
  if (!focus.symbol) return passthrough();

  const symRe = new RegExp(
    `(?:\\b(?:function|class|interface|type|enum|const|let|var|def)\\s+${focus.symbol}\\b)|(?:^(?:\\s|(?:private|protected|public|static|async|override|get|set)\\s)+${focus.symbol}\\s*[(<:])`,
    'm',
  );
  if (!symRe.test(source)) return passthrough(); // unresolvable symbol -> honest fallback: full file
  return sliceInterfaces(source, lang, { fullSymbol: focus.symbol });
}

/** Marker prepended to a sliced view by the hooks (escape hatch included). */
export function sliceMarker(view: SlicedView): string {
  return `[broke: interface view - ${view.keptLines} of ${view.originalLines} lines. Full body only for the focus file (run /broke slice focus <path> or /broke slice off to disable)]`;
}

/** Marker prepended when a focus file passes through in full. */
export const FOCUS_MARKER = '[broke: focus file - full content]';

// ---------------------------------------------------------------------------
// Tool detection (hook wiring support, S4 feature-detect pattern)
// ---------------------------------------------------------------------------

const READ_TOOL_RE = /file_read$|read_file|^read$|^view$|open_file/i;
const EDIT_TOOL_RE = /file_edit$|edit_file|^write$|write_file|^edit$|replace_in_file|^apply/i;
/** Input fields that plausibly carry the target path, in priority order. */
const PATH_KEYS = ['filePath', 'path', 'file', 'absolute_path', 'notebook_path'] as const;

/** First plausible target path from a tool-call input, or null. */
export function extractTargetPath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  for (const key of PATH_KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

/**
 * A read tool is a NAME match AND carries a path field - names differ across
 * environments (S4), so the input shape is the second factor.
 */
export function isReadTool(toolName: string, input: unknown): boolean {
  return READ_TOOL_RE.test(toolName) && extractTargetPath(input) !== null;
}

/** Name-only pre-check for hook gating (the two-factor rule needs the input too). */
export function looksLikeReadTool(toolName: string): boolean {
  return READ_TOOL_RE.test(toolName);
}

/** Same two-factor rule for edit/write tools (focus tracking via onToolCalled). */
export function isEditTool(toolName: string, input: unknown): boolean {
  return EDIT_TOOL_RE.test(toolName) && extractTargetPath(input) !== null;
}
