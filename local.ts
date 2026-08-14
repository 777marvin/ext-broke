/**
 * Minimal Ollama HTTP client. Broke talks to Ollama directly (instead of
 * registering it as an AiderDesk provider) so that local summarization is a
 * pure offload: zero cloud tokens, zero provider configuration, zero model
 * registry changes. Requires Ollama to be running (ollama serve) and the
 * configured model to be pulled.
 */

export interface OllamaStatus {
  reachable: boolean;
  version?: string;
  models: string[];
  error?: string;
}

export interface OllamaGenerateResult {
  ok: boolean;
  text?: string;
  error?: string;
  /** Generation duration in ms (server-side) when reported. */
  durationMs?: number;
}

/**
 * Generation timeout. Summarization runs INSIDE the model call (the agent
 * waits for onOptimizeMessages), so a hung Ollama must not stall the task
 * for minutes — 60 s is long enough for an 800-token local generation and
 * still short enough to fail fast.
 */
const REQUEST_TIMEOUT_MS = 60_000;
/** Status checks must never block task init or commands — short timeout. */
const STATUS_TIMEOUT_MS = 3_000;

async function request(baseUrl: string, path: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** True when the URL is plaintext HTTP to a non-loopback host. */
export function isPlaintextRemoteUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '0.0.0.0';
  } catch {
    return false;
  }
}

/** Check whether Ollama is reachable and list the available models. */
export async function ollamaStatus(baseUrl: string, timeoutMs = STATUS_TIMEOUT_MS): Promise<OllamaStatus> {
  try {
    const res = await request(baseUrl, '/api/tags', undefined, timeoutMs);
    if (!res.ok) {
      // An HTTP error means the server answered — but it is NOT usable for
      // summarization, so it must not count as reachable.
      return { reachable: false, models: [], error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { models?: { name?: string }[] };
    return {
      reachable: true,
      models: (body.models ?? []).map((m) => m.name ?? '').filter(Boolean),
    };
  } catch (err) {
    return {
      reachable: false,
      models: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Generate text with a local Ollama model. Non-streaming; fails loudly with
 * a descriptive error so callers can fall back gracefully.
 */
export async function ollamaGenerate(baseUrl: string, model: string, prompt: string, maxTokens = 1024): Promise<OllamaGenerateResult> {
  try {
    const res = await request(
      baseUrl,
      '/api/generate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          options: { num_predict: maxTokens, temperature: 0.2 },
        }),
      },
      REQUEST_TIMEOUT_MS,
    );
    if (!res.ok) {
      return { ok: false, error: `Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    }
    const body = (await res.json()) as { response?: string; total_duration?: number; error?: string };
    if (body.error) {
      return { ok: false, error: body.error };
    }
    if (!body.response) {
      return { ok: false, error: 'Ollama returned an empty response' };
    }
    return { ok: true, text: body.response, durationMs: body.total_duration ? Math.round(body.total_duration / 1e6) : undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
