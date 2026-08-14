({ data }) => {
  if (!data || !data.inTask) return null;
  const s = data.savedTokens ?? { structural: 0, truncate: 0, summarize: 0 };
  const total = data.totalSavedTokens ?? 0;
  const level = data.level ?? 'off';
  const configured = data.summarizerConfigured ?? 'none';
  const used = data.summarizerUsed ?? 'none';
  const failed = data.summarizeFailures ?? 0;
  const ollama = data.ollama ?? null;
  const cost = data.cost ?? { savedUsd: null, modelLabel: null };

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
    `saved ≈ ${total.toLocaleString()} input tokens${money} (chars/4 estimate)`,
    cost.modelLabel ? `  at current task model: ${cost.modelLabel}` : '',
    `  structural: ${(s.structural ?? 0).toLocaleString()} | truncate: ${(s.truncate ?? 0).toLocaleString()} | summarize: ${(s.summarize ?? 0).toLocaleString()}`,
    `summarizer: configured ${backendLabel} · used ${usedLabel}${usedNote}${failed > 0 ? ` - ${failed} failure(s)` : ''}`,
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
      <span>{total.toLocaleString()}</span>
      {level === 'summarize' && configured !== 'none' ? (
        <span title="summarizer backend">{configured === 'local' ? '🖥' : '☁'}{ollamaDown ? '⚠' : null}</span>
      ) : null}
    </div>
  );
}
