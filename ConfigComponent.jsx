({ config, updateConfig: publishConfig, ui, executeExtensionAction }) => {
  /* BROKE_CONFIG_DRAFT_HELPER */
  const { Select, Checkbox, Input, Tooltip } = ui;
  const [presetError, setPresetError] = React.useState(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [newToolName, setNewToolName] = React.useState('');
  const [newToolLines, setNewToolLines] = React.useState('120');
  const [newToolKB, setNewToolKB] = React.useState('12');
  const [pendingCmd, setPendingCmd] = React.useState(null);
  const [cmdResult, setCmdResult] = React.useState(null);
  const [executingCmd, setExecutingCmd] = React.useState(null);
  const [customCmd, setCustomCmd] = React.useState('');

  const revision = React.useRef(0);
  const currentConfig = React.useRef(config);
  const lastPublished = React.useRef(config);
  if (currentConfig.current !== config) lastPublished.current = config;
  currentConfig.current = config;
  React.useEffect(() => () => { revision.current++; }, []);
  const invalidatePreview = () => { revision.current++; setPreviewing(false); };
  const updateConfig = (next) => {
    invalidatePreview();
    // Handlers capture the last render. Apply only their changed fields to
    // the latest published draft, preserving other edits in the same batch.
    const previous = lastPublished.current ?? {};
    const published = mergeConfigDraft(config ?? {}, previous, next);
    lastPublished.current = published;
    publishConfig(published);
  };

  // Validated number field: uncontrolled input (no re-render while typing),
  // value committed on blur/Enter, invalid input reset to the last valid
  // value. min/max mirror the ConfigSchema bounds so the dialog can never
  // produce a config that saveConfigData rejects. Floats are truncated:
  // every numeric field is z.number().int() in the schema.
  const numberField = (label, value, onChange, min = 1, max = undefined) => (
    <Input
      key={`${label}-${value}`}
      label={label}
      type="number"
      min={String(min)}
      max={max === undefined ? undefined : String(max)}
      defaultValue={String(value ?? '')}
      onBlur={(e) => {
        const n = Math.trunc(Number(e.target.value));
        if (Number.isFinite(n) && n >= min && (max === undefined || n <= max)) {
          if (n !== value) onChange(n);
          e.target.value = String(n);
        } else {
          e.target.value = String(value ?? '');
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );

  const cfg = config ?? {};
  const summarize = cfg.summarize ?? {};
  const truncate = cfg.truncate ?? {};
  const truncateTools = truncate.tools ?? {};
  const brevity = cfg.brevity ?? {};
  const errors = cfg.errors ?? {};
  const sliceCfg = cfg.slice ?? {};
  const uiCfg = cfg.ui ?? {};
  const statsCfg = cfg.stats ?? {};
  const searchCfg = cfg.search ?? {};
  const snapshotCfg = cfg.snapshot ?? {};
  const flushCfg = cfg.flush ?? {};
  const cacheCfg = cfg.cache ?? {};

  const selectMode = async (mode) => {
    const request = ++revision.current;
    const source = lastPublished.current;
    setPreviewing(true);
    setPresetError(null);
    try {
      const next = await executeExtensionAction('previewMode', source ?? {}, mode);
      if (!next || typeof next !== 'object') throw new Error('Missing preset response');
      if (revision.current === request && lastPublished.current === source) {
        lastPublished.current = next;
        publishConfig(next);
      }
    } catch {
      if (revision.current === request) setPresetError('Could not apply preset. Your settings were kept.');
    } finally {
      if (revision.current === request) setPreviewing(false);
    }
  };

  const runDeckCommand = async (rawCmd) => {
    const cmd = String(rawCmd ?? '').trim().replace(/^\/?broke\b\s*/i, '');
    if (!cmd || executingCmd) return;
    // Shared with StatusBadge via the injected helper: `search on/off` count
    // as mutating here too, so both surfaces confirm the same commands.
    const mutating = (typeof brokeCommandIsMutating === 'function' ? brokeCommandIsMutating : () => true)(cmd);
    if (mutating && pendingCmd !== cmd) {
      setPendingCmd(cmd);
      setCmdResult(null);
      return;
    }
    setPendingCmd(null);
    setCmdResult(null);
    setExecutingCmd(cmd);
    try {
      const res = (await executeExtensionAction('runCommand', `broke ${cmd}`)) as { ok?: boolean; message?: string; error?: string } | undefined;
      if (res?.ok === true) {
        setCmdResult({ ok: true, cmd, text: res.message ?? '' });
        const fresh = (await executeExtensionAction('getConfig')) as Record<string, unknown> | undefined;
        if (fresh && typeof fresh === 'object') {
          lastPublished.current = fresh;
          publishConfig(fresh);
        }
      } else {
        setCmdResult({ ok: false, cmd, text: res?.error ?? 'Command returned no result' });
      }
    } catch {
      setCmdResult({ ok: false, cmd, text: 'Command could not be executed' });
    } finally {
      setExecutingCmd(null);
    }
  };

  const addOrUpdateToolRule = (toolName, rule) => {
    const clean = String(toolName ?? '').trim();
    if (!clean || clean === '__proto__' || clean === 'constructor' || clean === 'prototype') return;
    updateConfig({
      ...config,
      truncate: {
        ...truncate,
        tools: {
          ...truncateTools,
          [clean]: rule,
        },
      },
    });
  };

  const removeToolRule = (toolName) => {
    const nextTools = { ...truncateTools };
    delete nextTools[toolName];
    updateConfig({
      ...config,
      truncate: {
        ...truncate,
        tools: nextTools,
      },
    });
  };

  return (
    <div className="flex flex-col gap-5" onChangeCapture={invalidatePreview}>
      <p style={{ fontSize: '12px', color: '#333' }}>
        Compresses the input context before it reaches the model - on every model call, not only at the built-in
        emergency threshold. Everything here can also be changed from the chat (<span style={{ fontFamily: 'monospace' }}>/broke help</span>) or launched directly in the <strong>Interactive Command Deck</strong> below.
      </p>

      <section className="flex flex-col gap-2" aria-label="Mode settings">
        <p style={{ fontSize: '12px', color: '#333' }}>Extension-wide settings: apply to every task using Broke.</p>
        <p style={{ fontSize: '12px', color: '#333' }}>Before selecting Maximum savings: local summaries need a running Ollama server and the configured model installed; cloud summaries send conversation content to your selected provider and may incur costs. Backend and consent settings are not changed. Manual automation only reuses existing summaries.</p>
        <Select
          label="Savings approach"
          value={cfg.mode ?? 'custom'}
          onChange={(value) => void selectMode(value)}
          options={[
            { value: 'short', label: 'Safe - tidy repeated content only' },
            { value: 'normal', label: 'Balanced - shorten old technical output (recommended)' },
            { value: 'long', label: 'Maximum savings - summarize older work (setup required)' },
            { value: 'custom', label: 'Custom - expert settings' },
          ]}
        />
        <Select
          label="Broke automation"
          value={cfg.autonomy ?? 'autonomous'}
          onChange={(value) => updateConfig({ ...config, autonomy: value })}
          options={[
            { value: 'autonomous', label: 'Autonomous - all automatic features follow their switches' },
            { value: 'manual', label: 'Manual - deterministic compression only; no automatic LLM calls' },
          ]}
        />
        <p style={{ fontSize: '12px', color: '#333', marginTop: '8px' }}>
          Autonomy affects Broke only - the host agent's approval settings are unchanged. /broke off remains the master switch.
        </p>
        {previewing ? <p role="status">Previewing preset...</p> : null}
        {presetError ? <p role="alert">{presetError}</p> : null}
      </section>

      {/* 1 - Master switch + level */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Compression pipeline</p>
        <Checkbox
          label="Enable broke"
          checked={cfg.enabled ?? true}
          onChange={(checked) => updateConfig({ ...config, enabled: checked })}
        />
        <Select
          label="Compression level"
          value={cfg.level ?? 'truncate'}
          onChange={(value) => updateConfig({ ...config, level: value })}
          options={[
            { value: 'structural', label: 'Structural - content-preserving only (empty/dedup/merge)' },
            { value: 'truncate', label: 'Truncate - + head/tail truncation of old tool outputs (recommended)' },
            { value: 'summarize', label: 'Summarize - + LLM summary of old turns (most aggressive)' },
          ]}
        />
        <Select
          label="Answer brevity (output token reduction)"
          value={brevity.level ?? 'off'}
          onChange={(value) => updateConfig({ ...config, brevity: { ...brevity, level: value } })}
          options={[
            { value: 'off', label: 'Off - normal assistant responses (Safe preset)' },
            { value: 'lite', label: 'Lite - concise prose, no filler/hedging (Balanced preset)' },
            { value: 'full', label: 'Full - terse caveman-style fragments (Maximum savings preset)' },
            { value: 'ultra', label: 'Ultra - maximum telegraphic compression (Custom)' },
          ]}
        />
        <p style={{ fontSize: '12px', color: '#333', marginTop: '8px' }}>
          The task's stored history is never touched - compression applies to the input of each model call. Answer brevity injects a system-prompt directive (code, commits and PR text always stay intact).
        </p>
      </div>

      {/* 2 - Thresholds */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Thresholds</p>
        <div className="flex gap-4">
          {numberField('Max context chars (engage lossy passes)', cfg.maxContextChars ?? 60000, (n) =>
            updateConfig({ ...config, maxContextChars: n }),
          )}
          {numberField('Protected turns (never compress the last N)', cfg.protectedTurns ?? 2, (n) =>
            updateConfig({ ...config, protectedTurns: n }),
          1, 50)}
        </div>
        <p style={{ fontSize: '12px', color: '#333', marginTop: '8px' }}>
          chars/4 ≈ tokens. The default (60000 chars ≈ 15k tokens) engages before AiderDesk's built-in compaction
          (default 30% of the context window).
        </p>
      </div>

      {/* 2b - Provider prompt cache (cache-friendly mode, task 7) */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Provider prompt cache (cache-friendly mode)</p>
        <Tooltip content="Auto detects the cache rules from the task model: Claude models get Anthropic rules (cache writes 1.25x, hits 0.1x), GPT/o-models get OpenAI rules (cached input 0.5x). Unknown models keep the plain behavior. Anthropic/OpenAI force the rules regardless of the model name.">
          <Select
            label="Cache profile"
            value={cacheCfg.profile ?? 'off'}
            onChange={(value) => updateConfig({ ...config, cache: { ...cacheCfg, profile: value } })}
            options={[
              { value: 'off', label: 'Off - plain behavior, no cache awareness' },
              { value: 'auto', label: 'Auto - detect from the task model (recommended)' },
              { value: 'anthropic', label: 'Anthropic - Claude models (prefix cache, writes 1.25x)' },
              { value: 'openai', label: 'OpenAI - GPT/o-models (automatic prefix cache)' },
            ]}
          />
        </Tooltip>
        <Tooltip content="Budget overruns may trigger ONE deliberate rewrite of the already-sent history (the provider cache is lost once), instead of shipping an over-budget context. Off = sent bytes are never rewritten, even over budget.">
          <Checkbox
            label="Escape hatch: one cache-invalidating rewrite on real budget overruns (recommended)"
            checked={cacheCfg.escapeHatch ?? true}
            onChange={(checked) => updateConfig({ ...config, cache: { ...cacheCfg, escapeHatch: checked } })}
          />
        </Tooltip>
        <Tooltip content="Anthropic only (profile Anthropic). Places the prompt-cache breakpoint at broke's frozen prefix - the last message already sent to the model - instead of letting the host mark the moving tail. The provider then caches the byte-stable history, so a changed tail does not invalidate the cached prefix. Requires AiderDesk 0.88+. No effect on other providers.">
          <Checkbox
            label="Anchor the cache breakpoint at the frozen prefix (Anthropic)"
            checked={cacheCfg.anchorBreakpoint ?? false}
            onChange={(checked) => updateConfig({ ...config, cache: { ...cacheCfg, anchorBreakpoint: checked } })}
          />
        </Tooltip>
        <Tooltip content="For OpenAI organizations with Zero Data Retention, where requests run stateless (store: false) and nothing is stored server-side. OpenAI's cached-input price then cannot apply, so the OpenAI cache rules are switched off instead of being priced optimistically. Only used when the profile is Auto - an explicit profile always wins. broke cannot read this setting from AiderDesk, so it has to be set here.">
          <Checkbox
            label="OpenAI runs stateless (Zero Data Retention)"
            checked={cacheCfg.openaiStateless ?? false}
            onChange={(checked) => updateConfig({ ...config, cache: { ...cacheCfg, openaiStateless: checked } })}
          />
        </Tooltip>
        <p style={{ fontSize: '12px', color: '#333', marginTop: '8px' }}>
          Cache-friendly mode keeps every byte already sent to the model byte-stable, so the provider's prompt cache
          keeps hitting instead of being rewritten on every call. Real overruns of the max context chars budget use the
          escape hatch (one rewrite, cache re-stabilizes afterwards). Measured effects show up in{' '}
          <span style={{ fontFamily: 'monospace' }}>/broke measure</span>.
        </p>
      </div>

      {/* 3 - Error compression */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Error compression (compiler/test output)</p>
        <Checkbox
          label="Compress stack traces & error logs"
          checked={errors.enabled ?? true}
          onChange={(checked) => updateConfig({ ...config, errors: { ...errors, enabled: checked } })}
        />
        <div className="flex gap-4">
          {numberField('Min chars to engage', errors.minChars ?? 8000, (n) =>
            updateConfig({ ...config, errors: { ...errors, minChars: n } }),
          )}
          {numberField('Context lines', errors.contextLines ?? 8, (n) =>
            updateConfig({ ...config, errors: { ...errors, contextLines: n } }),
          1, 30)}
        </div>
        <Checkbox
          label="Tool-level rewrite (rewrites stored history irreversibly)"
          checked={errors.toolLevel ?? false}
          onChange={(checked) => updateConfig({ ...config, errors: { ...errors, toolLevel: checked } })}
        />
        <Checkbox
          label="Save full outputs to the errors archive"
          checked={errors.archive ?? false}
          onChange={(checked) => updateConfig({ ...config, errors: { ...errors, archive: checked } })}
        />
        {errors.archive ? (
          <div className="flex gap-4">
            {numberField('Archive retention (days)', errors.retentionDays ?? 30, (n) =>
              updateConfig({ ...config, errors: { ...errors, retentionDays: n } }),
            1, 365)}
          </div>
        ) : null}
        <p style={{ fontSize: '12px', color: '#333', marginTop: '8px' }}>
          Privacy note: the archive stores raw tool output (source code, URLs, paths) locally on disk, redacted on a
          best-effort basis. It is capped at 100 MB and files older than the retention age are deleted;{' '}
          <span style={{ fontFamily: 'monospace' }}>/broke errors clear</span> removes everything now.
        </p>
      </div>

      {/* 4 - Truncation limits & Per-tool overrides */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Truncation limits (old tool outputs)</p>
        <div className="flex gap-4">
          {numberField('Max lines', truncate.maxLines ?? 200, (n) =>
            updateConfig({ ...config, truncate: { ...truncate, maxLines: n } }),
          )}
          {numberField('Max KB', truncate.maxKB ?? 20, (n) =>
            updateConfig({ ...config, truncate: { ...truncate, maxKB: n } }),
          )}
          {numberField('Max input chars', truncate.maxInputChars ?? 2000, (n) =>
            updateConfig({ ...config, truncate: { ...truncate, maxInputChars: n } }),
          )}
        </div>
        <Checkbox
          label="Tool-level truncation (rewrites stored history irreversibly)"
          checked={truncate.toolLevel ?? false}
          onChange={(checked) => updateConfig({ ...config, truncate: { ...truncate, toolLevel: checked } })}
        />
        <Checkbox
          label="Save full truncated outputs to the errors archive"
          checked={truncate.archive ?? false}
          onChange={(checked) => updateConfig({ ...config, truncate: { ...truncate, archive: checked } })}
        />
        {truncate.archive ? (
          <div className="flex gap-4">
            {numberField('Truncate archive retention (days)', truncate.retentionDays ?? 30, (n) =>
              updateConfig({ ...config, truncate: { ...truncate, retentionDays: n } }),
            1, 365)}
          </div>
        ) : null}

        {/* Per-tool truncation overrides manager */}
        <div style={{ marginTop: 8, padding: 10, border: '1px solid rgba(0,0,0,0.12)', borderRadius: 6 }}>
          <p className="text-xs font-medium" style={{ marginBottom: 6 }}>Per-tool truncation rules (truncate.tools)</p>
          {Object.keys(truncateTools).length > 0 ? (
            <div className="flex flex-col gap-2" style={{ marginBottom: 8 }}>
              {Object.entries(truncateTools).map(([toolName, rule]) => {
                const r = (rule ?? {}) as { enabled?: boolean; maxLines?: number; maxKB?: number };
                return (
                  <div key={toolName} className="flex items-center justify-between gap-2" style={{ fontSize: 12, padding: '4px 8px', background: 'rgba(0,0,0,0.03)', borderRadius: 4 }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{toolName}</span>
                    <span>
                      {r.enabled === false ? 'exempt (off)' : `${r.maxLines ?? truncate.maxLines ?? 200} lines / ${r.maxKB ?? truncate.maxKB ?? 20} KB`}
                    </span>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => addOrUpdateToolRule(toolName, { ...r, enabled: r.enabled === false })} style={{ padding: '4px 8px', fontSize: 11, border: '1px solid rgba(0,0,0,0.2)', borderRadius: 4, background: '#fff', cursor: 'pointer' }}>
                        {r.enabled === false ? 'Enable' : 'Exempt'}
                      </button>
                      <button type="button" onClick={() => removeToolRule(toolName)} style={{ padding: '4px 8px', fontSize: 11, border: '1px solid rgba(0,0,0,0.2)', borderRadius: 4, background: '#fff', cursor: 'pointer' }}>Reset</button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p style={{ fontSize: 11, color: '#666', marginBottom: 8 }}>No per-tool overrides configured — global limits apply to all tools.</p>
          )}
          <div className="flex gap-2 items-end">
            <Input
              label="Tool name"
              defaultValue={newToolName}
              onChange={(e) => setNewToolName(e.target.value)}
              onBlur={(e) => setNewToolName(e.target.value)}
            />
            <Input
              label="Tool max lines"
              type="number"
              min="1"
              defaultValue={newToolLines}
              onChange={(e) => setNewToolLines(e.target.value)}
              onBlur={(e) => setNewToolLines(e.target.value)}
            />
            <Input
              label="Tool max KB"
              type="number"
              min="1"
              defaultValue={newToolKB}
              onChange={(e) => setNewToolKB(e.target.value)}
              onBlur={(e) => setNewToolKB(e.target.value)}
            />
            <button
              type="button"
              onClick={() => {
                const l = Math.trunc(Number(newToolLines));
                const k = Math.trunc(Number(newToolKB));
                if (newToolName.trim() && l > 0 && k > 0) {
                  addOrUpdateToolRule(newToolName.trim(), { enabled: true, maxLines: l, maxKB: k });
                  setNewToolName('');
                }
              }}
              style={{ padding: '6px 12px', fontSize: 12, border: '1px solid rgba(0,0,0,0.2)', borderRadius: 5, background: '#fff', cursor: 'pointer', fontWeight: 600 }}
            >
              Add / Update Rule
            </button>
          </div>
        </div>
      </div>

      {/* 4b - ST-Slicing (F2) */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">ST-Slicing (interface views for large file reads)</p>
        <Checkbox
          label="Enable ST-slicing (rewrites large file reads into interface views in stored history)"
          checked={sliceCfg.enabled ?? false}
          onChange={(checked) => updateConfig({ ...config, slice: { ...sliceCfg, enabled: checked } })}
        />
        <Select
          label="Slice parser"
          value={sliceCfg.parser ?? 'heuristic'}
          onChange={(value) => updateConfig({ ...config, slice: { ...sliceCfg, parser: value } })}
          options={[
            { value: 'heuristic', label: 'Heuristic - fast signature & declaration extraction (v1)' },
            { value: 'ast', label: 'AST - reserved for web-tree-sitter (v2)' },
          ]}
        />
        <div className="flex gap-4">
          {numberField('Slice min file chars', sliceCfg.minChars ?? 4000, (n) =>
            updateConfig({ ...config, slice: { ...sliceCfg, minChars: n } }),
          )}
          {numberField('Slice view cap chars', sliceCfg.maxChars ?? 20000, (n) =>
            updateConfig({ ...config, slice: { ...sliceCfg, maxChars: n } }),
          )}
        </div>
        <Checkbox
          label="Derive slice focus automatically from edit-tool calls and updated files"
          checked={sliceCfg.focusAuto ?? true}
          onChange={(checked) => updateConfig({ ...config, slice: { ...sliceCfg, focusAuto: checked } })}
        />
        <p style={{ fontSize: '12px', color: '#333', marginTop: '8px' }}>
          Files smaller than the minimum pass through untouched; the active focus file always returns in full.
        </p>
      </div>

      {/* 5 - Summarizer */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Summarizer</p>
        <Select
          label="Backend"
          value={summarize.via ?? 'local'}
          onChange={(value) => updateConfig({ ...config, summarize: { ...summarize, via: value } })}
          options={[
            { value: 'local', label: 'Local (Ollama) - zero cloud tokens' },
            { value: 'cloud', label: 'Cloud - AiderDesk model registry' },
          ]}
        />
        {summarize.via === 'local' ? (
          <div className="flex gap-4">
            <Input
              label="Ollama model"
              defaultValue={summarize.localModel ?? 'qwen2.5-coder:3b'}
              onBlur={(e) => {
                if (e.target.value.trim()) updateConfig({ ...config, summarize: { ...summarize, localModel: e.target.value.trim() } });
              }}
            />
            <Input
              label="Ollama URL"
              defaultValue={summarize.ollamaUrl ?? 'http://127.0.0.1:11434'}
              onBlur={(e) => {
                if (e.target.value.trim()) updateConfig({ ...config, summarize: { ...summarize, ollamaUrl: e.target.value.trim() } });
              }}
            />
          </div>
        ) : (
          <Input
            label="Cloud model id (provider/model - empty = task model)"
            defaultValue={summarize.cloudModelId ?? ''}
            onBlur={(e) => updateConfig({ ...config, summarize: { ...summarize, cloudModelId: e.target.value.trim() } })}
          />
        )}
        {(summarize.via ?? 'local') === 'local' ? (
          <Checkbox
            label="Allow remote Ollama host (conversation content is sent to that machine)"
            checked={summarize.allowRemoteHost ?? false}
            onChange={(checked) => updateConfig({ ...config, summarize: { ...summarize, allowRemoteHost: checked } })}
          />
        ) : null}
        <div className="flex gap-4">
          {numberField('Summarize only turns older than (user turns)', summarize.afterTurns ?? 8, (n) =>
            updateConfig({ ...config, summarize: { ...summarize, afterTurns: n } }),
          2, 100)}
          {numberField('Min region chars', summarize.minChars ?? 8000, (n) =>
            updateConfig({ ...config, summarize: { ...summarize, minChars: n } }),
          )}
          {numberField('Max summary chars', summarize.maxSummaryChars ?? 4000, (n) =>
            updateConfig({ ...config, summarize: { ...summarize, maxSummaryChars: n } }),
          )}
        </div>
        <p style={{ fontSize: '12px', color: '#333', marginTop: '8px' }}>
          Local summarization needs Ollama running (<span style={{ fontFamily: 'monospace' }}>ollama serve</span>) with the model
          pulled (<span style={{ fontFamily: 'monospace' }}>ollama pull {summarize.localModel ?? 'qwen2.5-coder:3b'}</span>). The
          first summary after the threshold adds a short delay; later runs reuse the cached summary until new turns arrive.
        </p>
      </div>

      {/* 6 - Local project search (F4) */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Local project search (broke-search tool)</p>
        <Checkbox
          label="Register broke-search for agents (offline keyword index)"
          checked={searchCfg.enabled ?? true}
          onChange={(checked) => updateConfig({ ...config, search: { ...searchCfg, enabled: checked } })}
        />
        <Checkbox
          label="Include git-ignored files in the local search index (dot-paths & secrets stay excluded)"
          checked={searchCfg.includeGitIgnored ?? false}
          onChange={(checked) => updateConfig({ ...config, search: { ...searchCfg, includeGitIgnored: checked } })}
        />
        <div className="flex gap-4">
          {numberField('Max results per query', searchCfg.maxResults ?? 8, (n) =>
            updateConfig({ ...config, search: { ...searchCfg, maxResults: n } }),
          1, 50)}
          {numberField('Total char budget per query', searchCfg.maxChars ?? 6000, (n) =>
            updateConfig({ ...config, search: { ...searchCfg, maxChars: n } }),
          500, 50_000)}
          {numberField('Context lines around match', searchCfg.contextLines ?? 6, (n) =>
            updateConfig({ ...config, search: { ...searchCfg, contextLines: n } }),
          1, 20)}
          {numberField('Skip files larger than (KB)', searchCfg.maxFileKB ?? 512, (n) =>
            updateConfig({ ...config, search: { ...searchCfg, maxFileKB: n } }),
          1, 2048)}
          {numberField('Scan budget per refresh (ms)', searchCfg.scanBudgetMs ?? 2000, (n) =>
            updateConfig({ ...config, search: { ...searchCfg, scanBudgetMs: n } }),
          100, 60_000)}
        </div>
        <p style={{ fontSize: '12px', color: '#333', marginTop: '8px' }}>
          The per-project index under <span style={{ fontFamily: 'monospace' }}>index/</span> stores term postings and metadata only -
          never file contents; snippets are read live from disk. Honest tradeoff: every registered tool ships its JSON
          schema with each model call, so disable this if every token counts.{' '}
          <span style={{ fontFamily: 'monospace' }}>/broke index status</span> reports what was built.
        </p>
      </div>

      {/* 7 - UI */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">UI &amp; measurement</p>
        <Checkbox
          label="Show the 💸 saved-tokens badge in the task status bar"
          checked={uiCfg.showStatusBadge ?? true}
          onChange={(checked) => updateConfig({ ...config, ui: { ...uiCfg, showStatusBadge: checked } })}
        />
        <Checkbox
          label="Show 'broke: why' in the per-message dropdown menu (AiderDesk 0.85+)"
          checked={uiCfg.showMessageMenu ?? false}
          onChange={(checked) => updateConfig({ ...config, ui: { ...uiCfg, showMessageMenu: checked } })}
        />
        <Checkbox
          label="Record every compression run to measure.jsonl"
          checked={statsCfg.measure ?? true}
          onChange={(checked) => updateConfig({ ...config, stats: { ...statsCfg, measure: checked } })}
        />
        <p style={{ fontSize: '12px', color: '#333', marginTop: '8px' }}>
          Per-run records (sizes + per-pass removals, no content, no paths) are what <span style={{ fontFamily: 'monospace' }}>/broke
          measure</span> and <span style={{ fontFamily: 'monospace' }}>npm run measure</span> analyze - the provable real-session
          numbers. At 5 MB the file is rotated aside (kept as .1/.2/.3) instead of being rewritten.
        </p>
      </div>

      {/* 8 - Milestones & destructive operations (BRK-028) */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Milestones &amp; destructive operations</p>
        <Checkbox
          label="Record a snapshot after every successful commit"
          checked={snapshotCfg.onCommit ?? true}
          onChange={(checked) => updateConfig({ ...config, snapshot: { ...snapshotCfg, onCommit: checked } })}
        />
        <Checkbox
          label="Record a snapshot when tool output looks like passing tests"
          checked={snapshotCfg.onTestPass ?? false}
          onChange={(checked) => updateConfig({ ...config, snapshot: { ...snapshotCfg, onTestPass: checked } })}
        />
        <Checkbox
          label="Keep raw message history with every snapshot (undo source; contains conversation content)"
          checked={snapshotCfg.keepHistory ?? false}
          onChange={(checked) => updateConfig({ ...config, snapshot: { ...snapshotCfg, keepHistory: checked } })}
        />
        <Checkbox
          label="Ask for confirmation before /broke flush (recommended)"
          checked={flushCfg.confirm ?? true}
          onChange={(checked) => updateConfig({ ...config, flush: { ...flushCfg, confirm: checked } })}
        />
        <Checkbox
          label="Keep the pre-flush history file so /broke flush --undo can restore it"
          checked={flushCfg.undo ?? true}
          onChange={(checked) => updateConfig({ ...config, flush: { ...flushCfg, undo: checked } })}
        />
        <p style={{ fontSize: '12px', color: '#333', marginTop: '8px' }}>
          Snapshots are small JSON milestones; only the destructive flush writes raw history (undo file), and only when
          this switch is on. Every option here is also reachable via <span style={{ fontFamily: 'monospace' }}>/broke config get|set</span>.
        </p>
      </div>

      {/* 9 - Interactive Command & Maintenance Deck */}
      <div className="flex flex-col gap-2" style={{ padding: 12, border: '1px solid rgba(0,0,0,0.14)', borderRadius: 8, background: '#f8fafc' }}>
        <p className="text-sm font-medium">Interactive Command &amp; Maintenance Deck</p>
        <p style={{ fontSize: '12px', color: '#333' }}>
          Run any Broke diagnostic, maintenance, or lifecycle command directly from Settings (mutating actions require a second click to confirm):
        </p>
        <div className="flex flex-wrap gap-2">
          {[
            'status',
            'stats',
            'why',
            'estimate',
            'measure',
            'diff',
            'index status',
            'index rebuild',
            'slice status',
            'snapshot list',
            'summarize now',
            'errors clear',
            'truncate clear',
            'config list',
            'selftest',
            'update check',
            'update',
            'reset',
            'help',
          ].map((cmd) => (
            <button
              key={cmd}
              type="button"
              disabled={executingCmd !== null}
              onClick={() => void runDeckCommand(cmd)}
              style={{
                padding: '6px 10px',
                fontSize: 12,
                border: pendingCmd === cmd ? '1px solid #d4a017' : '1px solid rgba(0,0,0,0.18)',
                borderRadius: 5,
                background: pendingCmd === cmd ? '#fff3cd' : '#ffffff',
                color: pendingCmd === cmd ? '#7a5c00' : '#111',
                cursor: executingCmd !== null ? 'not-allowed' : 'pointer',
                fontWeight: 500,
                opacity: executingCmd !== null && executingCmd !== cmd ? 0.6 : 1,
              }}
            >
              {executingCmd === cmd ? `Running /broke ${cmd}...` : pendingCmd === cmd ? `Confirm? /broke ${cmd}` : `/broke ${cmd}`}
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-end" style={{ marginTop: 6 }}>
          <Input
            label="Run custom /broke command"
            defaultValue={customCmd}
            onChange={(e) => setCustomCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && customCmd.trim()) {
                e.preventDefault();
                void runDeckCommand(customCmd.trim());
              }
            }}
          />
          <button
            type="button"
            disabled={executingCmd !== null || !customCmd.trim()}
            onClick={() => void runDeckCommand(customCmd)}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              border: '1px solid #005bb7',
              borderRadius: 5,
              background: '#0066cc',
              color: '#fff',
              cursor: executingCmd !== null || !customCmd.trim() ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              opacity: executingCmd !== null || !customCmd.trim() ? 0.6 : 1,
            }}
          >
            {executingCmd === customCmd.trim().replace(/^\/?broke\b\s*/i, '') ? 'Executing...' : pendingCmd && pendingCmd === customCmd.trim().replace(/^\/?broke\b\s*/i, '') ? 'Confirm Execute' : 'Execute Command'}
          </button>
        </div>
        {cmdResult ? (
          <pre
            role="status"
            style={{
              marginTop: 8,
              padding: 10,
              fontSize: 11,
              fontFamily: 'monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: cmdResult.ok ? '#f0fdf4' : '#fef2f2',
              border: `1px solid ${cmdResult.ok ? '#bbf7d0' : '#fecaca'}`,
              borderRadius: 6,
              color: cmdResult.ok ? '#14532d' : '#7f1d1d',
              maxHeight: 220,
              overflowY: 'auto',
            }}
          >
            {cmdResult.text}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
