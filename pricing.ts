/**
 * Live cost estimation. The money side of the saved-token numbers is always
 * computed from the price of the model CURRENTLY used in the task (per user
 * requirement): the resolved task agent profile (with task-level overrides)
 * is matched against the model registry (getModelConfigs), and the model's
 * input price per token is used. Local models (Ollama) have no price -
 * savings are then honestly shown as $0.00.
 */

import type { ExtensionContext } from '@aiderdesk/extensions';

export interface TaskModelPrice {
  /** Model id as used by the task profile (e.g. 'gpt-4o'). */
  modelId: string;
  /** Provider id (e.g. 'openai', 'ollama'). */
  providerId: string;
  /**
   * USD per 1M INPUT tokens. null when the model is not in the registry or
   * carries no price (local models) - cost stays unknown, never guessed.
   */
  inputPerMToken: number | null;
}

/** Lookup cache: the registry load can be slow, prices are stable. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const priceCache = new Map<string, { at: number; price: TaskModelPrice | null }>();

function cacheKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * Resolve the price of the model currently used in the task. Never throws:
 * a price lookup must not break the badge or the stats command. Returns
 * null when no task context is available.
 */
export async function resolveTaskModelPrice(context: ExtensionContext): Promise<TaskModelPrice | null> {
  try {
    const task = context.getTaskContext();
    if (!task) return null;
    const profile = await task.getTaskAgentProfile();
    if (!profile) return null;

    const key = cacheKey(profile.provider, profile.model);
    const cached = priceCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.price;

    let price: TaskModelPrice | null = null;
    try {
      const models = await context.getModelConfigs();
      const model =
        models.find((m) => m.providerId === profile.provider && m.id === profile.model) ??
        models.find((m) => m.id === profile.model);
      price = {
        modelId: model?.id ?? profile.model,
        providerId: model?.providerId ?? profile.provider,
        inputPerMToken:
          typeof model?.inputCostPerToken === 'number' && model.inputCostPerToken > 0
            ? model.inputCostPerToken * 1_000_000
            : null,
      };
    } catch {
      price = { modelId: profile.model, providerId: profile.provider, inputPerMToken: null };
    }
    priceCache.set(key, { at: Date.now(), price });
    return price;
  } catch {
    return null;
  }
}

/** Estimated USD saved for `tokens` input tokens at the given price (0 when unknown). */
export function savedCostUsd(tokens: number, inputPerMToken: number | null): number {
  if (!inputPerMToken || !Number.isFinite(tokens) || tokens <= 0) return 0;
  return (tokens / 1_000_000) * inputPerMToken;
}

/** Compact USD formatting: $1.23, small amounts keep 4 decimals. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** 'gpt-4o' with a price, or 'local model (no price)' style label. */
export function priceLabel(price: TaskModelPrice | null): string {
  if (!price) return 'unknown model';
  const base = price.modelId === price.providerId ? price.modelId : `${price.providerId}/${price.modelId}`;
  return price.inputPerMToken === null ? `${base} (local/unknown - $0)` : `${base} @ $${price.inputPerMToken}/1M input`;
}
