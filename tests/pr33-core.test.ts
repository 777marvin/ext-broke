import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { runAgentDiff, runAgentSlice } from '../agent-core';
import { MAX_DIFF_FILES_READ } from '../diff';
import { isSafeWorkspaceFile, isSafeWorkspaceRelPath } from '../indexer';

interface TempGitWorkspace {
  baseDir: string;
  repoDir: string;
  externalDir: string;
  dataDir: string;
  cleanup: () => void;
}

function makeTempGitWorkspace(): TempGitWorkspace {
  const baseDir = mkdtempSync(join(tmpdir(), 'broke-pr33-core-'));
  const repoDir = join(baseDir, 'repo');
  const externalDir = join(baseDir, 'external');
  const dataDir = join(baseDir, 'broke-data');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(externalDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return {
    baseDir,
    repoDir,
    externalDir,
    dataDir,
    cleanup: () => {
      try {
        rmSync(baseDir, { recursive: true, force: true });
      } catch {
        // Ignore transient Windows file lock during temp cleanup.
      }
    },
  };
}

function writeRepoFile(root: string, relPath: string, content: string | Buffer): string {
  const abs = join(root, ...relPath.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'safe.directory=*', ...args], {
    cwd,
    encoding: 'utf-8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function initGitRepo(repoDir: string): void {
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.email', 'test@broke.local']);
  git(repoDir, ['config', 'user.name', 'Broke Test']);
  git(repoDir, ['config', 'core.autocrlf', 'false']);
}

function tryCreateFileSymlink(target: string, linkPath: string): boolean {
  try {
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(target, linkPath, 'file');
    return true;
  } catch {
    return false;
  }
}

describe('PR #33 Package B: Protected and Complete Git Diffs', () => {
  it('exports reusable syntactic sensitive-path policy isSafeWorkspaceRelPath alongside isSafeWorkspaceFile', () => {
    assert.equal(typeof isSafeWorkspaceRelPath, 'function', 'expected indexer.ts to export isSafeWorkspaceRelPath');

    // Allowed workspace-relative paths
    assert.equal(isSafeWorkspaceRelPath('src/index.ts'), true);
    assert.equal(isSafeWorkspaceRelPath('dir with spaces/file [1] ümlaut-🚀.ts'), true);

    // Disallowed syntactic, dot-segment, skipped, or sensitive paths
    for (const unsafePath of [
      '',
      '.env',
      '.env.local',
      'config/.env.production',
      'certs/server.key',
      'certs/ca.pem',
      'keys/id_rsa',
      'keys/id_ed25519.pub',
      'src/my_secret.ts',
      'db/credentials.json',
      'auth/user_password.txt',
      '.github/workflows/ci.yml',
      '.claude/settings.json',
      'node_modules/pkg/index.js',
      'vendor/lib.py',
      'dist/bundle.js',
      'build/output.js',
      '../outside.ts',
      '/etc/passwd',
      'C:/Windows/win.ini',
      'sub\\backslash.ts',
    ]) {
      assert.equal(isSafeWorkspaceRelPath(unsafePath), false, `expected ${unsafePath} to be rejected by isSafeWorkspaceRelPath`);
    }

    const ws = makeTempGitWorkspace();
    try {
      writeRepoFile(ws.repoDir, 'src/ok.ts', 'export const ok = 1;\n');
      writeRepoFile(ws.repoDir, '.env', 'SYNTH_ENV=1\n');
      assert.equal(isSafeWorkspaceFile(ws.repoDir, 'src/ok.ts'), true);
      assert.equal(isSafeWorkspaceFile(ws.repoDir, '.env'), false);
    } finally {
      ws.cleanup();
    }
  });

  it('protects staged, unstaged, deleted, and untracked sensitive files and masks inline secrets in permitted diffs', () => {
    const ws = makeTempGitWorkspace();
    try {
      initGitRepo(ws.repoDir);

      // Seed tracked sensitive files and a normal source file
      writeRepoFile(ws.repoDir, '.env', 'APP_TOKEN=SYNTH_ENV_OLD_111\n');
      writeRepoFile(ws.repoDir, 'certs/server.key', 'KEY_DATA=SYNTH_KEY_OLD_222\n');
      writeRepoFile(ws.repoDir, 'certs/ca.pem', 'PEM_DATA=SYNTH_PEM_OLD_333\n');
      writeRepoFile(ws.repoDir, 'keys/id_rsa', 'RSA_DATA=SYNTH_RSA_OLD_444\n');
      writeRepoFile(ws.repoDir, 'src/my_secret.ts', 'export const s = "SYNTH_SEC_OLD_555";\n');
      writeRepoFile(ws.repoDir, '.claude/private.json', '{"tok":"SYNTH_DOT_OLD_666"}\n');
      writeRepoFile(ws.repoDir, 'src/normal.ts', 'export const safeValue = 1;\n');
      writeRepoFile(ws.repoDir, '.gitattributes', '*.ts diff=evilconv\n');

      git(ws.repoDir, ['add', '-f', '.']);
      git(ws.repoDir, ['commit', '-m', 'seed sensitive and normal files']);

      // Configure a hostile textconv in .git/config to verify --no-textconv / --no-ext-diff
      git(ws.repoDir, ['config', 'diff.evilconv.textconv', 'echo SYNTH_TEXTCONV_EXECUTED_888']);

      // 1. Unstaged modification to .env
      writeRepoFile(ws.repoDir, '.env', 'APP_TOKEN=SYNTH_ENV_NEW_111\n');
      // 2. Staged modification to certs/server.key
      writeRepoFile(ws.repoDir, 'certs/server.key', 'KEY_DATA=SYNTH_KEY_NEW_222\n');
      git(ws.repoDir, ['add', '-f', 'certs/server.key']);
      // 3. Unstaged deletion of certs/ca.pem
      unlinkSync(join(ws.repoDir, 'certs', 'ca.pem'));
      // 4. Staged deletion of keys/id_rsa
      git(ws.repoDir, ['rm', '-f', 'keys/id_rsa']);
      // 5. Mixed staged + unstaged edits on *secret* file
      writeRepoFile(ws.repoDir, 'src/my_secret.ts', 'export const s = "SYNTH_SEC_STAGED_555";\n');
      git(ws.repoDir, ['add', '-f', 'src/my_secret.ts']);
      writeRepoFile(ws.repoDir, 'src/my_secret.ts', 'export const s = "SYNTH_SEC_UNSTAGED_555";\n');
      // 6. Tracked dot-directory edit
      writeRepoFile(ws.repoDir, '.claude/private.json', '{"tok":"SYNTH_DOT_NEW_666"}\n');
      // 7. Untracked .env.local
      writeRepoFile(ws.repoDir, '.env.local', 'LOCAL_KEY=SYNTH_UNTRACKED_ENV_777\n');

      // 8. Permitted tracked + untracked files carrying inline secret patterns that maskSecrets must redact
      const inlineOpenAiLike = `sk-${'A1b2C3d4E5f6G7h8I9j0K1l2'}`;
      writeRepoFile(
        ws.repoDir,
        'src/normal.ts',
        `export const safeValue = 2;\nexport const vendorTok = "${inlineOpenAiLike}";\n`,
      );
      writeRepoFile(
        ws.repoDir,
        'src/untracked.ts',
        'export const visibleFlag = true;\nconst api_key = "SYNTH_INLINE_ASSIGN_999";\n',
      );

      const res = runAgentDiff(ws.repoDir, { budgetChars: 25_000 });
      assert.equal(res.ok, true, res.text);

      for (const forbidden of [
        'SYNTH_ENV_OLD_111',
        'SYNTH_ENV_NEW_111',
        'SYNTH_KEY_OLD_222',
        'SYNTH_KEY_NEW_222',
        'SYNTH_PEM_OLD_333',
        'SYNTH_RSA_OLD_444',
        'SYNTH_SEC_OLD_555',
        'SYNTH_SEC_STAGED_555',
        'SYNTH_SEC_UNSTAGED_555',
        'SYNTH_DOT_OLD_666',
        'SYNTH_DOT_NEW_666',
        'SYNTH_UNTRACKED_ENV_777',
        'SYNTH_TEXTCONV_EXECUTED_888',
        inlineOpenAiLike,
        'SYNTH_INLINE_ASSIGN_999',
      ]) {
        assert.equal(
          res.text.includes(forbidden),
          false,
          `expected diff output NOT to leak ${forbidden}\nActual output:\n${res.text}`,
        );
      }

      assert.match(res.text, /src\/normal\.ts/);
      assert.match(res.text, /src\/untracked\.ts/);
      assert.match(res.text, /\[REDACTED\]/, 'expected inline secret tokens in permitted diffs to be masked');
      assert.match(res.text, /omitted/i, 'expected protected files to be explicitly reported as omitted');
    } finally {
      ws.cleanup();
    }
  });

  it('blocks rename bypasses in both directions (.env <-> innocent.txt) and escaping/sensitive symlinks', () => {
    const ws = makeTempGitWorkspace();
    try {
      initGitRepo(ws.repoDir);

      writeRepoFile(ws.repoDir, '.env', 'TOKEN=SYNTH_RENAME_FROM_ENV_OLD\nKEEP=1\n');
      writeRepoFile(ws.repoDir, 'harmless.txt', 'PLAIN=SYNTH_RENAME_TO_ENV_OLD\nKEEP=2\n');
      writeRepoFile(ws.repoDir, 'tracked-regular.ts', 'export const regular = 1;\n');
      writeRepoFile(ws.externalDir, 'outside-secret.ts', 'export const leak = "SYNTH_OUTSIDE_TARGET_SECRET";\n');

      git(ws.repoDir, ['add', '-f', '.']);
      git(ws.repoDir, ['commit', '-m', 'seed rename and symlink targets']);

      // 1. Rename sensitive -> innocuous + unstaged edit on innocuous destination
      git(ws.repoDir, ['mv', '.env', 'innocent.txt']);
      writeRepoFile(ws.repoDir, 'innocent.txt', 'TOKEN=SYNTH_RENAME_FROM_ENV_NEW\nKEEP=1\n');

      // 2. Rename innocuous -> sensitive (.env.staging) + unstaged edit
      git(ws.repoDir, ['mv', 'harmless.txt', '.env.staging']);
      writeRepoFile(ws.repoDir, '.env.staging', 'PLAIN=SYNTH_RENAME_TO_ENV_NEW\nKEEP=2\n');

      // 3. Directory junction escaping outside workspace (works on Windows without elevation)
      const junctionPath = join(ws.repoDir, 'escaped-dir');
      symlinkSync(ws.externalDir, junctionPath, process.platform === 'win32' ? 'junction' : 'dir');

      // 4. File symlinks (when permitted by OS) to external file and internal sensitive file
      writeRepoFile(ws.repoDir, 'server.key', 'SYNTH_INTERNAL_KEY_TARGET\n');
      const createdExternalFileLink = tryCreateFileSymlink(
        join(ws.externalDir, 'outside-secret.ts'),
        join(ws.repoDir, 'link-outside.ts'),
      );
      const createdInternalKeyLink = tryCreateFileSymlink(
        join(ws.repoDir, 'server.key'),
        join(ws.repoDir, 'link-to-key.ts'),
      );
      if (createdExternalFileLink) {
        unlinkSync(join(ws.repoDir, 'tracked-regular.ts'));
        tryCreateFileSymlink(
          join(ws.externalDir, 'outside-secret.ts'),
          join(ws.repoDir, 'tracked-regular.ts'),
        );
      }

      const res = runAgentDiff(ws.repoDir, { budgetChars: 20_000 });
      assert.equal(res.ok, true, res.text);

      for (const forbidden of [
        'SYNTH_RENAME_FROM_ENV_OLD',
        'SYNTH_RENAME_FROM_ENV_NEW',
        'SYNTH_RENAME_TO_ENV_OLD',
        'SYNTH_RENAME_TO_ENV_NEW',
        'SYNTH_OUTSIDE_TARGET_SECRET',
        'SYNTH_INTERNAL_KEY_TARGET',
      ]) {
        assert.equal(
          res.text.includes(forbidden),
          false,
          `expected rename/symlink bypass not to leak ${forbidden}\nActual output:\n${res.text}`,
        );
      }

      assert.match(res.text, /innocent\.txt[\s\S]*\(omitted - /);
      assert.match(res.text, /\.env\.staging[\s\S]*\(omitted - /);
      assert.match(res.text, /escaped-dir[\s\S]*\(omitted - /);
      if (createdInternalKeyLink) {
        assert.match(res.text, /link-to-key\.ts[\s\S]*\(omitted - /);
      }
    } finally {
      ws.cleanup();
    }
  });

  it('preserves both [staged] and [unstaged] layers with exact hunk counts, including canceling layers', () => {
    // Subcase A: Staged edit to `one` (1 -> 100) + unstaged edit to `two` (2 -> 200) + ++/-- prefix edge lines
    const ws = makeTempGitWorkspace();
    try {
      initGitRepo(ws.repoDir);
      writeRepoFile(
        ws.repoDir,
        'calc.ts',
        [
          'export let one = 1;',
          'const ctxA = "a";',
          'const ctxB = "b";',
          'const ctxC = "c";',
          'const ctxD = "d";',
          'export let two = 2;',
          '',
        ].join('\n'),
      );
      git(ws.repoDir, ['add', 'calc.ts']);
      git(ws.repoDir, ['commit', '-m', 'init calc']);

      // Stage edit: one = 1 -> 100
      writeRepoFile(
        ws.repoDir,
        'calc.ts',
        [
          'export let one = 100;',
          'const ctxA = "a";',
          'const ctxB = "b";',
          'const ctxC = "c";',
          'const ctxD = "d";',
          'export let two = 2;',
          '',
        ].join('\n'),
      );
      git(ws.repoDir, ['add', 'calc.ts']);

      // Unstaged edit: two = 2 -> 200 and add `++one;` (which produces `+++one;` inside unified diff hunk)
      writeRepoFile(
        ws.repoDir,
        'calc.ts',
        [
          'export let one = 100;',
          'const ctxA = "a";',
          'const ctxB = "b";',
          'const ctxC = "c";',
          'const ctxD = "d";',
          'export let two = 200;',
          '++one;',
          '',
        ].join('\n'),
      );

      const mixed = runAgentDiff(ws.repoDir, { budgetChars: 10_000 });
      assert.equal(mixed.ok, true, mixed.text);
      assert.equal(mixed.files, 1);
      assert.match(mixed.text, /\[staged\]/, 'expected explicit [staged] section label');
      assert.match(mixed.text, /\[unstaged\]/, 'expected explicit [unstaged] section label');
      assert.match(mixed.text, /-export let one = 1;\n\+export let one = 100;/, 'expected staged hunk in output');
      assert.match(mixed.text, /-export let two = 2;\n\+export let two = 200;\n\+\+\+one;/, 'expected unstaged hunk in output');
      // Staged: +1/-1; Unstaged: +2/-1 => Total: +3/-2
      assert.match(mixed.text, /calc\.ts \(\+3\/-2\)/, `expected exact +3/-2 counts:\n${mixed.text}`);
    } finally {
      ws.cleanup();
    }

    // Subcase B: Canceling layers (staged 1 -> 100, unstaged revert 100 -> 1 => net HEAD == worktree)
    const wsCancel = makeTempGitWorkspace();
    try {
      initGitRepo(wsCancel.repoDir);
      writeRepoFile(wsCancel.repoDir, 'cancel.ts', 'export const one = 1;\n');
      git(wsCancel.repoDir, ['add', 'cancel.ts']);
      git(wsCancel.repoDir, ['commit', '-m', 'init cancel']);

      // Stage 1 -> 100
      writeRepoFile(wsCancel.repoDir, 'cancel.ts', 'export const one = 100;\n');
      git(wsCancel.repoDir, ['add', 'cancel.ts']);
      // Revert worktree back to 1 without staging
      writeRepoFile(wsCancel.repoDir, 'cancel.ts', 'export const one = 1;\n');

      const cancelRes = runAgentDiff(wsCancel.repoDir, { budgetChars: 10_000 });
      assert.equal(cancelRes.ok, true, cancelRes.text);
      assert.equal(cancelRes.files, 1);
      assert.match(cancelRes.text, /\[staged\]/);
      assert.match(cancelRes.text, /\[unstaged\]/);
      assert.match(cancelRes.text, /-export const one = 1;\n\+export const one = 100;/);
      assert.match(cancelRes.text, /-export const one = 100;\n\+export const one = 1;/);
      assert.match(cancelRes.text, /cancel\.ts \(\+2\/-2\)/);
    } finally {
      wsCancel.cleanup();
    }
  });

  it('confines nested monorepo workspace repo/sub to workspace-relative changes and blocks cross-boundary leaks', () => {
    const ws = makeTempGitWorkspace();
    try {
      initGitRepo(ws.repoDir);
      const subDir = join(ws.repoDir, 'sub');
      mkdirSync(subDir, { recursive: true });

      // Seed files inside repo/sub and outside repo/sub
      writeRepoFile(ws.repoDir, 'sub/inside.ts', 'export const inside = 1;\nexport const next = 2;\n');
      writeRepoFile(ws.repoDir, 'sub/to-delete.ts', 'export const obsolete = "remove-me";\n');
      writeRepoFile(ws.repoDir, 'sub/old-name.ts', 'export const renamed = "keep-inside";\n');
      writeRepoFile(ws.repoDir, 'sub/.env', 'SUB_SECRET=SYNTH_SUB_ENV_SECRET\n');

      writeRepoFile(ws.repoDir, 'root-outside.ts', 'export const rootLeak = "SYNTH_ROOT_OUTSIDE_1";\n');
      writeRepoFile(ws.repoDir, 'other/sibling.ts', 'export const siblingLeak = "SYNTH_SIBLING_OUTSIDE_2";\n');
      writeRepoFile(ws.repoDir, 'sub-other/cousin.ts', 'export const cousinLeak = "SYNTH_COUSIN_PREFIX_3";\n');
      writeRepoFile(ws.repoDir, 'from-outside.ts', 'export const crossIn = "SYNTH_CROSS_BOUNDARY_IN_4";\n');
      writeRepoFile(ws.repoDir, 'sub/from-inside.ts', 'export const crossOut = "SYNTH_CROSS_BOUNDARY_OUT_5";\n');

      git(ws.repoDir, ['add', '-f', '.']);
      git(ws.repoDir, ['commit', '-m', 'seed monorepo']);

      // Internal changes inside repo/sub: staged + unstaged edit, deletion, internal rename, untracked, and .env edit
      writeRepoFile(ws.repoDir, 'sub/inside.ts', 'export const inside = 10;\nexport const next = 2;\n');
      git(ws.repoDir, ['add', 'sub/inside.ts']);
      writeRepoFile(ws.repoDir, 'sub/inside.ts', 'export const inside = 10;\nexport const next = 20;\n');
      unlinkSync(join(ws.repoDir, 'sub', 'to-delete.ts'));
      git(ws.repoDir, ['mv', 'sub/old-name.ts', 'sub/new-name.ts']);
      writeRepoFile(ws.repoDir, 'sub/untracked-in-sub.ts', 'export const freshSub = 42;\n');
      writeRepoFile(ws.repoDir, 'sub/.env', 'SUB_SECRET=SYNTH_SUB_ENV_NEW_SECRET\n');

      // Outside changes (must be completely invisible to workspace repo/sub)
      writeRepoFile(ws.repoDir, 'root-outside.ts', 'export const rootLeak = "SYNTH_ROOT_OUTSIDE_MOD";\n');
      writeRepoFile(ws.repoDir, 'other/sibling.ts', 'export const siblingLeak = "SYNTH_SIBLING_OUTSIDE_MOD";\n');
      writeRepoFile(ws.repoDir, 'sub-other/cousin.ts', 'export const cousinLeak = "SYNTH_COUSIN_PREFIX_MOD";\n');
      writeRepoFile(ws.repoDir, 'other/untracked-outside.ts', 'export const outUntracked = "SYNTH_UNTRACKED_OUT";\n');

      // Cross-boundary renames (one side outside repo/sub, one side inside repo/sub -> omit without diffing!)
      git(ws.repoDir, ['mv', 'from-outside.ts', 'sub/moved-into-sub.ts']);
      git(ws.repoDir, ['mv', 'sub/from-inside.ts', 'moved-out-of-sub.ts']);

      const res = runAgentDiff(subDir, { budgetChars: 25_000 });
      assert.equal(res.ok, true, res.text);

      // Internal workspace files must be shown with workspace-relative paths (not `sub/...`, not `binary or unreadable`)
      assert.doesNotMatch(res.text, /binary or unreadable/i, `internal files must be readable:\n${res.text}`);
      assert.match(res.text, /(?:^|\n)inside\.ts \(\+2\/-2\)/);
      assert.match(res.text, /\+export const inside = 10;/);
      assert.match(res.text, /\+export const next = 20;/);
      assert.match(res.text, /(?:^|\n)to-delete\.ts \(\+0\/-1\)/);
      assert.match(res.text, /(?:^|\n)new-name\.ts /);
      assert.match(res.text, /(?:^|\n)untracked-in-sub\.ts \(\+1\/-0\)/);
      assert.match(res.text, /\+\+\+ b\/untracked-in-sub\.ts/);

      // Cross-boundary renames must be reported as omitted and never leak content
      assert.match(res.text, /moved-into-sub\.ts[\s\S]*\(omitted - .*workspace boundary/i);
      assert.match(res.text, /from-inside\.ts[\s\S]*\(omitted - .*workspace boundary/i);

      // Zero leaks from outside files, sibling `sub-other/`, internal `.env`, or cross-boundary renames
      for (const forbidden of [
        'root-outside.ts',
        'sibling.ts',
        'cousin.ts',
        'untracked-outside.ts',
        'SYNTH_ROOT_OUTSIDE',
        'SYNTH_SIBLING_OUTSIDE',
        'SYNTH_COUSIN_PREFIX',
        'SYNTH_UNTRACKED_OUT',
        'SYNTH_SUB_ENV_SECRET',
        'SYNTH_SUB_ENV_NEW_SECRET',
        'SYNTH_CROSS_BOUNDARY_IN_4',
        'SYNTH_CROSS_BOUNDARY_OUT_5',
      ]) {
        assert.equal(
          res.text.includes(forbidden),
          false,
          `expected nested workspace diff not to leak ${forbidden}\nActual output:\n${res.text}`,
        );
      }

      // Also works identically when the workspace root itself is accessed via a symlink/junction
      const wsAlias = join(ws.baseDir, 'sub-link');
      symlinkSync(subDir, wsAlias, process.platform === 'win32' ? 'junction' : 'dir');
      const aliasRes = runAgentDiff(wsAlias, { budgetChars: 25_000 });
      assert.equal(aliasRes.ok, true, aliasRes.text);
      assert.equal(aliasRes.text, res.text);
    } finally {
      ws.cleanup();
    }
  });

  it('supports unborn repositories (no HEAD) and special filenames with spaces, globs [1], and Unicode', () => {
    // Subcase A: Unborn repository with staged-only, staged + unstaged, untracked, and protected .env
    const unbornWs = makeTempGitWorkspace();
    try {
      initGitRepo(unbornWs.repoDir);

      writeRepoFile(unbornWs.repoDir, 'staged-only.ts', 'export const first = 1;\n');
      git(unbornWs.repoDir, ['add', 'staged-only.ts']);

      writeRepoFile(unbornWs.repoDir, 'both-layers.ts', 'export const a = 1;\nexport const b = 2;\n');
      git(unbornWs.repoDir, ['add', 'both-layers.ts']);
      writeRepoFile(unbornWs.repoDir, 'both-layers.ts', 'export const a = 1;\nexport const b = 200;\n');

      writeRepoFile(unbornWs.repoDir, 'untracked.ts', 'export const fresh = "unborn";\n');
      writeRepoFile(unbornWs.repoDir, '.env', 'UNBORN_SECRET=SYNTH_UNBORN_SECRET_999\n');
      git(unbornWs.repoDir, ['add', '-f', '.env']);

      const unbornRes = runAgentDiff(unbornWs.repoDir, { budgetChars: 15_000 });
      assert.equal(unbornRes.ok, true, unbornRes.text);
      assert.doesNotMatch(unbornRes.text, /binary or unreadable/i);
      assert.match(unbornRes.text, /staged-only\.ts \(\+1\/-0\)[\s\S]*\[staged\][\s\S]*\+export const first = 1;/);
      assert.match(unbornRes.text, /both-layers\.ts \(\+3\/-1\)/);
      assert.match(unbornRes.text, /\+export const b = 200;/);
      assert.match(unbornRes.text, /untracked\.ts \(\+1\/-0\)[\s\S]*\[untracked\]/);
      assert.equal(unbornRes.text.includes('SYNTH_UNBORN_SECRET_999'), false);
    } finally {
      unbornWs.cleanup();
    }

    // Subcase B: Filenames with spaces, glob characters [1], and Unicode (ümlaut-🚀.ts) without octal quoting
    const specialWs = makeTempGitWorkspace();
    try {
      initGitRepo(specialWs.repoDir);
      const trackedSpecial = 'dir with spaces/item [1] ümlaut-🚀.ts';
      const untrackedSpecial = 'dir with spaces/new [2] café-✨.ts';

      writeRepoFile(specialWs.repoDir, trackedSpecial, 'export const v = 1;\n');
      git(specialWs.repoDir, ['add', '--', trackedSpecial]);
      git(specialWs.repoDir, ['commit', '-m', 'add special path']);

      writeRepoFile(specialWs.repoDir, trackedSpecial, 'export const v = 2;\n');
      writeRepoFile(specialWs.repoDir, untrackedSpecial, 'export const u = "ok";\n');

      const specialRes = runAgentDiff(specialWs.repoDir, { budgetChars: 15_000 });
      assert.equal(specialRes.ok, true, specialRes.text);
      assert.doesNotMatch(specialRes.text, /binary or unreadable/i);
      assert.doesNotMatch(specialRes.text, /\\303|\\360/, 'expected raw UTF-8 paths without octal quoting');
      assert.ok(specialRes.text.includes(trackedSpecial), `expected ${trackedSpecial} in output:\n${specialRes.text}`);
      assert.ok(specialRes.text.includes(untrackedSpecial), `expected ${untrackedSpecial} in output:\n${specialRes.text}`);
      assert.match(specialRes.text, /\+export const v = 2;/);
    } finally {
      specialWs.cleanup();
    }
  });

  it('reports filtering, oversized-untracked (checked before readFileSync), budget, and read-cap omissions honestly', () => {
    // Subcase A: Only omitted files (.env + >256KB untracked file checked BEFORE reading)
    const ws = makeTempGitWorkspace();
    try {
      initGitRepo(ws.repoDir);
      writeRepoFile(ws.repoDir, 'seed.ts', 'export const seed = 1;\n');
      git(ws.repoDir, ['add', 'seed.ts']);
      git(ws.repoDir, ['commit', '-m', 'init']);

      const envAbs = writeRepoFile(ws.repoDir, '.env', 'SECRET=SYNTH_ONLY_OMITTED_ENV\n');
      const hugeAbs = writeRepoFile(ws.repoDir, 'oversized.log', Buffer.alloc(300 * 1024, 0x61));

      const readPaths: string[] = [];
      const origReadFileSync = fs.readFileSync;
      const readSpy = mock.method(fs, 'readFileSync', ((...args: Parameters<typeof fs.readFileSync>) => {
        readPaths.push(String(args[0]));
        return Reflect.apply(origReadFileSync, fs, args);
      }) as typeof fs.readFileSync);

      let res: ReturnType<typeof runAgentDiff>;
      try {
        res = runAgentDiff(ws.repoDir, { budgetChars: 10_000 });
      } finally {
        readSpy.mock.restore();
      }

      assert.equal(
        readPaths.some((p) => p.endsWith('oversized.log') || p === hugeAbs),
        false,
        `oversized untracked file (>256 KB) must be rejected via stat.size BEFORE readFileSync; readPaths=${JSON.stringify(readPaths)}`,
      );
      assert.equal(
        readPaths.some((p) => p.endsWith('.env') || p === envAbs),
        false,
        'protected .env must never be read via readFileSync',
      );

      assert.equal(res.ok, true, res.text);
      assert.equal(res.files, 2);
      assert.equal(res.diffChars, 0, 'omitted files must not contribute to measured diffChars');
      assert.doesNotMatch(res.text, /no updated files/i);
      assert.doesNotMatch(res.text, /0 chars/i);
      assert.doesNotMatch(res.text, /binary or unreadable/i, `omitted files must not be mislabeled binary/unreadable:\n${res.text}`);
      assert.match(res.text, /2 omitted/i);
      assert.match(res.text, /\.env \(\+0\/-0\)\n  \(omitted - /);
      assert.match(res.text, /oversized\.log \(\+0\/-0\)\n  \(omitted - .*256 KB/i);
    } finally {
      ws.cleanup();
    }

    // Subcase B: Tracked + untracked binary files remain distinct from omitted, budget elision, and MAX_DIFF_FILES_READ cap
    const capWs = makeTempGitWorkspace();
    try {
      initGitRepo(capWs.repoDir);
      writeRepoFile(capWs.repoDir, 'tracked-logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
      git(capWs.repoDir, ['add', 'tracked-logo.png']);
      git(capWs.repoDir, ['commit', '-m', 'seed binary']);

      writeRepoFile(capWs.repoDir, 'tracked-logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x09, 0x0a]));
      writeRepoFile(capWs.repoDir, 'binary.bin', Buffer.from([0x00, 0x01, 0x02, 0x03]));
      for (let i = 0; i < MAX_DIFF_FILES_READ + 3; i++) {
        const padded = String(i).padStart(3, '0');
        writeRepoFile(capWs.repoDir, `src/f${padded}.ts`, `export const v${padded} = "${'x'.repeat(80)}";\n`);
      }

      const tightBudgetRes = runAgentDiff(capWs.repoDir, { budgetChars: 600 });
      assert.equal(tightBudgetRes.ok, true, tightBudgetRes.text);
      assert.equal(tightBudgetRes.files, MAX_DIFF_FILES_READ + 5);
      assert.ok(tightBudgetRes.elided > 0, 'budget must elide excess file blocks');
      assert.match(tightBudgetRes.text, /2 binary or unreadable/i);
      assert.match(tightBudgetRes.text, /5 not read \(per-run read cap\)/i);
      assert.match(tightBudgetRes.text, /not shown - raise the budget/i);
    } finally {
      capWs.cleanup();
    }
  });
});
describe('PR #33 Package D: Consistent Slice Budgets (Finding 10)', () => {
  function makeSliceWorkspace(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'broke-pr33-slice-'));
    return {
      dir,
      cleanup: () => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      },
    };
  }

  it('enforces maxChars on 8,000-exported-constant unchanged view (Finding 10)', () => {
    const ws = makeSliceWorkspace();
    try {
      const lines = Array.from({ length: 8000 }, (_, i) => `export const c${i} = ${i};`);
      const fullSource = lines.join('\n');
      writeFileSync(join(ws.dir, 'constants.ts'), fullSource, 'utf-8');

      const result = runAgentSlice(ws.dir, { path: 'constants.ts', maxChars: 500 });
      assert.equal(result.ok, true);
      assert.ok(result.text.length <= 500, `text.length (${result.text.length}) must be <= 500`);
      assert.equal(result.keptChars, result.text.length, 'keptChars must match final text length');
      assert.equal(result.sliced, true, 'truncated unchanged view must be marked sliced');
      assert.match(result.text, /broke: truncated/);
    } finally {
      ws.cleanup();
    }
  });

  it('enforces maxChars on small files below minChars and keeps fitting files complete', () => {
    const ws = makeSliceWorkspace();
    try {
      const smallSource = 'export function hello(): string {\n  return "world";\n}\n';
      writeFileSync(join(ws.dir, 'small.ts'), smallSource, 'utf-8');

      // Fits within default budget: remains complete and unmodified
      const fitResult = runAgentSlice(ws.dir, { path: 'small.ts' });
      assert.equal(fitResult.ok, true);
      assert.equal(fitResult.sliced, false);
      assert.equal(fitResult.keptChars, fitResult.text.length);
      assert.ok(fitResult.text.includes(smallSource));

      // Tight budget: must be capped and truncated with accurate keptChars
      const cappedResult = runAgentSlice(ws.dir, { path: 'small.ts', maxChars: 60 });
      assert.equal(cappedResult.ok, true);
      assert.ok(cappedResult.text.length <= 60, `text.length (${cappedResult.text.length}) must be <= 60`);
      assert.equal(cappedResult.keptChars, cappedResult.text.length);
      assert.equal(cappedResult.sliced, true);
    } finally {
      ws.cleanup();
    }
  });

  it('enforces maxChars on symbol focus with large body', () => {
    const ws = makeSliceWorkspace();
    try {
      const lines: string[] = [
        'export interface ComputeOptions { iterations: number; }',
        'export function irrelevant(opts: ComputeOptions): number { return 1; }',
        'export function targetFunc(opts: ComputeOptions): number {',
      ];
      for (let i = 0; i < 30; i++) {
        lines.push(`  const x${i} = opts.iterations + ${i} + "${'a'.repeat(25)}";`);
      }
      lines.push('  return opts.iterations;', '}', '');
      writeFileSync(join(ws.dir, 'funcs.ts'), lines.join('\n'), 'utf-8');

      const result = runAgentSlice(ws.dir, { path: 'funcs.ts', symbol: 'targetFunc', maxChars: 300 });
      assert.equal(result.ok, true);
      assert.ok(result.text.length <= 300, `text.length (${result.text.length}) must be <= 300`);
      assert.equal(result.keptChars, result.text.length);
      assert.equal(result.sliced, true);
      assert.match(result.text, /broke: truncated/);
    } finally {
      ws.cleanup();
    }
  });

  it('does not split UTF-16 surrogate pairs during truncation', () => {
    const ws = makeSliceWorkspace();
    try {
      // Emojis that require UTF-16 surrogate pairs
      const emojiSource = Array.from({ length: 50 }, (_, i) => `// comment ${i} 🚀🌟🎉✨🔥💡\nexport const e${i} = "🚀🌟🎉✨🔥💡";`).join('\n');
      writeFileSync(join(ws.dir, 'unicode.ts'), emojiSource, 'utf-8');

      for (const cap of [40, 55, 73, 90, 111, 150, 250, 400]) {
        const result = runAgentSlice(ws.dir, { path: 'unicode.ts', maxChars: cap });
        assert.equal(result.ok, true);
        assert.ok(result.text.length <= cap, `text.length (${result.text.length}) must be <= ${cap}`);
        assert.equal(result.keptChars, result.text.length);

        // encodeURIComponent throws URIError if string has lone/orphaned surrogate pairs!
        assert.doesNotThrow(() => {
          encodeURIComponent(result.text);
        }, `URIError thrown at cap ${cap}: surrogate pair was split!`);
      }
    } finally {
      ws.cleanup();
    }
  });
});
