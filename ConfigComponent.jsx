({ config, updateConfig, ui }) => {
  const { Select, Checkbox, Input } = ui;

  // Validated number field: uncontrolled input (no re-render while typing),
  // value committed on blur/Enter, invalid input reset to the last valid value.
  const numberField = (label, value, onChange, min = 1) => (
    <Input
      label={label}
      type="number"
      min={String(min)}
      defaultValue={String(value ?? '')}
      onBlur={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n) && n >= min) {
          if (n !== value) onChange(n);
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
  const errors = cfg.errors ?? {};
  const uiCfg = cfg.ui ?? {};

  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-text-secondary">
        Compresses the input context before it reaches the model — on every model call, not only at the built-in
        emergency threshold. Everything here can also be changed from the chat: <span className="font-mono">/broke help</span>.
      </p>

      {/* 1 — Master switch + level */}
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
            { value: 'structural', label: 'Structural — lossless only (empty/dedup/merge)' },
            { value: 'truncate', label: 'Truncate — + head/tail truncation of old tool outputs (recommended)' },
            { value: 'summarize', label: 'Summarize — + LLM summary of old turns (most aggressive)' },
          ]}
        />
        <p className="text-xs text-text-secondary -mt-2">
          The task's stored history is never touched — compression applies to the input of each model call.
        </p>
      </div>

      {/* 2 — Thresholds */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Thresholds</p>
        <div className="flex gap-4">
          {numberField('Max context chars (engage lossy passes)', cfg.maxContextChars ?? 60000, (n) =>
            updateConfig({ ...config, maxContextChars: n }),
          )}
          {numberField('Protected turns (never compress the last N)', cfg.protectedTurns ?? 2, (n) =>
            updateConfig({ ...config, protectedTurns: n }),
          )}
        </div>
        <p className="text-xs text-text-secondary -mt-2">
          chars/4 ≈ tokens. The default (60000 chars ≈ 15k tokens) engages before AiderDesk's built-in compaction
          (default 30% of the context window).
        </p>
      </div>

      {/* 3 — Error compression */}
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
          )}
        </div>
        <Checkbox
          label="Tool-level rewrite (rewrites stored history, archives full output)"
          checked={errors.toolLevel ?? false}
          onChange={(checked) => updateConfig({ ...config, errors: { ...errors, toolLevel: checked } })}
        />
      </div>

      {/* 4 — Truncation limits */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Truncation limits (old tool outputs)</p>
        <div className="flex gap-4">
          {numberField('Max lines', truncate.maxLines ?? 200, (n) =>
            updateConfig({ ...config, truncate: { ...truncate, maxLines: n } }),
          )}
          {numberField('Max KB', truncate.maxKB ?? 20, (n) =>
            updateConfig({ ...config, truncate: { ...truncate, maxKB: n } }),
          )}
        </div>
      </div>

      {/* 5 — Summarizer */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Summarizer</p>
        <Select
          label="Backend"
          value={summarize.via ?? 'local'}
          onChange={(value) => updateConfig({ ...config, summarize: { ...summarize, via: value } })}
          options={[
            { value: 'local', label: 'Local (Ollama) — zero cloud tokens' },
            { value: 'cloud', label: 'Cloud — AiderDesk model registry' },
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
            label="Cloud model id (provider/model — empty = task model)"
            defaultValue={summarize.cloudModelId ?? ''}
            onBlur={(e) => updateConfig({ ...config, summarize: { ...summarize, cloudModelId: e.target.value.trim() } })}
          />
        )}
        <div className="flex gap-4">
          {numberField('Summarize only turns older than (user turns)', summarize.afterTurns ?? 8, (n) =>
            updateConfig({ ...config, summarize: { ...summarize, afterTurns: n } }),
          )}
          {numberField('Min region chars', summarize.minChars ?? 8000, (n) =>
            updateConfig({ ...config, summarize: { ...summarize, minChars: n } }),
          )}
        </div>
        <p className="text-xs text-text-secondary -mt-2">
          Local summarization needs Ollama running (<span className="font-mono">ollama serve</span>) with the model
          pulled (<span className="font-mono">ollama pull {summarize.localModel ?? 'qwen2.5-coder:3b'}</span>). The
          first summary after the threshold adds a short delay; later runs reuse the cached summary until new turns arrive.
        </p>
      </div>

      {/* 5 — UI */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">UI</p>
        <Checkbox
          label="Show the 💸 saved-tokens badge in the task status bar"
          checked={uiCfg.showStatusBadge ?? true}
          onChange={(checked) => updateConfig({ ...config, ui: { ...uiCfg, showStatusBadge: checked } })}
        />
      </div>
    </div>
  );
}
