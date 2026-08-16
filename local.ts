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
 * for minutes - 60 s is long enough for an 800-token local generation and
 * still short enough to fail fast.
 */
const REQUEST_TIMEOUT_MS = 60_000;
/** Status checks must never block task init or commands - short timeout. */
const STATUS_TIMEOUT_MS = 3_000;

/**
 * Fetch JSON from the Ollama API. The timeout covers the WHOLE request:
 * fetch() resolves as soon as the response headers arrive, so reading the
 * body outside the abort window could hang forever on a server that sends
 * headers and then stalls (exactly what the "hung Ollama must not stall
 * the task" rule forbids). Non-ok responses throw with the status and a
 * snippet of the error body.
 */
async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && err.name === 'AbortError') return `timeout after ${timeoutMs} ms`;
  return err instanceof Error ? err.message : String(err);
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
    // An HTTP error throws here (requestJson) - the server answered but is
    // NOT usable for summarization, so it must not count as reachable.
    const body = await requestJson<{ models?: { name?: string }[] }>(baseUrl, '/api/tags', undefined, timeoutMs);
    return {
      reachable: true,
      models: (body.models ?? []).map((m) => m.name ?? '').filter(Boolean),
    };
  } catch (err) {
    return {
      reachable: false,
      models: [],
      error: errorMessage(err, timeoutMs),
    };
  }
}

/**
 * Generate text with a local Ollama model. Non-streaming; fails loudly with
 * a descriptive error so callers can fall back gracefully. The timeout
 * covers headers AND body, so a stalled response fails fast instead of
 * blocking the model call that waits for this summarization.
 */
export async function ollamaGenerate(
  baseUrl: string,
  model: string,
  prompt: string,
  maxTokens = 1024,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<OllamaGenerateResult> {
  try {
    const body = await requestJson<{ response?: string; total_duration?: number; error?: string }>(
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
      timeoutMs,
    );
    if (body.error) {
      return { ok: false, error: body.error };
    }
    if (!body.response) {
      return { ok: false, error: 'Ollama returned an empty response' };
    }
    return { ok: true, text: body.response, durationMs: body.total_duration ? Math.round(body.total_duration / 1e6) : undefined };
  } catch (err) {
    // Keep the established message shapes ("Ollama HTTP n: ...", plain
    // body errors); only the abort case gets a dedicated timeout message.
    const message = errorMessage(err, timeoutMs);
    return { ok: false, error: message.startsWith('HTTP ') || message.startsWith('timeout after ') ? `Ollama ${message}` : message };
  }
}
