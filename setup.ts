import type { Config } from './config';
import { isRemoteOllamaHost, ollamaStatus, type OllamaStatus } from './local';
import { closeSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync, fstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeDir } from './paths';

export type SetupCheck = {
  state: 'ready' | 'off' | 'manual' | 'not-needed' | 'checking' | 'unavailable' | 'blocked' | 'unknown' | 'unchecked';
  heading: string;
  detail: string;
};
export type SetupReadiness = { basic: SetupCheck; backend: SetupCheck; model: SetupCheck; automatic: SetupCheck };
export type SetupState = { version: 1; dismissed: boolean };

/** An explicit tag requires an exact match; a base name accepts any tag. */
export function hasOllamaModel(models: string[], configured: string): boolean {
  if (models.includes(configured)) return true;
  if (configured.includes(':')) return false;
  return models.some((model) => model.startsWith(`${configured}:`));
}

function check(state: SetupCheck['state'], heading: string, detail: string): SetupCheck {
  return { state, heading, detail };
}

/** Pure configuration + metadata decisions, shared by setup and status. */
export function deriveSetupReadiness(config: Config, status?: OllamaStatus | null): SetupReadiness {
  const result: SetupReadiness = {
    basic: config.enabled
      ? check('ready', 'Basic compression ready', 'Broke is enabled. Basic compression requires no extra software. Short conversations may show zero savings because there is little to reduce.')
      : check('off', 'Broke is off', 'Enable Broke to use compression. Your saved settings are preserved.'),
    backend: check('not-needed', 'No summary backend needed', 'Basic compression runs without Ollama or a cloud summary service.'),
    model: check('not-needed', 'No summary model needed', 'Basic compression does not need an installed summary model.'),
    automatic: config.enabled
      ? config.autonomy === 'manual'
        ? check('manual', 'Automatic actions are off', 'Manual automation is selected. Automatic summaries do not run; existing manual commands remain available.')
        : check('not-needed', 'Automatic summaries are not selected', 'Your current compression level does not use summaries. Automatic basic compression remains available.')
      : check('off', 'Automatic actions are off', 'Broke is disabled. Enable it before using automatic summaries.'),
  };
  if (!config.enabled || config.level !== 'summarize') return result;

  const automatic = (value: SetupCheck): SetupReadiness => {
    if (config.autonomy !== 'manual') result.automatic = value;
    return result;
  };

  if (config.summarize.via === 'cloud') {
    result.backend = check('unchecked', 'Cloud backend configured', 'The cloud backend is selected in configuration. Provider access is not checked; summaries may send conversation content and incur provider charges.');
    result.model = check('unchecked', 'Cloud generation not checked', 'The configured AiderDesk model, or the current task model when none is specified, has not been tested.');
    return automatic(check('unchecked', 'Cloud summaries configured', 'Automatic summaries are configured, but provider access and generation quality are not verified.'));
  }

  let validUrl = false;
  try {
    const url = new URL(config.summarize.ollamaUrl);
    validUrl = url.protocol === 'http:' || url.protocol === 'https:';
  } catch { /* Invalid configuration must never reach the metadata probe. */ }
  if (!validUrl || (isRemoteOllamaHost(config.summarize.ollamaUrl) && !config.summarize.allowRemoteHost)) {
    result.backend = check('blocked', 'Local backend check blocked', validUrl
      ? 'This Ollama address is on another host. Choose a local address or explicitly allow the remote host in advanced settings before checking it.'
      : 'Set a valid HTTP or HTTPS Ollama address in advanced settings, then check again.');
    result.model = check('unchecked', 'Local model not checked', 'The backend check is blocked, so its installed models have not been checked.');
    return automatic(check('blocked', 'Local summaries blocked', 'Resolve the backend setting before using automatic local summaries. Basic compression is available.'));
  }

  if (status == null) {
    const state = status === null ? 'checking' : 'unknown';
    result.backend = check(state, status === null ? 'Checking local backend' : 'Local backend not checked', status === null
      ? 'Reading Ollama model metadata. No conversation content is sent and no generation is started.'
      : 'Run Check setup to check whether the configured Ollama server is reachable.');
    result.model = check(state, status === null ? 'Checking local model' : 'Local model not checked', 'Installed-model metadata is needed to check the configured model.');
    return automatic(check(state, 'Local summaries not confirmed', 'Check the backend and configured model first. This metadata check does not test generation quality.'));
  }

  if (!status.reachable) {
    result.backend = check('unavailable', 'Local backend unavailable', 'Ollama could not be reached or its metadata check failed. Start Ollama, verify its address, then check again.');
    result.model = check('unchecked', 'Local model not checked', 'Installed models could not be read. Restore backend access, then check again.');
    return automatic(check('unavailable', 'Local summaries unavailable', 'The local backend is unavailable. Basic compression remains usable.'));
  }

  result.backend = check('ready', 'Local backend reachable', 'Ollama answered the model metadata request. Generation quality and speed have not been tested.');
  const installed = hasOllamaModel(status.models, config.summarize.localModel);
  result.model = installed
    ? check('ready', 'Configured local model installed', `Ollama lists ${config.summarize.localModel}. This confirms installation metadata, not generation quality.`)
    : check('unavailable', 'Configured local model missing', `Install ${config.summarize.localModel} in Ollama or choose an installed model in advanced settings, then check again.`);
  return automatic(installed
    ? check('ready', 'Local summaries configured', 'The backend is reachable and the configured model is installed. Automatic summaries run only when conversation thresholds are met; generation quality is not tested.')
    : check('unavailable', 'Local summaries need a model', 'The configured model is missing. Install it or select an installed model; basic compression remains usable.'));
}

/** Metadata only. Configuration gates run before any network request. */
export async function checkSetupReadiness(config: Config, probe = ollamaStatus): Promise<SetupReadiness> {
  const initial = deriveSetupReadiness(config);
  if (initial.backend.state !== 'unknown') return initial;
  try {
    return deriveSetupReadiness(config, await probe(config.summarize.ollamaUrl));
  } catch {
    return deriveSetupReadiness(config, { reachable: false, models: [] });
  }
}

const MAX_STATE_BYTES = 4096;

/** Invalid/missing state leaves the introduction available; reads are bounded. */
export function loadSetupState(filePath = join(runtimeDir(), 'setup.json')): SetupState {
  const fresh: SetupState = { version: 1, dismissed: false };
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return fresh;
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const bytes = readSync(fd, buffer, size, buffer.length - size, size);
      if (!bytes) break;
      size += bytes;
    }
    if (size > MAX_STATE_BYTES) return fresh;
    const state: unknown = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    if (state && typeof state === 'object' && 'version' in state && state.version === 1 && 'dismissed' in state && typeof state.dismissed === 'boolean') {
      return { version: 1, dismissed: state.dismissed };
    }
    return fresh;
  } catch {
    return fresh;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Separate from configuration; only a completed atomic write dismisses setup. */
export function dismissSetup(filePath = join(runtimeDir(), 'setup.json')): SetupState {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = join(dirname(filePath), `.setup-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    created = true;
    writeFileSync(fd, JSON.stringify({ version: 1, dismissed: true }) + '\n', 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, filePath);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) rmSync(temporary, { force: true });
  }
  return { version: 1, dismissed: true };
}
