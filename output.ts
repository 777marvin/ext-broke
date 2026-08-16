/**
 * Canonical tool-output text extraction. Every place in broke that needs
 * the string payload of a tool output goes through here (or through
 * partText), so shape handling cannot drift between passes again - F2
 * originated from exactly that kind of drift (a guard present in one
 * extractor path but missing from the others).
 */

export interface ExtractedOutput {
  /** Error-relevant text: the plain payload, or stdout+stderr of a structured payload. */
  text: string;
  /**
   * Rebuild the output with `replacement` in place of the original text.
   * Plain payloads become the replacement string; structured payloads keep
   * their shape (exitCode etc.) with stdout replaced and stderr emptied.
   */
  wrap: (replacement: string) => unknown;
}

export interface ExtractOutputOptions {
  /**
   * True when `output` is a raw event output: a string, an object with a
   * content[] array, or an object with stdout/stderr at the top level.
   * False (default) when it is a single tool-result output part in the
   * { type, value } shape.
   */
  eventOutput?: boolean;
  /**
   * Fall back to JSON.stringify for structured payloads that carry no
   * stdout/stderr text. Read-only accounting mode (size counting, dedupe,
   * summarizer input): the wrap in this mode is never round-trip safe and
   * callers must not rewrite with it.
   */
  serializeJson?: boolean;
}

/**
 * Extract error-relevant text from a tool output, covering the plain
 * `text`/`error-text` payloads, the structured `json`/`content` payloads
 * that command tools (power---bash etc.) produce as `{ stdout, stderr,
 * exitCode }`, and the raw event-output shapes (string, content[] text
 * arrays, top-level stdout/stderr). Returns null when the output carries
 * no string payload worth inspecting - callers pass those through
 * untouched.
 */
export function extractOutputText(output: unknown, opts: ExtractOutputOptions = {}): ExtractedOutput | null {
  const { eventOutput = false, serializeJson = false } = opts;

  if (eventOutput) {
    if (typeof output === 'string') {
      return { text: output, wrap: (t) => t };
    }
    if (output && typeof output === 'object') {
      const record = output as Record<string, unknown>;
      // content[] shape: extract only when ALL parts are text parts. A
      // mixed array (text + image) must not be rewritten as text.
      const content = record.content;
      if (Array.isArray(content) && content.length > 0) {
        const texts: string[] = [];
        let allText = true;
        for (const part of content) {
          if (
            !!part &&
            typeof part === 'object' &&
            (part as { type?: unknown }).type === 'text' &&
            typeof (part as { text?: unknown }).text === 'string'
          ) {
            texts.push((part as { text: string }).text);
          } else {
            allText = false;
            break;
          }
        }
        if (allText) {
          const text = texts.join('\n');
          return {
            text,
            wrap: (t) => ({ ...(output as object), content: [{ type: 'text', text: t }] }),
          };
        }
      }
      // Structured command output: { stdout, stderr, exitCode }.
      const stdout = typeof record.stdout === 'string' ? record.stdout : '';
      const stderr = typeof record.stderr === 'string' ? record.stderr : '';
      if (stdout || stderr) {
        const text = stderr ? `${stdout}\n${stderr}` : stdout;
        return {
          text,
          wrap: (t) => ({ ...record, stdout: t, stderr: '' }),
        };
      }
      if (serializeJson) {
        try {
          return { text: JSON.stringify(output), wrap: (t) => t };
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  // Part shape: { type, value }.
  if (!output || typeof output !== 'object') return null;
  const part = output as { type?: string; value?: unknown };
  if (part.type === 'text' || part.type === 'error-text') {
    if (typeof part.value !== 'string') return null;
    return { text: part.value, wrap: (t) => ({ ...(output as object), value: t }) };
  }
  const jsonLike = part.type === 'json' || part.type === 'content';
  const errorJson = part.type === 'error-json';
  if (jsonLike || errorJson) {
    if (!serializeJson && jsonLike) {
      const value = part.value as { stdout?: unknown; stderr?: unknown } | null | undefined;
      if (!value || typeof value !== 'object') return null;
      const stdout = typeof value.stdout === 'string' ? value.stdout : '';
      const stderr = typeof value.stderr === 'string' ? value.stderr : '';
      if (!stdout && !stderr) return null;
      return {
        text: stderr ? `${stdout}\n${stderr}` : stdout,
        wrap: (t) => ({ ...(output as object), value: { ...value, stdout: t, stderr: '' } }),
      };
    }
    // error-json is not rewritten by the error pass today (pre-consolidation
    // behavior); it only participates in the serializeJson accounting mode.
    if (!serializeJson) return null;
    try {
      return { text: JSON.stringify(part.value), wrap: (t) => ({ ...(output as object), value: t }) };
    } catch {
      return null;
    }
  }
  return null;
}

/** Extract the text payload of a message part (text / tool-result / tool-call). */
export function partText(part: { type: string; [key: string]: unknown }): string {
  if (part.type === 'text') {
    return typeof part.text === 'string' ? part.text : '';
  }
  if (part.type === 'tool-result') {
    const extracted = extractOutputText(part.output as { type?: string; value?: unknown } | undefined, {
      serializeJson: true,
    });
    return extracted ? extracted.text : '';
  }
  if (part.type === 'tool-call') {
    try {
      return JSON.stringify(part.input);
    } catch {
      return '';
    }
  }
  return '';
}
