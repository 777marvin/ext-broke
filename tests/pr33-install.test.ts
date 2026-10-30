import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import * as tomlParserNs from 'toml-eslint-parser';
import * as agentInstallMod from '../agent-install';
import * as cliMod from '../cli';
import {
  executeAgentInstall,
  planAgentInstall,
  SUPPORTED_INSTALL_AGENTS,
  updateCodexToml as cliUpdateCodexToml,
  type InstallAgentOptions,
} from '../cli';

const tomlParser = (
  (tomlParserNs as unknown as { default?: typeof tomlParserNs }).default ?? tomlParserNs
) as typeof tomlParserNs;

interface TempWorkspace {
  baseDir: string;
  projectDir: string;
  dataDir: string;
  cleanup: () => void;
}

function makeTempWorkspace(): TempWorkspace {
  const baseDir = mkdtempSync(join(tmpdir(), 'broke-pr33-install-'));
  const projectDir = join(baseDir, 'project');
  const dataDir = join(baseDir, 'broke-data');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return {
    baseDir,
    projectDir,
    dataDir,
    cleanup: () => {
      try {
        rmSync(baseDir, { recursive: true, force: true });
      } catch {
        // Ignore Windows transient cleanup locks.
      }
    },
  };
}

function writeSeed(filePath: string, content: string | Buffer): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

