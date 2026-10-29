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
