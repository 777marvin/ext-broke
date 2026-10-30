/**
 * Multi-Agent Configuration Installer (`broke install-agent <agent>`).
 *
 * Performs strict pre-flight validation, targeted AST/object edits that
 * preserve unrelated user configuration, comments, foreign hooks, and line
 * endings, and atomic temporary-sibling file replacement with full rollback.
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import * as tomlParserNs from 'toml-eslint-parser';
import type { AST as TomlAST } from 'toml-eslint-parser';
import { buildWorkflowPromptText } from './mcp';

const tomlParser = (
  (tomlParserNs as unknown as { default?: typeof tomlParserNs }).default ?? tomlParserNs
) as typeof tomlParserNs;

export const SUPPORTED_INSTALL_AGENTS = ['claude', 'antigravity', 'codex', 'cursor'] as const;
export type SupportedInstallAgent = (typeof SUPPORTED_INSTALL_AGENTS)[number];

export interface InstallAgentFsOps {
  mkdirSync?: (dirPath: string) => void;
  writeFileSync?: (filePath: string, data: Buffer) => void;
  renameSync?: (oldPath: string, newPath: string) => void;
  rmSync?: (filePath: string) => void;
}

export interface InstallAgentOptions {
  agent: SupportedInstallAgent;
  targetDir: string;
  dryRun?: boolean;
  runnerPath?: string;
  /** Optional internal seam for fault-injection tests of atomic writes and rollback. */
  fsOps?: InstallAgentFsOps;
}

export interface PlannedFileWrite {
  path: string;
  content: string;
  description: string;
}

const BROKE_AGENTS_MD_MARKER_START = '<!-- broke:multi-agent:start -->';
const BROKE_AGENTS_MD_MARKER_END = '<!-- broke:multi-agent:end -->';
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function validateRunnerPath(runnerPath: string): void {
  if (typeof runnerPath !== 'string' || runnerPath.trim().length === 0) {
    throw new Error('Invalid runnerPath: expected a non-empty path string');
  }
  if (runnerPath.includes('\0')) {
    throw new Error('Invalid runnerPath: path must not contain NUL bytes');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function detectEol(source: string): '\r\n' | '\n' {
  let crlf = 0;
  let bareLf = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') {
      if (i > 0 && source[i - 1] === '\r') {
        crlf += 1;
      } else {
        bareLf += 1;
      }
    }
  }
  return crlf > 0 && crlf >= bareLf ? '\r\n' : '\n';
}

function readExistingTextOrNull(filePath: string): string | null {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to inspect ${filePath}: ${errorMessage(err)}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Expected regular file at ${filePath}`);
  }
  let rawBytes: Buffer;
  try {
    rawBytes = readFileSync(filePath);
  } catch (err) {
    throw new Error(`Failed to read ${filePath}: ${errorMessage(err)}`);
  }
  let decoded: string;
  try {
    decoded = strictUtf8Decoder.decode(rawBytes);
  } catch (err) {
    throw new Error(`Invalid UTF-8 in ${filePath}: ${errorMessage(err)}`);
  }
  if (decoded.includes('\0')) {
    throw new Error(`Invalid or binary text (NUL byte) in ${filePath}`);
  }
  return decoded;
}

function ensureRegularOrMissingTarget(filePath: string): void {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return;
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (!stat.isFile()) {
    throw new Error(`Expected regular file at ${filePath}`);
  }
  try {
    readFileSync(filePath);
  } catch (err) {
    throw new Error(`Failed to read ${filePath}: ${errorMessage(err)}`);
  }
}

function ensureValidTargetDirectory(targetDir: string): void {
  try {
    lstatSync(targetDir);
    let resolvedStat;
    try {
      resolvedStat = statSync(targetDir);
    } catch (err) {
      throw new Error(`Install target ${targetDir} is a broken link or inaccessible directory: ${errorMessage(err)}`);
    }
    if (!resolvedStat.isDirectory()) {
      throw new Error(`Install target ${targetDir} exists and is not a directory`);
    }
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  let ancestor = dirname(targetDir);
  while (true) {
    try {
      lstatSync(ancestor);
      let ancestorStat;
      try {
        ancestorStat = statSync(ancestor);
      } catch (err) {
        throw new Error(
          `Install target ancestor ${ancestor} is a broken link or inaccessible directory: ${errorMessage(err)}`,
        );
      }
      if (!ancestorStat.isDirectory()) {
        throw new Error(`Install target ancestor ${ancestor} exists and is not a directory`);
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        const parent = dirname(ancestor);
        if (parent === ancestor) {
          throw new Error(`No existing ancestor directory for ${targetDir}`);
        }
        ancestor = parent;
        continue;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}

function ensureSafeParentDirectories(targetRoot: string, filePath: string): void {
  const relDir = relative(targetRoot, dirname(filePath));
  if (!relDir || relDir === '.') return;
  const parts = relDir.split(sep).filter(Boolean);
  let cur = targetRoot;
  for (const part of parts) {
    cur = join(cur, part);
    try {
      const st = lstatSync(cur);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`Refusing to traverse non-directory or symlinked path ${cur}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        break;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}

