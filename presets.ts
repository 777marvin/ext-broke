export type BrevityLevel = 'off' | 'lite' | 'full' | 'ultra';

/** Canonical F5 bundles. JSX obtains these through extension actions, never copies them. */
export const MODE_PRESETS = {
  short: { level: 'structural', maxContextChars: 60000, protectedTurns: 2, truncate: { maxLines: 200, maxKB: 20 }, summarize: { afterTurns: 8 }, brevity: { level: 'off' } },
  normal: { level: 'truncate', maxContextChars: 60000, protectedTurns: 2, truncate: { maxLines: 200, maxKB: 20 }, summarize: { afterTurns: 8 }, brevity: { level: 'lite' } },
  long: { level: 'summarize', maxContextChars: 60000, protectedTurns: 2, truncate: { maxLines: 120, maxKB: 12 }, summarize: { afterTurns: 4 }, brevity: { level: 'full' } },
} as const;

export type Mode = keyof typeof MODE_PRESETS | 'custom';

interface PresetConfig {
  mode: Mode;
  level: 'structural' | 'truncate' | 'summarize';
  maxContextChars: number;
  protectedTurns: number;
  truncate: { maxLines: number; maxKB: number };
  summarize: { afterTurns: number };
  brevity: { level: BrevityLevel };
}

/** Apply once. Never change master enablement, backend, cache or consent settings. */
export function applyPreset<T extends PresetConfig>(config: T, mode: Mode): T {
  if (mode === 'custom') return { ...config, mode };
  const preset = MODE_PRESETS[mode];
  return {
    ...config, ...preset, mode,
    truncate: { ...config.truncate, ...preset.truncate },
    summarize: { ...config.summarize, ...preset.summarize },
    brevity: { ...config.brevity, ...preset.brevity },
  };
}

/** A named label must describe the actual values, including after hand edits. */
export function normalizeMode<T extends PresetConfig>(config: T): T {
  if (config.mode === 'custom') return config;
  const preset = MODE_PRESETS[config.mode];
  const matches = config.level === preset.level && config.maxContextChars === preset.maxContextChars
    && config.protectedTurns === preset.protectedTurns && config.truncate.maxLines === preset.truncate.maxLines
    && config.truncate.maxKB === preset.truncate.maxKB && config.summarize.afterTurns === preset.summarize.afterTurns
    && config.brevity.level === preset.brevity.level;
  return matches ? config : { ...config, mode: 'custom' };
}
