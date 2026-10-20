import type { ContextMessage } from '@aiderdesk/extensions';

/**
 * The Anthropic prompt-cache breakpoint marker (shape from the bundled
 * provider docs, verified against the installed AiderDesk v0.88 bundle):
 * `providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }`.
 * Anthropic requires a minimum of 1024 tokens before the checkpoint; below
 * that the marker is simply ignored by the provider again.
 */
export const ANTHROPIC_BREAKPOINT: Record<string, Record<string, unknown>> = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
};

/**
 * Put ONE provider cache breakpoint on the message at `anchorIndex`, MERGING
 * into any `providerOptions` already present (the host's default cache
 * annotation and other extensions write their own - never replace or drop
 * them). Returns a NEW array with only the touched element shallow-copied;
 * the input array and its elements are never mutated. A non-actionable
 * anchor (`< 0` or `>= messages.length`) returns the input array unchanged.
 */
export function anchorBreakpoint(
  messages: ContextMessage[],
  anchorIndex: number,
  options: Record<string, Record<string, unknown>>,
): ContextMessage[] {
  if (!Array.isArray(messages) || !Number.isInteger(anchorIndex) || anchorIndex < 0 || anchorIndex >= messages.length) {
    return messages;
  }
  const target = messages[anchorIndex] as { providerOptions?: Record<string, Record<string, unknown>> } | undefined;
  if (!target || typeof target !== 'object') return messages;

  const merged: Record<string, Record<string, unknown>> = {};
  const existing = target.providerOptions;
  if (existing && typeof existing === 'object') {
    for (const key of Object.keys(existing)) merged[key] = { ...existing[key] };
  }
  for (const key of Object.keys(options)) {
    const previous = merged[key] ?? {};
    const next: Record<string, unknown> = { ...previous };
    for (const sub of Object.keys(options[key])) {
      const a = previous[sub];
      const b = options[key][sub];
      // Merge ONE nested level too: another cache-controlling extension may
      // have set `anthropic.cacheControl = { type: 'ephemeral', ttl: '1h' }`,
      // and a shallow replace would silently drop `ttl`.
      next[sub] =
        a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)
          ? { ...(a as Record<string, unknown>), ...(b as Record<string, unknown>) }
          : b;
    }
    merged[key] = next;
  }

  const next = messages.slice();
  next[anchorIndex] = { ...target, providerOptions: merged } as ContextMessage;
  return next;
}
