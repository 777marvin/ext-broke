({ data, executeExtensionAction }) => {
  // Badge settings overlay (task 7): one-click access to the core knobs.
  // The overlay reads the full config via 'getConfig' and saves through
  // 'setConfig' - the same validated path as the settings dialog (a schema
  // rejection returns ok:false and keeps the previous config, which the
  // overlay shows as an error line instead of silently "saving").
  const [overlayOpen, setOverlayOpen] = React.useState(false);
  const [overlayCfg, setOverlayCfg] = React.useState(null);
  const [overlayError, setOverlayError] = React.useState(null);
  const [saving, setSaving] = React.useState(false);

  const loadOverlayConfig = async () => {
    setOverlayError(null);
    try {
      const c = await executeExtensionAction?.('getConfig');
      setOverlayCfg(c && typeof c === 'object' ? c : null);
    } catch {
      setOverlayError('could not load the config');
    }
  };

  const openOverlay = () => {
    setOverlayOpen(true);
    void loadOverlayConfig();
  };

  const saveOverlay = async () => {
    setSaving(true);
    try {
      const res = (await executeExtensionAction?.('setConfig', overlayCfg)) as { ok?: boolean; config?: Record<string, unknown> } | undefined;
      const ok = res?.ok === true;
      if (res?.config && typeof res.config === 'object') {
        setOverlayCfg(res.config);
        setOverlayError(ok ? null : 'invalid value - the previous config was kept');
      }
      if (ok) {
        setOverlayOpen(false);
        executeExtensionAction?.('refresh').catch?.(() => {});
      }
    } catch {
      setOverlayError('could not save the config');
    } finally {
      setSaving(false);
    }
  };

  const patchOverlay = (patch) => setOverlayCfg((c) => (c && typeof c === 'object' ? { ...c, ...patch } : c));
  const numberCommit = (key, fallback) => (e) => {
    const n = Math.trunc(Number(e.target.value));
    if (Number.isFinite(n) && n > 0) patchOverlay({ [key]: n });
    else e.target.value = String(overlayCfg?.[key] ?? fallback);
  };
  const overlayCache = overlayCfg?.cache ?? {};

  // Polling fallback: re-fetches the data every 10s even if a push event
  // (triggerUIDataRefresh after a compression run) was missed by the
  // renderer - same pattern as the ext-savemytoken badge.
  // BRK-029: the poll runs ONLY while a summarizer backend is actually
  // active (level 'summarize' with a configured backend). Without one the
  // data is static between user actions - push events cover those - and
  // an idle interval would only keep the renderer busy.
  const activeBackend = data?.level === 'summarize' && data?.summarizerConfigured !== 'none';
  React.useEffect(() => {
    if (!activeBackend) return undefined;
    const p = setInterval(() => {
      executeExtensionAction?.('refresh').catch?.(() => {});
    }, 10000);
    return () => clearInterval(p);
  }, [activeBackend]);

  // Always render: until the first data fetch arrives the badge shows 0
  // instead of disappearing entirely.
  const s = data?.savedTokens ?? { structural: 0, error: 0, truncate: 0, summarize: 0 };
  const total = data?.totalSavedTokens ?? 0;
  const level = data?.level ?? 'off';
  const configured = data?.summarizerConfigured ?? 'none';
  const used = data?.summarizerUsed ?? 'none';
  const failed = data?.summarizeFailures ?? 0;
  const ollama = data?.ollama ?? null;
  const cost = data?.cost ?? { savedUsd: null, modelLabel: null };
  const disabled = data?.summarizeDisabled ?? false;
  // Counterfactual/one-shot estimates (E5 honesty, BRK-022): slice, flush
  // and search are MODELED figures that never enter totalSavedTokens.
  const est = data?.estimates ?? null;
  const showEstimates =
    !!est && ((est.slice ?? 0) > 0 || (est.flush ?? 0) > 0 || (est.search ?? 0) > 0);
  // Idle transparency (XF17): when nothing was ever compressed for this
  // task, show WHY instead of a bare suspicious 0 - the last optimize run's
  // input size vs the configured threshold.
  const maxCtx = data?.maxContextChars ?? 0;
  const passes = data?.passes ?? 0;
  const obs = data?.observation ?? null;
  const neverSaved = total === 0 && passes === 0;
  const k = (n) => `${Math.round(n / 1000)}k`;

  const backendLabel = configured === 'local' ? 'local (Ollama)' : configured === 'cloud' ? 'cloud' : 'off';
  const usedLabel = used === 'local' ? 'local (Ollama)' : used === 'cloud' ? 'cloud' : 'never yet';
  const usedNote =
    used === 'none' && configured !== 'none'
      ? ' - only fires when the input exceeds the maxchars threshold AND the region is older than summarize.afterTurns'
      : '';
  const ollamaNote = configured === 'local'
    ? ollama
      ? ollama.reachable
        ? `ollama: reachable (${ollama.models} models)`
        : `ollama: NOT reachable (${ollama.error || 'unknown'}) - local summaries inactive (ollama serve)`
      : 'ollama: status unknown'
    : '';

  const money =
    cost.savedUsd != null && cost.savedUsd > 0
      ? ` ≈ $${cost.savedUsd < 0.01 ? cost.savedUsd.toFixed(4) : cost.savedUsd.toFixed(2)}`
      : '';
  const title = [
    `broke - level: ${level}`,
    `scope: conversation messages only (system prompt & tool schemas are never compressed)`,
    `saved ≈ ${total.toLocaleString('en-US')} input tokens${money} (chars/4 estimate)`,
    neverSaved && obs && obs.inputChars > 0 && maxCtx > 0
      ? `idle: last optimize run saw ${obs.inputChars.toLocaleString('en-US')} of ${maxCtx.toLocaleString('en-US')} chars - below threshold, nothing to compress yet (/broke why for details)`
      : '',
    cost.modelLabel ? `  at current task model: ${cost.modelLabel}` : '',
    `  structural: ${(s.structural ?? 0).toLocaleString('en-US')} | error: ${(s.error ?? 0).toLocaleString('en-US')} | truncate: ${(s.truncate ?? 0).toLocaleString('en-US')} | summarize: ${(s.summarize ?? 0).toLocaleString('en-US')}`,
    showEstimates
      ? `  estimates: slice ${(est.slice ?? 0).toLocaleString('en-US')} (modeled) · flush ${(est.flush ?? 0).toLocaleString('en-US')} / search ${(est.search ?? 0).toLocaleString('en-US')} - counterfactual, NOT counted above (/broke estimate)`
      : '',
    `summarizer: configured ${backendLabel} · used ${usedLabel}${usedNote}${failed > 0 ? ` - ${failed} failure(s)` : ''}${disabled ? ' - auto-disabled after repeated failures (/broke reset re-enables)' : ''}`,
    ollamaNote ? `  ${ollamaNote}` : '',
    'click the task input for /broke stats',
  ]
    .filter(Boolean)
    .join('\n');

  const ollamaDown = configured === 'local' && ollama && !ollama.reachable;
  return (
    <div
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 12,
        lineHeight: 1,
        opacity: 0.9,
        whiteSpace: 'nowrap',
      }}
    >
      <span>💸</span>
      <span>{total.toLocaleString('en-US')}</span>
      {neverSaved && obs && obs.inputChars > 0 && maxCtx > 0 ? (
        <span style={{ opacity: 0.7 }}>
          · {k(obs.inputChars)}/{k(maxCtx)}
        </span>
      ) : null}
      {level === 'summarize' && configured !== 'none' ? (
        <span title="summarizer backend">{configured === 'local' ? '🖥' : '☁'}{ollamaDown ? '⚠' : null}</span>
      ) : null}
      <button
        type="button"
        title="broke settings"
        onClick={(e) => {
          e.stopPropagation();
          openOverlay();
        }}
        style={{
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          fontSize: 11,
          lineHeight: 1,
          padding: 0,
          opacity: 0.75,
        }}
      >
        ⚙
      </button>
      {overlayOpen ? (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.45)',
            fontSize: 12,
          }}
        >
          <div
            style={{
              background: 'var(--bg, #1e1e1e)',
              color: 'var(--text, #ddd)',
              border: '1px solid rgba(128,128,128,0.4)',
              borderRadius: 8,
              padding: 16,
              width: 420,
              maxWidth: '92vw',
              maxHeight: '86vh',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13 }}>broke settings</div>
            {overlayError ? <div style={{ color: '#e06c75' }}>{overlayError}</div> : null}
            {!overlayCfg ? (
              <div style={{ opacity: 0.7 }}>loading…</div>
            ) : (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={overlayCfg.enabled ?? true}
                    onChange={(e) => patchOverlay({ enabled: e.target.checked })}
                  />
                  Enable broke
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  Compression level
                  <select value={overlayCfg.level ?? 'truncate'} onChange={(e) => patchOverlay({ level: e.target.value })}>
                    <option value="structural">Structural - content-preserving only</option>
                    <option value="truncate">Truncate - + truncation of old tool outputs</option>
                    <option value="summarize">Summarize - + LLM summary (needs backend)</option>
                  </select>
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
                    Max context chars
                    <input type="number" min="1000" defaultValue={String(overlayCfg.maxContextChars ?? 60000)} onBlur={numberCommit('maxContextChars', 60000)} />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
                    Protected turns
                    <input type="number" min="1" max="50" defaultValue={String(overlayCfg.protectedTurns ?? 2)} onBlur={numberCommit('protectedTurns', 2)} />
                  </label>
                </div>
                <label
                  style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
                  title="Auto detects the rules from the task model: Claude -> Anthropic rules (writes 1.25x, hits 0.1x), GPT/o-models -> OpenAI rules (cached input 0.5x)."
                >
                  Cache profile (prompt-cache friendly mode)
                  <select
                    value={overlayCache.profile ?? 'off'}
                    onChange={(e) => patchOverlay({ cache: { ...overlayCache, profile: e.target.value } })}
                  >
                    <option value="off">Off - plain behavior</option>
                    <option value="auto">Auto - detect from task model (recommended)</option>
                    <option value="anthropic">Anthropic - Claude models</option>
                    <option value="openai">OpenAI - GPT/o-models</option>
                  </select>
                </label>
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                  title="On a real budget overrun, ONE deliberate rewrite of sent history (cache lost once) instead of shipping an over-budget context."
                >
                  <input
                    type="checkbox"
                    checked={overlayCache.escapeHatch ?? true}
                    onChange={(e) => patchOverlay({ cache: { ...overlayCache, escapeHatch: e.target.checked } })}
                  />
                  Escape hatch on budget overruns
                </label>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                  <button type="button" onClick={() => setOverlayOpen(false)} style={{ padding: '4px 10px' }}>
                    Cancel
                  </button>
                  <button type="button" onClick={() => void saveOverlay()} disabled={saving} style={{ padding: '4px 10px' }}>
                    {saving ? 'saving…' : 'Save'}
                  </button>
                </div>
                <div style={{ opacity: 0.6, fontSize: 11 }}>Full config: AiderDesk settings → Extensions → broke, or /broke help.</div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