describe('PR #33 Package A: Preserve Existing Agent Configuration', () => {
  it('preserves-existing-codex-settings', () => {
    const ws = makeTempWorkspace();
    try {
      const runnerPath = 'C:\\Tools\\broke\\scripts\\broke-runner.cjs';
      const tomlPath = join(ws.projectDir, '.codex', 'config.toml');
      const seededToml = [
        '# User Codex profile — must survive untouched',
        'model = "o3"',
        'approval_policy = "on-request"',
        '',
        '[mcp_servers.github]',
        'command = "npx"',
        'args = ["-y", "@modelcontextprotocol/server-github"]',
        '',
        '["mcp_servers"."postgres"]',
        '"command" = "pg-mcp"',
        '"url" = "postgresql://localhost:5432/dev"',
        '',
        '[mcp_servers.broke] # custom broke table header comment',
        'startup_timeout_sec = 45 # keep custom timeout',
        'command = "legacy-node" # inline command comment',
        '',
      ].join('\r\n');
      writeSeed(tomlPath, Buffer.from(seededToml, 'utf-8'));

      const res = executeAgentInstall({
        agent: 'codex',
        targetDir: ws.projectDir,
        runnerPath,
      });
      assert.equal(res.ok, true, res.text);

      const updatedRaw = readFileSync(tomlPath, 'utf-8');
      // Comments must survive
      assert.match(updatedRaw, /# User Codex profile — must survive untouched/);
      assert.match(updatedRaw, /# custom broke table header comment/);
      assert.match(updatedRaw, /# keep custom timeout/);
      assert.match(updatedRaw, /# inline command comment/);

      // CRLF line endings must survive throughout .codex/config.toml (no bare LF)
      const strippedCrlf = updatedRaw.replace(/\r\n/g, '');
      assert.equal(strippedCrlf.includes('\n'), false, 'expected CRLF line endings to be preserved without bare LF');

      // Parsed TOML structure must keep unrelated settings, other MCP servers, quoted keys, and extra broke keys
      const parsed = tomlParser.getStaticTOMLValue(tomlParser.parseTOML(updatedRaw)) as Record<string, unknown>;
      assert.equal(parsed.model, 'o3');
      assert.equal(parsed.approval_policy, 'on-request');

      const mcpServers = parsed.mcp_servers as Record<string, Record<string, unknown>>;
      assert.ok(mcpServers);
      assert.deepEqual(mcpServers.github, {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
      });
      assert.deepEqual(mcpServers.postgres, {
        command: 'pg-mcp',
        url: 'postgresql://localhost:5432/dev',
      });
      assert.deepEqual(mcpServers.broke, {
        startup_timeout_sec: 45,
        command: 'node',
        args: [runnerPath, 'mcp', '--agent', 'codex'],
      });

      // Direct updateCodexToml export check + quoted [mcp_servers."broke"] support
      const updateCodexToml = (cliMod as Record<string, unknown>).updateCodexToml as
        | ((source: string, rp: string) => string)
        | undefined;
      assert.equal(typeof updateCodexToml, 'function', 'expected updateCodexToml to be exported from cli.ts');
      const quotedUpdated = updateCodexToml!(
        'model = "o4-mini"\n\n["mcp_servers"."broke"]\nstartup_timeout_sec = 10\n',
        runnerPath,
      );
      const quotedParsed = tomlParser.getStaticTOMLValue(tomlParser.parseTOML(quotedUpdated)) as {
        model: string;
        mcp_servers: { broke: Record<string, unknown> };
      };
      assert.equal(quotedParsed.model, 'o4-mini');
      assert.deepEqual(quotedParsed.mcp_servers.broke, {
        startup_timeout_sec: 10,
        command: 'node',
        args: [runnerPath, 'mcp', '--agent', 'codex'],
      });

      // Invalid & ambiguous/unsupported TOML constructs must fail with specific error and zero writes
      const rejectedTomlCases = [
        { name: 'syntax error', source: 'model = "unterminated\n' },
        { name: 'inline mcp_servers table', source: 'mcp_servers = { inline = true }\n' },
        { name: 'inline broke table in mcp_servers', source: '[mcp_servers]\nbroke = { command = "node" }\n' },
        { name: 'top-level dotted broke key', source: 'mcp_servers.broke.command = "node"\n' },
        { name: 'array of tables [[mcp_servers.broke]]', source: '[[mcp_servers.broke]]\ncommand = "node"\n' },
        { name: 'subtable [mcp_servers.broke.command]', source: '[mcp_servers.broke.command]\npath = "node"\n' },
      ];

      for (const tc of rejectedTomlCases) {
        const subWs = makeTempWorkspace();
        try {
          const badTomlPath = join(subWs.projectDir, '.codex', 'config.toml');
          const agentsMdPath = join(subWs.projectDir, 'AGENTS.md');
          writeSeed(badTomlPath, tc.source);

          const badRes = executeAgentInstall({
            agent: 'codex',
            targetDir: subWs.projectDir,
            runnerPath,
          });
          assert.equal(badRes.ok, false, `expected failure for ${tc.name}`);
          assert.equal(badRes.files.length, 0);
          assert.match(badRes.text, /toml|mcp_servers/i);
          assert.equal(readFileSync(badTomlPath, 'utf-8'), tc.source, `expected ${tc.name} source untouched`);
          assert.equal(existsSync(agentsMdPath), false, `expected AGENTS.md not to be written for ${tc.name}`);
        } finally {
          subWs.cleanup();
        }
      }
    } finally {
      ws.cleanup();
    }
  });

  it('preserves-foreign-claude-hooks', () => {
    const ws = makeTempWorkspace();
    try {
      const runnerPath = '/opt/broke/scripts/broke-runner.cjs';
      const settingsPath = join(ws.projectDir, '.claude', 'settings.json');
      const seededSettings = {
        model: 'claude-sonnet-4-6',
        permissions: { allow: ['Read', 'Grep'], deny: ['Bash(rm -rf:*)'] },
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              customGroupMeta: 'security-team',
              hooks: [
                {
                  type: 'command',
                  command: 'python3 .claude/guards/bash-guard.py',
                  timeout: 15,
                  customHookMeta: 'strict',
                },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: 'Edit|Write',
              hooks: [
                {
                  type: 'command',
                  command: 'npx prettier --write',
                  async: true,
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node .claude/hooks/on-stop.mjs',
                },
              ],
            },
          ],
        },
      };
      writeSeed(settingsPath, `${JSON.stringify(seededSettings, null, 2)}\n`);

      const first = executeAgentInstall({
        agent: 'claude',
        targetDir: ws.projectDir,
        runnerPath,
      });
      assert.equal(first.ok, true, first.text);

      const second = executeAgentInstall({
        agent: 'claude',
        targetDir: ws.projectDir,
        runnerPath,
      });
      assert.equal(second.ok, true, second.text);

      const after = JSON.parse(readFileSync(settingsPath, 'utf-8')) as typeof seededSettings & {
        hooks: Record<string, Array<Record<string, unknown>>>;
      };

      // Top-level settings & Stop hook must survive verbatim
      assert.equal(after.model, 'claude-sonnet-4-6');
      assert.deepEqual(after.permissions, seededSettings.permissions);
      assert.deepEqual(after.hooks.Stop, seededSettings.hooks.Stop);

      // Foreign PreToolUse Bash guard and custom properties must survive verbatim
      assert.equal(after.hooks.PreToolUse.length, 2);
      assert.deepEqual(after.hooks.PreToolUse[0], seededSettings.hooks.PreToolUse[0]);
      assert.deepEqual(after.hooks.PreToolUse[1], {
        matcher: 'Read|Edit|Write|MultiEdit',
        hooks: [
          {
            type: 'command',
            command: 'node',
            args: [runnerPath, 'hook', 'claude'],
          },
        ],
      });

      // Foreign PostToolUse Edit formatter and custom properties must survive verbatim
      assert.equal(after.hooks.PostToolUse.length, 2);
      assert.deepEqual(after.hooks.PostToolUse[0], seededSettings.hooks.PostToolUse[0]);
      assert.deepEqual(after.hooks.PostToolUse[1], {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: 'node',
            args: [runnerPath, 'hook', 'claude'],
          },
        ],
      });

      // Also verify legacy shell-string Broke hook entries get upgraded in place without duplicating
      const legacyWs = makeTempWorkspace();
      try {
        const legacySettingsPath = join(legacyWs.projectDir, '.claude', 'settings.json');
        const legacySettings = {
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'guard.sh' }],
              },
              {
                matcher: 'Read|Edit|Write|MultiEdit',
                hooks: [
                  {
                    type: 'command',
                    command: 'node "/legacy/location/scripts/broke-runner.cjs" hook claude',
                    timeout: 25,
                  },
                ],
              },
            ],
            PostToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  { type: 'command', command: 'audit-bash.sh' },
                  { type: 'command', command: 'node "/legacy/location/scripts/broke-runner.cjs" hook claude' },
                ],
              },
            ],
          },
        };
        writeSeed(legacySettingsPath, `${JSON.stringify(legacySettings, null, 2)}\n`);

        const upgraded = executeAgentInstall({
          agent: 'claude',
          targetDir: legacyWs.projectDir,
          runnerPath,
        });
        assert.equal(upgraded.ok, true, upgraded.text);

        const upgradedJson = JSON.parse(readFileSync(legacySettingsPath, 'utf-8')) as {
          hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
        };
        assert.equal(upgradedJson.hooks.PreToolUse.length, 2);
        assert.deepEqual(upgradedJson.hooks.PreToolUse[0], legacySettings.hooks.PreToolUse[0]);
        assert.deepEqual(upgradedJson.hooks.PreToolUse[1], {
          matcher: 'Read|Edit|Write|MultiEdit',
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: [runnerPath, 'hook', 'claude'],
              timeout: 25,
            },
          ],
        });

        assert.equal(upgradedJson.hooks.PostToolUse.length, 1);
        assert.deepEqual(upgradedJson.hooks.PostToolUse[0], {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'audit-bash.sh' },
            {
              type: 'command',
              command: 'node',
              args: [runnerPath, 'hook', 'claude'],
            },
          ],
        });
      } finally {
        legacyWs.cleanup();
      }

      // Mixed PreToolUse group with mismatched matcher ("Bash") + legacy Broke hook carrying args: []
      // must keep foreign guard on "Bash" and move Broke hook to "Read|Edit|Write|MultiEdit" preserving timeout
      const mixedWs = makeTempWorkspace();
      try {
        const mixedSettingsPath = join(mixedWs.projectDir, '.claude', 'settings.json');
        const mixedSettings = {
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                customGroupProp: 'keep-on-bash',
                hooks: [
                  { type: 'command', command: 'guard.sh' },
                  {
                    type: 'command',
                    command: 'node "/legacy/location/scripts/broke-runner.cjs" hook claude',
                    args: [] as string[],
                    timeout: 30,
                  },
                ],
              },
            ],
            PostToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  {
                    type: 'command',
                    command: 'node "/legacy/location/scripts/broke-runner.cjs" hook claude',
                    args: [] as string[],
                  },
                ],
              },
            ],
          },
        };
        writeSeed(mixedSettingsPath, `${JSON.stringify(mixedSettings, null, 2)}\n`);

        const mixedFirst = executeAgentInstall({
          agent: 'claude',
          targetDir: mixedWs.projectDir,
          runnerPath,
        });
        assert.equal(mixedFirst.ok, true, mixedFirst.text);
        const mixedFirstBytes = readFileSync(mixedSettingsPath);

        const mixedSecond = executeAgentInstall({
          agent: 'claude',
          targetDir: mixedWs.projectDir,
          runnerPath,
        });
        assert.equal(mixedSecond.ok, true, mixedSecond.text);
        assert.equal(Buffer.compare(mixedFirstBytes, readFileSync(mixedSettingsPath)), 0);

        const mixedJson = JSON.parse(mixedFirstBytes.toString('utf-8')) as {
          hooks: Record<string, Array<Record<string, unknown>>>;
        };
        assert.equal(mixedJson.hooks.PreToolUse.length, 2);
        assert.deepEqual(mixedJson.hooks.PreToolUse[0], {
          matcher: 'Bash',
          customGroupProp: 'keep-on-bash',
          hooks: [{ type: 'command', command: 'guard.sh' }],
        });
        assert.deepEqual(mixedJson.hooks.PreToolUse[1], {
          matcher: 'Read|Edit|Write|MultiEdit',
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: [runnerPath, 'hook', 'claude'],
              timeout: 30,
            },
          ],
        });
        assert.equal(mixedJson.hooks.PostToolUse.length, 1);
        assert.deepEqual(mixedJson.hooks.PostToolUse[0], {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: [runnerPath, 'hook', 'claude'],
            },
          ],
        });
      } finally {
        mixedWs.cleanup();
      }
    } finally {
      ws.cleanup();
    }
  });

  it('install-is-idempotent', () => {
    const runnerPath = 'C:\\Dev\\broke\\scripts\\broke-runner.cjs';

    for (const agent of SUPPORTED_INSTALL_AGENTS) {
      // 1. Fresh directory idempotency
      const freshWs = makeTempWorkspace();
      try {
        const first = executeAgentInstall({ agent, targetDir: freshWs.projectDir, runnerPath });
        assert.equal(first.ok, true, `${agent} first install failed: ${first.text}`);
        const firstBytes = new Map(first.files.map((f) => [f, readFileSync(f)]));

        const second = executeAgentInstall({ agent, targetDir: freshWs.projectDir, runnerPath });
        assert.equal(second.ok, true, `${agent} second install failed: ${second.text}`);
        assert.deepEqual(second.files, first.files);

        for (const f of second.files) {
          const b1 = firstBytes.get(f)!;
          const b2 = readFileSync(f);
          assert.equal(Buffer.compare(b1, b2), 0, `expected ${f} to be byte-identical on second ${agent} install`);
        }
      } finally {
        freshWs.cleanup();
      }

      // 2. Pre-populated directory idempotency (with CRLF & existing foreign configs)
      const seededWs = makeTempWorkspace();
      try {
        writeSeed(
          join(seededWs.projectDir, 'AGENTS.md'),
          '# Team Guidelines\r\n\r\nAlways run unit tests.\r\n',
        );
        writeSeed(
          join(seededWs.projectDir, '.mcp.json'),
          '{\r\n  "mcpServers": {\r\n    "other": { "command": "npx" }\r\n  }\r\n}\r\n',
        );
        writeSeed(
          join(seededWs.projectDir, '.agents', 'mcp_config.json'),
          '{\r\n  "mcpServers": {\r\n    "other": { "command": "npx" }\r\n  }\r\n}\r\n',
        );
        writeSeed(
          join(seededWs.projectDir, '.cursor', 'mcp.json'),
          '{\r\n  "mcpServers": {\r\n    "other": { "command": "npx" }\r\n  }\r\n}\r\n',
        );
        writeSeed(
          join(seededWs.projectDir, '.codex', 'config.toml'),
          '# Existing comment\r\nmodel = "o3"\r\n',
        );
        writeSeed(
          join(seededWs.projectDir, '.claude', 'settings.json'),
          '{\r\n  "hooks": {\r\n    "PreToolUse": [\r\n      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "guard.sh" }] }\r\n    ]\r\n  }\r\n}\r\n',
        );

        const first = executeAgentInstall({ agent, targetDir: seededWs.projectDir, runnerPath });
        assert.equal(first.ok, true, `${agent} seeded first install failed: ${first.text}`);
        const firstBytes = new Map(first.files.map((f) => [f, readFileSync(f)]));

        const second = executeAgentInstall({ agent, targetDir: seededWs.projectDir, runnerPath });
        assert.equal(second.ok, true, `${agent} seeded second install failed: ${second.text}`);

        for (const f of second.files) {
          const b1 = firstBytes.get(f)!;
          const b2 = readFileSync(f);
          assert.equal(
            Buffer.compare(b1, b2),
            0,
            `expected seeded ${f} to be byte-identical on second ${agent} install`,
          );
        }
      } finally {
        seededWs.cleanup();
      }
    }
  });

  it('invalid-config-causes-zero-writes', () => {
    const runnerPath = '/opt/broke/scripts/broke-runner.cjs';

    const cases: Array<{
      name: string;
      agent: InstallAgentOptions['agent'];
      seedRelPath: string;
      seedContent: string | Buffer;
      otherTargetRelPaths: string[];
    }> = [
      {
        name: 'JSON with comments in .cursor/mcp.json',
        agent: 'cursor',
        seedRelPath: '.cursor/mcp.json',
        seedContent: '{\n  // JSONC comment not supported\n  "mcpServers": {\n    "keep": { "command": "npx" }\n  }\n}\n',
        otherTargetRelPaths: ['.cursor/rules/broke.mdc'],
      },
      {
        name: 'truncated JSON in .mcp.json',
        agent: 'claude',
        seedRelPath: '.mcp.json',
        seedContent: '{ "mcpServers": ',
        otherTargetRelPaths: ['.claude/settings.json', '.claude/skills/broke/SKILL.md'],
      },
      {
        name: 'array JSON root in .agents/mcp_config.json',
        agent: 'antigravity',
        seedRelPath: '.agents/mcp_config.json',
        seedContent: '["not", "an", "object"]\n',
        otherTargetRelPaths: ['.agents/skills/broke/SKILL.md', 'AGENTS.md'],
      },
      {
        name: 'string JSON root in .cursor/mcp.json',
        agent: 'cursor',
        seedRelPath: '.cursor/mcp.json',
        seedContent: '"hello"\n',
        otherTargetRelPaths: ['.cursor/rules/broke.mdc'],
      },
      {
        name: 'malformed mcpServers array in .mcp.json',
        agent: 'claude',
        seedRelPath: '.mcp.json',
        seedContent: '{ "mcpServers": ["bad"] }\n',
        otherTargetRelPaths: ['.claude/settings.json', '.claude/skills/broke/SKILL.md'],
      },
      {
        name: 'malformed hooks non-object in .claude/settings.json',
        agent: 'claude',
        seedRelPath: '.claude/settings.json',
        seedContent: '{ "hooks": "invalid" }\n',
        otherTargetRelPaths: ['.mcp.json', '.claude/skills/broke/SKILL.md'],
      },
      {
        name: 'malformed PreToolUse non-array in .claude/settings.json',
        agent: 'claude',
        seedRelPath: '.claude/settings.json',
        seedContent: '{ "hooks": { "PreToolUse": { "matcher": "Bash" } } }\n',
        otherTargetRelPaths: ['.mcp.json', '.claude/skills/broke/SKILL.md'],
      },
      {
        name: 'malformed hook group hooks non-array in .claude/settings.json',
        agent: 'claude',
        seedRelPath: '.claude/settings.json',
        seedContent: '{ "hooks": { "PostToolUse": [{ "matcher": "Bash", "hooks": "bad" }] } }\n',
        otherTargetRelPaths: ['.mcp.json', '.claude/skills/broke/SKILL.md'],
      },
      {
        name: 'AGENTS.md single start marker corruption on antigravity',
        agent: 'antigravity',
        seedRelPath: 'AGENTS.md',
        seedContent: '# Docs\n\n<!-- broke:multi-agent:start -->\ndangling content\n',
        otherTargetRelPaths: ['.agents/mcp_config.json', '.agents/skills/broke/SKILL.md'],
      },
      {
        name: 'AGENTS.md single end marker corruption on codex',
        agent: 'codex',
        seedRelPath: 'AGENTS.md',
        seedContent: '# Docs\n\n<!-- broke:multi-agent:end -->\n',
        otherTargetRelPaths: ['.codex/config.toml'],
      },
      {
        name: 'AGENTS.md reversed markers on codex',
        agent: 'codex',
        seedRelPath: 'AGENTS.md',
        seedContent: '<!-- broke:multi-agent:end -->\n<!-- broke:multi-agent:start -->\n',
        otherTargetRelPaths: ['.codex/config.toml'],
      },
      {
        name: 'invalid TOML in .codex/config.toml',
        agent: 'codex',
        seedRelPath: '.codex/config.toml',
        seedContent: '[mcp_servers.broke\ncommand = "node"\n',
        otherTargetRelPaths: ['AGENTS.md'],
      },
      {
        name: 'invalid UTF-8 bytes in .codex/config.toml',
        agent: 'codex',
        seedRelPath: '.codex/config.toml',
        seedContent: Buffer.concat([Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]), Buffer.from('model = "o3"\n', 'utf-8')]),
        otherTargetRelPaths: ['AGENTS.md'],
      },
      {
        name: 'invalid UTF-8 bytes inside JSON string in .mcp.json',
        agent: 'claude',
        seedRelPath: '.mcp.json',
        seedContent: Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]),
        otherTargetRelPaths: ['.claude/settings.json', '.claude/skills/broke/SKILL.md'],
      },
      {
        name: 'UTF-16LE BOM AGENTS.md on antigravity',
        agent: 'antigravity',
        seedRelPath: 'AGENTS.md',
        seedContent: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# Project Docs\r\n', 'utf16le')]),
        otherTargetRelPaths: ['.agents/mcp_config.json', '.agents/skills/broke/SKILL.md'],
      },
      {
        name: 'UTF-16LE without BOM (NUL bytes) AGENTS.md on codex',
        agent: 'codex',
        seedRelPath: 'AGENTS.md',
        seedContent: Buffer.from('# Project Docs\r\n', 'utf16le'),
        otherTargetRelPaths: ['.codex/config.toml'],
      },
    ];

    for (const tc of cases) {
      for (const dryRun of [true, false]) {
        const ws = makeTempWorkspace();
        try {
          const seedPath = join(ws.projectDir, tc.seedRelPath);
          const expectedSeedBytes = Buffer.isBuffer(tc.seedContent)
            ? tc.seedContent
            : Buffer.from(tc.seedContent, 'utf-8');
          writeSeed(seedPath, expectedSeedBytes);

          // planAgentInstall itself must throw before any writes
          assert.throws(
            () => planAgentInstall({ agent: tc.agent, targetDir: ws.projectDir, dryRun, runnerPath }),
            `expected planAgentInstall to throw for ${tc.name} (dryRun=${String(dryRun)})`,
          );

          const res = executeAgentInstall({
            agent: tc.agent,
            targetDir: ws.projectDir,
            dryRun,
            runnerPath,
          });
          assert.equal(res.ok, false, `expected executeAgentInstall failure for ${tc.name} (dryRun=${String(dryRun)})`);
          assert.equal(res.files.length, 0);

          // Seeded file must retain exact original bytes, and sibling targets must NOT exist
          assert.equal(
            Buffer.compare(readFileSync(seedPath), expectedSeedBytes),
            0,
            `seed modified for ${tc.name}`,
          );
          for (const rel of tc.otherTargetRelPaths) {
            assert.equal(
              existsSync(join(ws.projectDir, rel)),
              false,
              `unexpected write to ${rel} for ${tc.name} (dryRun=${String(dryRun)})`,
            );
          }
        } finally {
          ws.cleanup();
        }
      }
    }

    // Pre-flight parity between dryRun: true and dryRun: false for invalid targetDir and empty runnerPath
    const parityWs = makeTempWorkspace();
    try {
      const blockingFile = join(parityWs.baseDir, 'not-a-directory.txt');
      writeFileSync(blockingFile, 'file blocking child directories\n', 'utf-8');
      const nestedUnderFile = join(blockingFile, 'child-project');

      const danglingLink = join(parityWs.baseDir, 'dangling-target-link');
      symlinkSync(
        join(parityWs.baseDir, 'missing-link-target'),
        danglingLink,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const nestedUnderDangling = join(danglingLink, 'subproject');

      assert.throws(() => cliUpdateCodexToml('', ''));
      assert.throws(() => cliUpdateCodexToml('', '   '));

      for (const dryRun of [true, false]) {
        for (const badTargetDir of [nestedUnderFile, danglingLink, nestedUnderDangling]) {
          assert.throws(
            () => planAgentInstall({ agent: 'codex', targetDir: badTargetDir, dryRun, runnerPath }),
            `expected planAgentInstall to reject invalid targetDir ${badTargetDir} (dryRun=${String(dryRun)})`,
          );
          const badTargetRes = executeAgentInstall({
            agent: 'codex',
            targetDir: badTargetDir,
            dryRun,
            runnerPath,
          });
          assert.equal(
            badTargetRes.ok,
            false,
            `expected executeAgentInstall to reject invalid targetDir ${badTargetDir} (dryRun=${String(dryRun)})`,
          );
        }

        for (const badRunner of ['', '   ']) {
          assert.throws(
            () => planAgentInstall({ agent: 'claude', targetDir: parityWs.projectDir, dryRun, runnerPath: badRunner }),
            `expected planAgentInstall to reject empty runnerPath (dryRun=${String(dryRun)})`,
          );
          const badRunnerRes = executeAgentInstall({
            agent: 'claude',
            targetDir: parityWs.projectDir,
            dryRun,
            runnerPath: badRunner,
          });
          assert.equal(badRunnerRes.ok, false);
        }
      }
    } finally {
      parityWs.cleanup();
    }
  });

  it('write-failure-restores-originals', () => {
    const runnerPath = '/opt/broke/scripts/broke-runner.cjs';

    // 1. Mid-flight write failure restores exact original CRLF bytes of replaced files and deletes newly created files
    const ws = makeTempWorkspace();
    try {
      const mcpPath = join(ws.projectDir, '.mcp.json');
      const settingsPath = join(ws.projectDir, '.claude', 'settings.json');
      const skillPath = join(ws.projectDir, '.claude', 'skills', 'broke', 'SKILL.md');

      const originalMcpBytes = Buffer.from(
        '{\r\n  "mcpServers": {\r\n    "preserve-me": {\r\n      "command": "npx"\r\n    }\r\n  }\r\n}\r\n',
        'utf-8',
      );
      writeSeed(mcpPath, originalMcpBytes);

      let mcpWasMutatedBeforeFailure = false;
      let settingsExistedBeforeFailure = false;

      const optsWithFault = {
        agent: 'claude' as const,
        targetDir: ws.projectDir,
        runnerPath,
        fsOps: {
          renameSync(oldPath: string, newPath: string) {
            if (newPath === skillPath) {
              mcpWasMutatedBeforeFailure = Buffer.compare(readFileSync(mcpPath), originalMcpBytes) !== 0;
              settingsExistedBeforeFailure = existsSync(settingsPath);
              throw new Error('ENOSPC: simulated disk full on third file');
            }
            const fs = require('node:fs') as typeof import('node:fs');
            fs.renameSync(oldPath, newPath);
          },
        },
      } as InstallAgentOptions;

      const res = executeAgentInstall(optsWithFault);
      assert.equal(res.ok, false, 'expected executeAgentInstall to fail on injected fault');
      assert.equal(res.files.length, 0);
      assert.equal(mcpWasMutatedBeforeFailure, true, 'expected .mcp.json to have been replaced before fault');
      assert.equal(settingsExistedBeforeFailure, true, 'expected settings.json to have been created before fault');

      // Exact original CRLF bytes restored
      assert.equal(Buffer.compare(readFileSync(mcpPath), originalMcpBytes), 0, 'expected exact original bytes restored');
      // Newly created file removed
      assert.equal(existsSync(settingsPath), false, 'expected newly created settings.json to be removed on rollback');
      assert.equal(existsSync(skillPath), false, 'expected failed SKILL.md not to exist');
      // No leftover temporary or recovery files in root when rollback succeeded
      const rootEntries = readdirSync(ws.projectDir);
      assert.deepEqual(rootEntries, ['.claude', '.mcp.json'].filter((e) => existsSync(join(ws.projectDir, e))));
    } finally {
      ws.cleanup();
    }

    // 2. Rollback restoration failure is explicitly reported and retains recovery copy with original bytes
    const wsRollbackFail = makeTempWorkspace();
    try {
      const mcpPath = join(wsRollbackFail.projectDir, '.mcp.json');
      const settingsPath = join(wsRollbackFail.projectDir, '.claude', 'settings.json');
      const originalMcpBytes = Buffer.from('{\r\n  "mcpServers": { "critical": { "command": "node" } }\r\n}\r\n', 'utf-8');
      writeSeed(mcpPath, originalMcpBytes);

      let mcpReplaceCount = 0;
      const optsWithRollbackFault = {
        agent: 'claude' as const,
        targetDir: wsRollbackFail.projectDir,
        runnerPath,
        fsOps: {
          renameSync(oldPath: string, newPath: string) {
            if (newPath === settingsPath) {
              throw new Error('EIO: simulated write failure on settings.json');
            }
            if (newPath === mcpPath) {
              mcpReplaceCount += 1;
              if (mcpReplaceCount >= 2) {
                throw new Error('EBUSY: simulated lock during rollback restore');
              }
            }
            const fs = require('node:fs') as typeof import('node:fs');
            fs.renameSync(oldPath, newPath);
          },
        },
      } as InstallAgentOptions;

      const res = executeAgentInstall(optsWithRollbackFault);
      assert.equal(res.ok, false);
      assert.match(res.text, /EIO: simulated write failure/);
      assert.match(res.text, /EBUSY: simulated lock during rollback restore/);
      assert.match(res.text, /recovery/i);

      const recoveryFiles = readdirSync(wsRollbackFail.projectDir).filter((name) => name.includes('recovery'));
      assert.equal(recoveryFiles.length, 1, 'expected retained recovery copy on rollback failure');
      const recoveryBytes = readFileSync(join(wsRollbackFail.projectDir, recoveryFiles[0]));
      assert.equal(
        Buffer.compare(recoveryBytes, originalMcpBytes),
        0,
        'expected recovery copy to hold exact original bytes',
      );
    } finally {
      wsRollbackFail.cleanup();
    }
  });

  it('hook-path-is-literal', () => {
    const adversarialRunnerPath =
      'C:\\Program Files\\dir with spaces\\$(Write-Output substituted)\\quote"and\'tick\\broke-runner.cjs';

    for (const agent of SUPPORTED_INSTALL_AGENTS) {
      const ws = makeTempWorkspace();
      try {
        const res = executeAgentInstall({
          agent,
          targetDir: ws.projectDir,
          runnerPath: adversarialRunnerPath,
        });
        assert.equal(res.ok, true, `${agent} install failed for adversarial runnerPath: ${res.text}`);

        if (agent === 'claude') {
          const mcp = JSON.parse(readFileSync(join(ws.projectDir, '.mcp.json'), 'utf-8')) as {
            mcpServers: { broke: { command: string; args: string[] } };
          };
          assert.equal(mcp.mcpServers.broke.command, 'node');
          assert.deepEqual(mcp.mcpServers.broke.args, [adversarialRunnerPath, 'mcp', '--agent', 'claude']);

          const settings = JSON.parse(readFileSync(join(ws.projectDir, '.claude', 'settings.json'), 'utf-8')) as {
            hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string; args?: string[] }> }>>;
          };
          const preHook = settings.hooks.PreToolUse[0]?.hooks[0];
          const postHook = settings.hooks.PostToolUse[0]?.hooks[0];
          assert.deepEqual(preHook, {
            type: 'command',
            command: 'node',
            args: [adversarialRunnerPath, 'hook', 'claude'],
          });
          assert.deepEqual(postHook, {
            type: 'command',
            command: 'node',
            args: [adversarialRunnerPath, 'hook', 'claude'],
          });
        } else if (agent === 'antigravity') {
          const mcp = JSON.parse(readFileSync(join(ws.projectDir, '.agents', 'mcp_config.json'), 'utf-8')) as {
            mcpServers: { broke: { command: string; args: string[] } };
          };
          assert.equal(mcp.mcpServers.broke.command, 'node');
          assert.deepEqual(mcp.mcpServers.broke.args, [adversarialRunnerPath, 'mcp', '--agent', 'antigravity']);
        } else if (agent === 'codex') {
          const rawToml = readFileSync(join(ws.projectDir, '.codex', 'config.toml'), 'utf-8');
          const parsed = tomlParser.getStaticTOMLValue(tomlParser.parseTOML(rawToml)) as {
            mcp_servers: { broke: { command: string; args: string[] } };
          };
          assert.equal(parsed.mcp_servers.broke.command, 'node');
          assert.deepEqual(parsed.mcp_servers.broke.args, [adversarialRunnerPath, 'mcp', '--agent', 'codex']);
        } else if (agent === 'cursor') {
          const mcp = JSON.parse(readFileSync(join(ws.projectDir, '.cursor', 'mcp.json'), 'utf-8')) as {
            mcpServers: { broke: { command: string; args: string[] } };
          };
          assert.equal(mcp.mcpServers.broke.command, 'node');
          assert.deepEqual(mcp.mcpServers.broke.args, [adversarialRunnerPath, 'mcp', '--agent', 'cursor']);
        }
      } finally {
        ws.cleanup();
      }
    }
  });

  it('antigravity-uses-workspace-paths', () => {
    const ws = makeTempWorkspace();
    try {
      const runnerPath = '/opt/broke/scripts/broke-runner.cjs';
      const legacyMcpPath = join(ws.projectDir, '.gemini', 'antigravity', 'mcp_config.json');
      const legacySkillPath = join(ws.projectDir, '.gemini', 'antigravity', 'skills', 'broke', 'SKILL.md');
      writeSeed(legacyMcpPath, '{"legacy":"do-not-touch"}\n');
      writeSeed(legacySkillPath, 'LEGACY_SKILL_DO_NOT_DELETE\n');

      const res = executeAgentInstall({
        agent: 'antigravity',
        targetDir: ws.projectDir,
        runnerPath,
      });
      assert.equal(res.ok, true, res.text);

      const expectedMcpPath = join(ws.projectDir, '.agents', 'mcp_config.json');
      const expectedSkillPath = join(ws.projectDir, '.agents', 'skills', 'broke', 'SKILL.md');
      const expectedAgentsMdPath = join(ws.projectDir, 'AGENTS.md');

      assert.deepEqual(res.files, [expectedMcpPath, expectedSkillPath, expectedAgentsMdPath]);
      assert.equal(existsSync(expectedMcpPath), true);
      assert.equal(existsSync(expectedSkillPath), true);
      assert.equal(existsSync(expectedAgentsMdPath), true);

      const mcp = JSON.parse(readFileSync(expectedMcpPath, 'utf-8')) as {
        mcpServers: { broke: { command: string; args: string[] } };
      };
      assert.deepEqual(mcp.mcpServers.broke, {
        command: 'node',
        args: [runnerPath, 'mcp', '--agent', 'antigravity'],
      });

      // Legacy .gemini/antigravity files must remain untouched (neither modified nor deleted)
      assert.equal(readFileSync(legacyMcpPath, 'utf-8'), '{"legacy":"do-not-touch"}\n');
      assert.equal(readFileSync(legacySkillPath, 'utf-8'), 'LEGACY_SKILL_DO_NOT_DELETE\n');
    } finally {
      ws.cleanup();
    }
  });

  it('re-exports installer API from cli.ts and runs via scripts/broke-runner.cjs', () => {
    assert.equal(cliMod.planAgentInstall, agentInstallMod.planAgentInstall);
    assert.equal(cliMod.executeAgentInstall, agentInstallMod.executeAgentInstall);
    assert.equal(cliUpdateCodexToml, agentInstallMod.updateCodexToml);
    assert.equal(cliMod.SUPPORTED_INSTALL_AGENTS, agentInstallMod.SUPPORTED_INSTALL_AGENTS);

    const ws = makeTempWorkspace();
    try {
      const tomlPath = join(ws.projectDir, '.codex', 'config.toml');
      writeSeed(tomlPath, '# Runner CJS/ESM interop smoke\r\nmodel = "o3"\r\n');
      const runnerScript = join(__dirname, '..', 'scripts', 'broke-runner.cjs');

      const dryOut = execFileSync(
        process.execPath,
        [runnerScript, 'install-agent', 'codex', '--project', ws.projectDir, '--dry-run'],
        { encoding: 'utf-8', env: { ...process.env, BROKE_DATA_DIR: ws.dataDir } },
      );
      assert.match(dryOut, /dry-run/);
      assert.equal(existsSync(join(ws.projectDir, 'AGENTS.md')), false);

      execFileSync(
        process.execPath,
        [runnerScript, 'install-agent', 'codex', '--project', ws.projectDir],
        { encoding: 'utf-8', env: { ...process.env, BROKE_DATA_DIR: ws.dataDir } },
      );
      const finalToml = readFileSync(tomlPath, 'utf-8');
      assert.match(finalToml, /# Runner CJS\/ESM interop smoke/);
      const parsed = tomlParser.getStaticTOMLValue(tomlParser.parseTOML(finalToml)) as {
        model: string;
        mcp_servers: { broke: { command: string; args: string[] } };
      };
      assert.equal(parsed.model, 'o3');
      assert.equal(parsed.mcp_servers.broke.command, 'node');
    } finally {
      ws.cleanup();
    }
  });
});