// ---------------------------------------------------------------------------
// TOML Serializer & Targeted Source-Range Editor (`updateCodexToml`)
// ---------------------------------------------------------------------------

function formatTomlBasicString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    const code = value.charCodeAt(i);
    if (ch === '\\') {
      out += '\\\\';
    } else if (ch === '"') {
      out += '\\"';
    } else if (code === 0x08) {
      out += '\\b';
    } else if (code === 0x09) {
      out += '\\t';
    } else if (code === 0x0a) {
      out += '\\n';
    } else if (code === 0x0c) {
      out += '\\f';
    } else if (code === 0x0d) {
      out += '\\r';
    } else if (code <= 0x1f || code === 0x7f) {
      out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      if (code <= 0xdbff && i + 1 < value.length) {
        const low = value.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          out += ch + value[i + 1]!;
          i += 1;
          continue;
        }
      }
      throw new Error('Cannot encode unpaired UTF-16 surrogate in TOML string');
    } else {
      out += ch;
    }
  }
  out += '"';
  return out;
}

function getTomlKeyPath(keyNode: TomlAST.TOMLKey): string[] {
  return keyNode.keys.map((seg) => (seg.type === 'TOMLBare' ? seg.name : seg.value));
}

function verifyCodexTomlOutput(tomlText: string, runnerPath: string, contextLabel: string): void {
  let ast: TomlAST.TOMLProgram;
  try {
    ast = tomlParser.parseTOML(tomlText);
  } catch (err) {
    throw new Error(`Invalid TOML produced for ${contextLabel}: ${errorMessage(err)}`);
  }
  const value = tomlParser.getStaticTOMLValue(ast);
  if (!isPlainObject(value)) {
    throw new Error(`Invalid TOML root produced for ${contextLabel}`);
  }
  const mcpServers = value.mcp_servers;
  if (!isPlainObject(mcpServers) || !isPlainObject(mcpServers.broke)) {
    throw new Error(`Missing [mcp_servers.broke] table in ${contextLabel}`);
  }
  const broke = mcpServers.broke;
  const expectedArgs = [runnerPath, 'mcp', '--agent', 'codex'];
  if (
    broke.command !== 'node' ||
    !Array.isArray(broke.args) ||
    broke.args.length !== expectedArgs.length ||
    broke.args.some((arg, idx) => arg !== expectedArgs[idx])
  ) {
    throw new Error(`Unexpected [mcp_servers.broke] command/args after editing ${contextLabel}`);
  }
}

/**
 * Parse a Codex TOML configuration and update/insert only
 * `mcp_servers.broke.command` and `mcp_servers.broke.args` via parser AST
 * source ranges, preserving comments, unrelated settings, extra keys, and line
 * endings outside edited ranges.
 */
