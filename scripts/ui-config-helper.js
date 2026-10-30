// Injected synchronously into both standalone host templates by composeUiTemplate.
const mergeConfigDraft = (base, latest, next) => {
  const merge = (original, current, candidate) => {
    const result = { ...current };
    for (const key of Object.keys(original ?? {})) {
      if (!(key in candidate)) {
        delete result[key];
      }
    }
    for (const key of Object.keys(candidate)) {
      const value = candidate[key];
      if (value === original?.[key]) continue;
      let changed = value;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        changed = merge(original?.[key] ?? {}, current?.[key] ?? {}, value);
      }
      // Configuration records may contain arbitrary tool names; keep them data.
      Object.defineProperty(result, key, { value: changed, enumerable: true, configurable: true, writable: true });
    }
    return result;
  };
  const result = merge(base, latest, next);
  const owned = [['level'], ['maxContextChars'], ['protectedTurns'], ['truncate', 'maxLines'], ['truncate', 'maxKB'], ['summarize', 'afterTurns'], ['brevity', 'level']];
  const at = (object, path) => path.reduce((value, key) => value?.[key], object);
  return owned.some((path) => at(result, path) !== at(latest, path)) ? { ...result, mode: 'custom' } : result;
};

// Shared command-safety classification, injected into both UI templates.
// Boundary decision (2026-10-30): the badge/deck may now run EVERY valid
// /broke subcommand. The only server-side guard is the unknown/invalid-arg
// rejection in executeUIExtensionAction('runCommand'). The read-only split
// below is a two-step CONFIRMATION hint only - client-side UX, not a
// security boundary.
const brokeReadonlyCommands = new Set([
  'status',
  'stats',
  'why',
  'estimate',
  'measure',
  'selftest',
  'help',
  'index status',
  'slice status',
  'snapshot list',
  'config list',
  'update check',
]);
const brokeCommandIsMutating = (raw) => {
  const cmd = String(raw ?? '').trim().replace(/^\/?broke\b\s*/i, '');
  if (!cmd) return true;
  if (brokeReadonlyCommands.has(cmd)) return false;
  if (cmd.startsWith('diff')) return false;
  if (cmd.startsWith('snapshot show ')) return false;
  if (cmd.startsWith('config get ')) return false;
  if (cmd === 'search on' || cmd === 'search off') return true;
  if (cmd.startsWith('search ')) return false;
  return true;
};
