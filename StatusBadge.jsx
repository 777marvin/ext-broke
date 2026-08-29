({ data, executeExtensionAction }) => {
  // Polling fallback: re-fetches the data every 10s even if a push event
  // (triggerUIDataRefresh after a compression run) was missed by the
  // renderer - same pattern as the ext-savemytoken badge.
  React.useEffect(() => {
    const p = setInterval(() => {
      executeExtensionAction?.('refresh').catch?.(() => {});
    }, 10000);
    return () => clearInterval(p);
  }, []);

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
    </div>
  );
}