export function updateCodexToml(source: string, runnerPath: string): string {
  validateRunnerPath(runnerPath);
  let ast: TomlAST.TOMLProgram;
  try {
    ast = tomlParser.parseTOML(source);
  } catch (err) {
    throw new Error(`Invalid TOML in Codex config: ${errorMessage(err)}`);
  }

  const eol = detectEol(source);
  const desiredCommand = formatTomlBasicString('node');
  const desiredArgs = `[${[runnerPath, 'mcp', '--agent', 'codex'].map(formatTomlBasicString).join(', ')}]`;

  const topLevel = ast.body[0];
  let brokeTable: TomlAST.TOMLTable | undefined;

  for (const stmt of topLevel.body) {
    if (stmt.type === 'TOMLKeyValue') {
      const segs = getTomlKeyPath(stmt.key);
      if (segs[0] === 'mcp_servers') {
        if (segs.length === 1) {
          throw new Error(
            'Cannot unambiguously update Codex TOML: top-level "mcp_servers" is an inline value/table; use a standard [mcp_servers.broke] table',
          );
        }
        if (segs[1] === 'broke') {
          throw new Error(
            'Cannot unambiguously update Codex TOML: "mcp_servers.broke" is defined via top-level dotted/inline keys; use a standard [mcp_servers.broke] table',
          );
        }
      }
      continue;
    }

    if (stmt.type === 'TOMLTable') {
      const segs = getTomlKeyPath(stmt.key);
      if (segs[0] !== 'mcp_servers') continue;

      if (stmt.kind === 'array') {
        if (segs.length === 1 || segs[1] === 'broke') {
          throw new Error(
            'Cannot unambiguously update Codex TOML: array-of-tables [[mcp_servers]] / [[mcp_servers.broke]] is not supported',
          );
        }
        continue;
      }

      if (segs.length === 1) {
        for (const kv of stmt.body) {
          const kvSegs = getTomlKeyPath(kv.key);
          if (kvSegs[0] === 'broke') {
            throw new Error(
              'Cannot unambiguously update Codex TOML: "broke" is defined inline/dotted inside [mcp_servers]; use a standard [mcp_servers.broke] table',
            );
          }
        }
        continue;
      }

      if (segs.length === 2 && segs[1] === 'broke') {
        if (brokeTable) {
          throw new Error('Cannot unambiguously update Codex TOML: duplicate [mcp_servers.broke] tables');
        }
        brokeTable = stmt;
        continue;
      }

      if (segs.length >= 3 && segs[1] === 'broke' && (segs[2] === 'command' || segs[2] === 'args')) {
        throw new Error(
          `Cannot unambiguously update Codex TOML: subtable [mcp_servers.broke.${segs[2]}] conflicts with required field`,
        );
      }
    }
  }

  let updated: string;

  if (brokeTable) {
    let commandKv: TomlAST.TOMLKeyValue | undefined;
    let argsKv: TomlAST.TOMLKeyValue | undefined;

    for (const kv of brokeTable.body) {
      const kvSegs = getTomlKeyPath(kv.key);
      if (kvSegs[0] === 'command') {
        if (kvSegs.length > 1) {
          throw new Error(
            'Cannot unambiguously update Codex TOML: dotted sub-key under mcp_servers.broke.command',
          );
        }
        commandKv = kv;
      } else if (kvSegs[0] === 'args') {
        if (kvSegs.length > 1) {
          throw new Error(
            'Cannot unambiguously update Codex TOML: dotted sub-key under mcp_servers.broke.args',
          );
        }
        argsKv = kv;
      }
    }

    const edits: Array<{ start: number; end: number; text: string }> = [];
    if (commandKv) {
      edits.push({
        start: commandKv.value.range[0],
        end: commandKv.value.range[1],
        text: desiredCommand,
      });
    }
    if (argsKv) {
      edits.push({
        start: argsKv.value.range[0],
        end: argsKv.value.range[1],
        text: desiredArgs,
      });
    }

    const missingLines: string[] = [];
    if (!commandKv) missingLines.push(`command = ${desiredCommand}`);
    if (!argsKv) missingLines.push(`args = ${desiredArgs}`);

    if (missingLines.length > 0) {
      let insertPos = brokeTable.range[1];
      while (insertPos < source.length && source[insertPos] !== '\r' && source[insertPos] !== '\n') {
        insertPos += 1;
      }
      const trailingEol = insertPos === source.length ? eol : '';
      edits.push({
        start: insertPos,
        end: insertPos,
        text: `${eol}${missingLines.join(eol)}${trailingEol}`,
      });
    }

    edits.sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));
    let cursor = 0;
    let buf = '';
    for (const edit of edits) {
      buf += source.slice(cursor, edit.start) + edit.text;
      cursor = edit.end;
    }
    buf += source.slice(cursor);
    updated = buf;
  } else {
    const newTable = [
      '[mcp_servers.broke]',
      `command = ${desiredCommand}`,
      `args = ${desiredArgs}`,
    ].join(eol);

    if (source.length === 0) {
      updated = `${newTable}${eol}`;
    } else if (/(?:\r?\n){2}$/.test(source)) {
      updated = `${source}${newTable}${eol}`;
    } else if (source.endsWith('\n')) {
      updated = `${source}${eol}${newTable}${eol}`;
    } else {
      updated = `${source}${eol}${eol}${newTable}${eol}`;
    }
  }

  verifyCodexTomlOutput(updated, runnerPath, 'Codex TOML update');
  return updated;
}

// ---------------------------------------------------------------------------
// Strict JSON Upserts (MCP configs & Claude Code hooks)
// ---------------------------------------------------------------------------

function mergeJsonFileStrict(
  existingPath: string,
  patcher: (current: Record<string, unknown>) => Record<string, unknown>,
): string {
  const raw = readExistingTextOrNull(existingPath);
  let base: Record<string, unknown> = {};
  let eol: '\r\n' | '\n' = '\n';

  if (raw !== null) {
    eol = detectEol(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid JSON in ${existingPath}: ${errorMessage(err)}`);
    }
    if (!isPlainObject(parsed)) {
      const actualType = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
      throw new Error(`Invalid JSON root in ${existingPath}: expected an object, got ${actualType}`);
    }
    base = parsed;
  }

  const patched = patcher(base);
  const serialized = `${JSON.stringify(patched, null, 2)}\n`;
  return eol === '\r\n' ? serialized.replace(/\n/g, '\r\n') : serialized;
}

function upsertMcpJsonConfig(mcpPath: string, runnerPath: string, agentName: SupportedInstallAgent): string {
  return mergeJsonFileStrict(mcpPath, (cur) => {
    let servers: Record<string, unknown> = {};
    if (cur.mcpServers !== undefined) {
      if (!isPlainObject(cur.mcpServers)) {
        throw new Error(`Invalid "mcpServers" in ${mcpPath}: expected an object`);
      }
      servers = cur.mcpServers;
    }

    let existingBroke: Record<string, unknown> = {};
    if (servers.broke !== undefined) {
      if (!isPlainObject(servers.broke)) {
        throw new Error(`Invalid "mcpServers.broke" in ${mcpPath}: expected an object`);
      }
      existingBroke = servers.broke;
    }

    return {
      ...cur,
      mcpServers: {
        ...servers,
        broke: {
          ...existingBroke,
          command: 'node',
          args: [runnerPath, 'mcp', '--agent', agentName],
        },
      },
    };
  });
}

function isBrokeClaudeHookEntry(entry: Record<string, unknown>, runnerPath: string): boolean {
  const hasRunner = runnerPath.trim().length > 0;
  const normalizedRunnerSlash = hasRunner ? runnerPath.replace(/\\/g, '/') : '';

  if (Array.isArray(entry.args) && entry.args.length > 0) {
    if (
      entry.args.length === 3 &&
      typeof entry.args[0] === 'string' &&
      entry.args[1] === 'hook' &&
      entry.args[2] === 'claude'
    ) {
      const arg0 = entry.args[0];
      if (
        (hasRunner && (arg0 === runnerPath || arg0 === normalizedRunnerSlash)) ||
        /(?:^|[\\/])broke-runner\.cjs$/i.test(arg0)
      ) {
        return true;
      }
    }
    if (
      entry.args.length === 2 &&
      entry.args[0] === 'hook' &&
      entry.args[1] === 'claude' &&
      typeof entry.command === 'string'
    ) {
      if (
        (hasRunner && (entry.command === runnerPath || entry.command === normalizedRunnerSlash)) ||
        /(?:^|[\\/])broke(?:\.cmd|\.exe|\.cjs|-runner\.cjs)?$/i.test(entry.command)
      ) {
        return true;
      }
    }
    return false;
  }

  if (typeof entry.command === 'string') {
    const cmd = entry.command;
    if (!/\bhook\s+claude(?:\s|$)/.test(cmd)) {
      return false;
    }
    if (
      cmd.includes('broke-runner.cjs') ||
      (hasRunner && cmd.includes(runnerPath)) ||
      (normalizedRunnerSlash.length > 0 && cmd.includes(normalizedRunnerSlash)) ||
      /(?:^|[\s"'\\/])broke(?:\.cmd|\.exe|\.cjs)?["']?\s+hook\s+claude(?:\s|$)/i.test(cmd)
    ) {
      return true;
    }
  }

  return false;
}

function upsertClaudeHookEvent(
  rawGroups: unknown,
  desiredMatcher: string,
  runnerPath: string,
  settingsPath: string,
  eventName: string,
): Array<Record<string, unknown>> {
  const desiredHook = {
    type: 'command',
    command: 'node',
    args: [runnerPath, 'hook', 'claude'],
  };

  if (rawGroups === undefined) {
    return [{ matcher: desiredMatcher, hooks: [desiredHook] }];
  }
  if (!Array.isArray(rawGroups)) {
    throw new Error(`Invalid "hooks.${eventName}" in ${settingsPath}: expected an array`);
  }

  const validatedGroups: Array<Record<string, unknown> & { hooks: Array<Record<string, unknown>> }> = [];
  for (const group of rawGroups) {
    if (!isPlainObject(group)) {
      throw new Error(`Invalid matcher group in "hooks.${eventName}" of ${settingsPath}: expected an object`);
    }
    if (!Array.isArray(group.hooks)) {
      throw new Error(`Invalid "hooks" array in "hooks.${eventName}" group of ${settingsPath}: expected an array`);
    }
    for (const h of group.hooks) {
      if (!isPlainObject(h)) {
        throw new Error(`Invalid hook entry in "hooks.${eventName}" of ${settingsPath}: expected an object`);
      }
    }
    validatedGroups.push(group as Record<string, unknown> & { hooks: Array<Record<string, unknown>> });
  }

  let updatedOwnedEntry = false;
  let capturedExtraHookProps: Record<string, unknown> | undefined;
  const nextGroups: Array<Record<string, unknown>> = [];

  for (const group of validatedGroups) {
    const hasBrokeHook = group.hooks.some((h) => isBrokeClaudeHookEntry(h, runnerPath));
    if (!hasBrokeHook) {
      nextGroups.push(group);
      continue;
    }

    const allAreBroke = group.hooks.every((h) => isBrokeClaudeHookEntry(h, runnerPath));
    if (!allAreBroke && group.matcher !== desiredMatcher) {
      const foreignHooks: Array<Record<string, unknown>> = [];
      for (const h of group.hooks) {
        if (!isBrokeClaudeHookEntry(h, runnerPath)) {
          foreignHooks.push(h);
        } else if (!capturedExtraHookProps) {
          const { type: _t, command: _c, args: _a, ...extraHookProps } = h;
          capturedExtraHookProps = extraHookProps;
        }
      }
      if (foreignHooks.length > 0) {
        nextGroups.push({
          ...group,
          hooks: foreignHooks,
        });
      }
      continue;
    }

    const nextHooks: Array<Record<string, unknown>> = [];
    for (const h of group.hooks) {
      if (!isBrokeClaudeHookEntry(h, runnerPath)) {
        nextHooks.push(h);
        continue;
      }
      if (!updatedOwnedEntry) {
        updatedOwnedEntry = true;
        const { type: _t, command: _c, args: _a, ...extraHookProps } = h;
        nextHooks.push({
          ...desiredHook,
          ...capturedExtraHookProps,
          ...extraHookProps,
        });
      }
    }

    if (nextHooks.length > 0) {
      if (allAreBroke) {
        nextGroups.push({
          ...group,
          matcher: desiredMatcher,
          hooks: nextHooks,
        });
      } else {
        nextGroups.push({
          ...group,
          hooks: nextHooks,
        });
      }
    }
  }

  if (!updatedOwnedEntry) {
    nextGroups.push({
      matcher: desiredMatcher,
      hooks: [{ ...desiredHook, ...capturedExtraHookProps }],
    });
  }

  return nextGroups;
}

function upsertClaudeSettingsJson(settingsPath: string, runnerPath: string): string {
  return mergeJsonFileStrict(settingsPath, (cur) => {
    let hooksObj: Record<string, unknown> = {};
    if (cur.hooks !== undefined) {
      if (!isPlainObject(cur.hooks)) {
        throw new Error(`Invalid "hooks" in ${settingsPath}: expected an object`);
      }
      for (const [eventKey, eventVal] of Object.entries(cur.hooks)) {
        if (!Array.isArray(eventVal)) {
          throw new Error(`Invalid "hooks.${eventKey}" in ${settingsPath}: expected an array`);
        }
      }
      hooksObj = cur.hooks;
    }

    return {
      ...cur,
      hooks: {
        ...hooksObj,
        PreToolUse: upsertClaudeHookEvent(
          hooksObj.PreToolUse,
          'Read|Edit|Write|MultiEdit',
          runnerPath,
          settingsPath,
          'PreToolUse',
        ),
        PostToolUse: upsertClaudeHookEvent(
          hooksObj.PostToolUse,
          'Bash',
          runnerPath,
          settingsPath,
          'PostToolUse',
        ),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Skill, Rule & AGENTS.md Builders
// ---------------------------------------------------------------------------

function loadSkillMarkdown(): string {
  const skillFile = join(__dirname, 'docs', 'agents', 'SKILL.md');
  if (existsSync(skillFile)) {
    try {
      return readFileSync(skillFile, 'utf-8');
    } catch {
      // Fallback to generated skill markdown below.
    }
  }
  return [
    '---',
    'name: broke',
    'description: Token-budget context compression, BM25 keyword search (broke_search), interface slicing (broke_slice), budgeted git diffs (broke_diff), and diagnostic error compression (broke_check / broke_compress).',
    '---',
    '',
    buildWorkflowPromptText('lite'),
    '',
  ].join('\n');
}

function buildAgentsMdSection(eol: '\r\n' | '\n' = '\n'): string {
  const workflowBody = buildWorkflowPromptText('lite').replace(/\r?\n/g, eol);
  return [
    BROKE_AGENTS_MD_MARKER_START,
    workflowBody,
    BROKE_AGENTS_MD_MARKER_END,
  ].join(eol);
}

function upsertAgentsMd(existingPath: string): string {
  const current = readExistingTextOrNull(existingPath);
  if (current === null) {
    return `${buildAgentsMdSection('\n')}\n`;
  }

  const eol = detectEol(current);
  const block = buildAgentsMdSection(eol);
  const startIdx = current.indexOf(BROKE_AGENTS_MD_MARKER_START);
  const endIdx = current.indexOf(BROKE_AGENTS_MD_MARKER_END);

  if (startIdx === -1 && endIdx === -1) {
    const trimmed = current.replace(/(?:\r?\n)+$/, '');
    if (trimmed.length === 0) {
      return `${block}${eol}`;
    }
    return `${trimmed}${eol}${eol}${block}${eol}`;
  }

  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `Malformed broke marker block in ${existingPath}: unmatched ${
        startIdx === -1 ? BROKE_AGENTS_MD_MARKER_END : BROKE_AGENTS_MD_MARKER_START
      }`,
    );
  }
  if (endIdx < startIdx) {
    throw new Error(
      `Malformed broke marker block in ${existingPath}: end marker precedes start marker`,
    );
  }
  if (
    current.indexOf(BROKE_AGENTS_MD_MARKER_START, startIdx + BROKE_AGENTS_MD_MARKER_START.length) !== -1 ||
    current.indexOf(BROKE_AGENTS_MD_MARKER_END, endIdx + BROKE_AGENTS_MD_MARKER_END.length) !== -1
  ) {
    throw new Error(`Malformed broke marker block in ${existingPath}: duplicate markers found`);
  }

  return `${current.slice(0, startIdx)}${block}${current.slice(endIdx + BROKE_AGENTS_MD_MARKER_END.length)}`;
}

// ---------------------------------------------------------------------------
// Pre-Write Planned Output Validation
// ---------------------------------------------------------------------------

function validatePlannedOutputs(
  writes: PlannedFileWrite[],
  agent: SupportedInstallAgent,
  runnerPath: string,
): void {
  for (const item of writes) {
    if (item.path.endsWith('.json')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(item.content);
      } catch (err) {
        throw new Error(`Planned JSON output for ${item.path} failed validation: ${errorMessage(err)}`);
      }
      if (!isPlainObject(parsed)) {
        throw new Error(`Planned JSON output for ${item.path} is not a JSON object`);
      }

      if (basename(item.path) === 'settings.json') {
        const hooks = parsed.hooks;
        if (!isPlainObject(hooks) || !Array.isArray(hooks.PreToolUse) || !Array.isArray(hooks.PostToolUse)) {
          throw new Error(`Planned Claude settings output for ${item.path} is missing valid hook arrays`);
        }
        const expectedMatchers: Record<'PreToolUse' | 'PostToolUse', string> = {
          PreToolUse: 'Read|Edit|Write|MultiEdit',
          PostToolUse: 'Bash',
        };
        for (const eventName of ['PreToolUse', 'PostToolUse'] as const) {
          const expectedMatcher = expectedMatchers[eventName];
          const groups = hooks[eventName] as Array<Record<string, unknown>>;
          const found = groups.some(
            (g) =>
              isPlainObject(g) &&
              g.matcher === expectedMatcher &&
              Array.isArray(g.hooks) &&
              g.hooks.some(
                (h) =>
                  isPlainObject(h) &&
                  h.type === 'command' &&
                  h.command === 'node' &&
                  Array.isArray(h.args) &&
                  h.args.length === 3 &&
                  h.args[0] === runnerPath &&
                  h.args[1] === 'hook' &&
                  h.args[2] === 'claude',
              ),
          );
          if (!found) {
            throw new Error(
              `Planned Claude settings output for ${item.path} is missing broke ${eventName} hook with matcher "${expectedMatcher}"`,
            );
          }
        }
      } else {
        const servers = parsed.mcpServers;
        if (!isPlainObject(servers) || !isPlainObject(servers.broke)) {
          throw new Error(`Planned MCP config output for ${item.path} is missing mcpServers.broke`);
        }
        const broke = servers.broke;
        const expectedArgs = [runnerPath, 'mcp', '--agent', agent];
        if (
          broke.command !== 'node' ||
          !Array.isArray(broke.args) ||
          broke.args.length !== expectedArgs.length ||
          broke.args.some((a, i) => a !== expectedArgs[i])
        ) {
          throw new Error(`Planned MCP config output for ${item.path} has unexpected command/args`);
        }
      }
    } else if (item.path.endsWith('.toml')) {
      verifyCodexTomlOutput(item.content, runnerPath, item.path);
    } else if (basename(item.path) === 'AGENTS.md') {
      const s = item.content.indexOf(BROKE_AGENTS_MD_MARKER_START);
      const e = item.content.indexOf(BROKE_AGENTS_MD_MARKER_END);
      if (
        s === -1 ||
        e === -1 ||
        e <= s ||
        item.content.indexOf(BROKE_AGENTS_MD_MARKER_START, s + BROKE_AGENTS_MD_MARKER_START.length) !== -1 ||
        item.content.indexOf(BROKE_AGENTS_MD_MARKER_END, e + BROKE_AGENTS_MD_MARKER_END.length) !== -1
      ) {
        throw new Error(`Planned AGENTS.md output for ${item.path} has invalid marker framing`);
      }
    } else if (basename(item.path) === 'SKILL.md' || item.path.endsWith('.mdc')) {
      if (!item.content.startsWith('---\n') && !item.content.startsWith('---\r\n')) {
        throw new Error(`Planned skill/rule output for ${item.path} is missing frontmatter`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public Installer Entry Points (`planAgentInstall` & `executeAgentInstall`)
// ---------------------------------------------------------------------------

export function planAgentInstall(opts: InstallAgentOptions): PlannedFileWrite[] {
  if (!SUPPORTED_INSTALL_AGENTS.includes(opts.agent)) {
    throw new Error(`Unsupported install agent "${String(opts.agent)}"`);
  }

  const runner = opts.runnerPath ?? join(__dirname, 'scripts', 'broke-runner.cjs');
  validateRunnerPath(runner);
  const target = resolve(opts.targetDir);
  ensureValidTargetDirectory(target);

  const skillText = loadSkillMarkdown();
  const writes: PlannedFileWrite[] = [];

  if (opts.agent === 'claude') {
    const mcpPath = join(target, '.mcp.json');
    const settingsPath = join(target, '.claude', 'settings.json');
    const skillPath = join(target, '.claude', 'skills', 'broke', 'SKILL.md');
    ensureSafeParentDirectories(target, mcpPath);
    ensureSafeParentDirectories(target, settingsPath);
    ensureSafeParentDirectories(target, skillPath);
    ensureRegularOrMissingTarget(skillPath);

    writes.push({
      path: mcpPath,
      description: 'Claude Code MCP server registration (.mcp.json)',
      content: upsertMcpJsonConfig(mcpPath, runner, 'claude'),
    });

    writes.push({
      path: settingsPath,
      description: 'Claude Code PreToolUse/PostToolUse hooks (.claude/settings.json)',
      content: upsertClaudeSettingsJson(settingsPath, runner),
    });

    writes.push({
      path: skillPath,
      description: 'Claude Code broke skill (.claude/skills/broke/SKILL.md)',
      content: skillText,
    });
  } else if (opts.agent === 'antigravity') {
    const mcpPath = join(target, '.agents', 'mcp_config.json');
    const skillPath = join(target, '.agents', 'skills', 'broke', 'SKILL.md');
    const agentsMdPath = join(target, 'AGENTS.md');
    ensureSafeParentDirectories(target, mcpPath);
    ensureSafeParentDirectories(target, skillPath);
    ensureSafeParentDirectories(target, agentsMdPath);
    ensureRegularOrMissingTarget(skillPath);

    writes.push({
      path: mcpPath,
      description: 'Antigravity MCP server config (.agents/mcp_config.json)',
      content: upsertMcpJsonConfig(mcpPath, runner, 'antigravity'),
    });

    writes.push({
      path: skillPath,
      description: 'Antigravity broke skill (.agents/skills/broke/SKILL.md)',
      content: skillText,
    });

    writes.push({
      path: agentsMdPath,
      description: 'Project AGENTS.md broke workflow section',
      content: upsertAgentsMd(agentsMdPath),
    });
  } else if (opts.agent === 'codex') {
    const tomlPath = join(target, '.codex', 'config.toml');
    const agentsMdPath = join(target, 'AGENTS.md');
    ensureSafeParentDirectories(target, tomlPath);
    ensureSafeParentDirectories(target, agentsMdPath);
    const existingToml = readExistingTextOrNull(tomlPath) ?? '';

    writes.push({
      path: tomlPath,
      description: 'Codex CLI MCP config (.codex/config.toml)',
      content: updateCodexToml(existingToml, runner),
    });

    writes.push({
      path: agentsMdPath,
      description: 'Project AGENTS.md broke workflow section',
      content: upsertAgentsMd(agentsMdPath),
    });
  } else if (opts.agent === 'cursor') {
    const mcpPath = join(target, '.cursor', 'mcp.json');
    const rulePath = join(target, '.cursor', 'rules', 'broke.mdc');
    ensureSafeParentDirectories(target, mcpPath);
    ensureSafeParentDirectories(target, rulePath);
    ensureRegularOrMissingTarget(rulePath);

    writes.push({
      path: mcpPath,
      description: 'Cursor MCP server config (.cursor/mcp.json)',
      content: upsertMcpJsonConfig(mcpPath, runner, 'cursor'),
    });

    writes.push({
      path: rulePath,
      description: 'Cursor rule (.cursor/rules/broke.mdc)',
      content: [
        '---',
        'description: broke context-budget workflow (search, slice, diff, diagnostic compression)',
        'alwaysApply: true',
        '---',
        '',
        buildWorkflowPromptText('lite'),
        '',
      ].join('\n'),
    });
  }

  validatePlannedOutputs(writes, opts.agent, runner);
  return writes;
}

interface OriginalFileSnapshot {
  path: string;
  existed: boolean;
  originalBytes: Buffer | null;
}

function captureOriginalSnapshots(planned: PlannedFileWrite[]): OriginalFileSnapshot[] {
  const snapshots: OriginalFileSnapshot[] = [];
  for (const item of planned) {
    try {
      const stat = lstatSync(item.path);
      if (!stat.isFile()) {
        throw new Error(`Expected regular file at ${item.path}`);
      }
      snapshots.push({
        path: item.path,
        existed: true,
        originalBytes: readFileSync(item.path),
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        snapshots.push({
          path: item.path,
          existed: false,
          originalBytes: null,
        });
      } else {
        throw new Error(`Failed to snapshot ${item.path}: ${errorMessage(err)}`);
      }
    }
  }
  return snapshots;
}

export function executeAgentInstall(opts: InstallAgentOptions): { ok: boolean; text: string; files: string[] } {
  let planned: PlannedFileWrite[];
  try {
    planned = planAgentInstall(opts);
  } catch (err) {
    return {
      ok: false,
      files: [],
      text: `broke install-agent ${opts.agent} failed: ${errorMessage(err)}`,
    };
  }

  if (opts.dryRun) {
    return {
      ok: true,
      files: planned.map((p) => p.path),
      text: [
        `broke install-agent ${opts.agent} (dry-run) - ${planned.length} file(s) would be written:`,
        ...planned.map((p) => `  - ${p.path} (${p.description})`),
      ].join('\n'),
    };
  }

  let snapshots: OriginalFileSnapshot[];
  try {
    snapshots = captureOriginalSnapshots(planned);
  } catch (err) {
    return {
      ok: false,
      files: [],
      text: `broke install-agent ${opts.agent} failed: ${errorMessage(err)}`,
    };
  }

  const doMkdir = opts.fsOps?.mkdirSync ?? ((dirPath: string) => mkdirSync(dirPath, { recursive: true }));
  const doWrite = opts.fsOps?.writeFileSync ?? ((filePath: string, data: Buffer) => writeFileSync(filePath, data));
  const doRename = opts.fsOps?.renameSync ?? ((oldPath: string, newPath: string) => renameSync(oldPath, newPath));
  const doRm = opts.fsOps?.rmSync ?? ((filePath: string) => rmSync(filePath, { force: true }));

  const committed: OriginalFileSnapshot[] = [];

  for (let i = 0; i < planned.length; i++) {
    const item = planned[i]!;
    const snap = snapshots[i]!;
    const dir = dirname(item.path);
    const tempPath = join(
      dir,
      `.${basename(item.path)}.broke-tmp-${process.pid}-${randomUUID().slice(0, 8)}`,
    );

    try {
      doMkdir(dir);
      doWrite(tempPath, Buffer.from(item.content, 'utf-8'));
      doRename(tempPath, item.path);
      committed.push(snap);
    } catch (writeErr) {
      try {
        if (existsSync(tempPath)) {
          rmSync(tempPath, { force: true });
        }
      } catch {
        // Best-effort cleanup of uncommitted temporary sibling.
      }

      const rollbackErrors: string[] = [];
      for (let j = committed.length - 1; j >= 0; j--) {
        const prev = committed[j]!;
        if (!prev.existed) {
          try {
            doRm(prev.path);
            if (existsSync(prev.path)) {
              throw new Error('newly created file still exists after removal');
            }
          } catch (rmErr) {
            rollbackErrors.push(
              `failed to remove newly created ${prev.path} (${errorMessage(rmErr)})`,
            );
          }
        } else if (prev.originalBytes !== null) {
          const recoveryPath = join(
            dirname(prev.path),
            `${basename(prev.path)}.broke-recovery-${process.pid}-${randomUUID().slice(0, 8)}`,
          );
          let recoverySaved = false;
          try {
            doWrite(recoveryPath, prev.originalBytes);
            recoverySaved = true;
          } catch {
            try {
              writeFileSync(recoveryPath, prev.originalBytes);
              recoverySaved = true;
            } catch (recErr) {
              rollbackErrors.push(
                `failed to restore ${prev.path} and could not write recovery copy ${recoveryPath} (${errorMessage(recErr)})`,
              );
            }
          }

          if (recoverySaved) {
            try {
              doRename(recoveryPath, prev.path);
            } catch (restoreErr) {
              rollbackErrors.push(
                `failed to restore ${prev.path} (${errorMessage(restoreErr)}); original bytes retained at recovery copy ${recoveryPath}`,
              );
            }
          }
        }
      }

      const reason = errorMessage(writeErr);
      const text =
        rollbackErrors.length > 0
          ? `broke install-agent ${opts.agent} failed while writing ${item.path}: ${reason}; rollback restoration failed: ${rollbackErrors.join('; ')}`
          : `broke install-agent ${opts.agent} failed while writing ${item.path}: ${reason} (restored ${committed.length} previously modified file(s))`;

      return {
        ok: false,
        files: [],
        text,
      };
    }
  }

  return {
    ok: true,
    files: planned.map((p) => p.path),
    text: [
      `broke install-agent ${opts.agent} complete - wrote ${planned.length} file(s):`,
      ...planned.map((p) => `  - ${p.path} (${p.description})`),
    ].join('\n'),
  };
}
