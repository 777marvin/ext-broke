/** Project-index lifecycle and presentation, independent of task/host state. */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config';
import { boundedMapSet } from './compress';
import { ensureFresh, estimateBulkReadAvoided, formatSearchFooter, indexDirFor, loadIndex, projectHash, resolveSearchOptions, runSearch, type IndexState } from './indexer';

type SearchConfig = Config['search'];
type SearchInput = { query: string; k?: number; files?: string[] };
const REFRESH_TTL_MS = 60000;
const FOOTER_RESERVE_CHARS = 256;

export class IndexCoordinator {
  private readonly projects = new Map<string, { state: IndexState; at: number }>();

  search(root: string, config: SearchConfig, input: SearchInput): { text: string; avoided: number } {
    const receipt = (text: string, avoided = 0) => ({ text, avoided });
    if (!config.enabled) return receipt('broke-search is disabled (/broke help for config paths)');
    if (!root) return receipt('broke-search: no open project - indexing is project-scoped');
    try {
      const fresh = ensureFresh(root, { maxFileKB: config.maxFileKB, includeGitIgnored: config.includeGitIgnored, ttlMs: REFRESH_TTL_MS, deadlineMs: config.scanBudgetMs });
      boundedMapSet(this.projects, projectHash(root), { state: fresh.state, at: Date.now() });
      const resolved = resolveSearchOptions(config);
      const effective = { ...resolved.options, k: input.k ?? resolved.options.k, footerReserve: FOOTER_RESERVE_CHARS };
      const result = runSearch(fresh.state, root, input.query, effective, input.files);
      const stamp = Date.parse(fresh.state.scannedAt || fresh.state.builtAt);
      const age = Number.isFinite(stamp) ? Math.max(0, Date.now() - stamp) : 0;
      const footer = formatSearchFooter(result.hits.length, Object.keys(fresh.state.files).length, effective, age)
        + (result.truncated ? ' | INDEX TRUNCATED at cap' : '');
      if (!result.hits.length) return receipt(`no matches for "${input.query}"\n${footer}`);
      return receipt(`${result.hits.map((hit) => hit.text).join('\n\n')}\n\n${footer}`, Math.max(0, estimateBulkReadAvoided(result.hits, fresh.state.files)));
    } catch (error) { return receipt(`broke-search failed - ${error instanceof Error ? error.message : String(error)} - the agent loop was not affected`); }
  }

  rebuild(root: string, config: SearchConfig): string {
    if (!config.enabled) return 'broke: search is disabled - nothing to build';
    if (!root) return 'broke: no open project - indexing is project-scoped';
    try {
      const { state, delta } = ensureFresh(root, { maxFileKB: config.maxFileKB, includeGitIgnored: config.includeGitIgnored, deadlineMs: config.scanBudgetMs, rebuild: true });
      boundedMapSet(this.projects, projectHash(root), { state, at: Date.now() });
      return `broke: index rebuilt - ${Object.keys(state.files).length.toLocaleString('en-US')} file(s), `
        + `${Object.keys(state.postings).length.toLocaleString('en-US')} term(s), `
        + `(+${delta.added} new/0 unchanged/-${delta.removed})`
        + (state.truncated ? ' [TRUNCATED: scan incomplete; previous entries preserved]' : '');
    } catch (error) { return `broke: index rebuild failed - ${error instanceof Error ? error.message : String(error)}`; }
  }

  status(root: string, config: SearchConfig): string {
    if (!config.enabled) return 'broke: local search disabled (search.enabled=false)';
    if (!root) return 'broke: no open project - nothing indexed';
    const state = this.projects.get(projectHash(root))?.state ?? loadIndex(indexDirFor(root));
    if (!state) return 'broke: no index yet on disk - run "/broke index" to build one';
    let bytes = 0;
    try { bytes = statSync(join(indexDirFor(root), 'index.json')).size; } catch { /* missing persisted index */ }
    const builtMs = Date.parse(state.builtAt);
    const age = Number.isFinite(builtMs) && builtMs > 0 ? Math.max(1, Math.round((Date.now() - builtMs) / 1000)) : null;
    return [
      `broke index status: backend ${config.backend} | top-k ${config.maxResults} | budget ${config.maxChars.toLocaleString('en-US')} chars/context ±${config.contextLines} line(s)`,
      `files: ${Object.keys(state.files).length.toLocaleString('en-US')} | terms: ${Object.keys(state.postings).length.toLocaleString('en-US')} | index.json: ${(bytes / 1024).toFixed(1)} KB`,
      `built: ${state.builtAt || '(unknown)'}${age !== null ? ` (${age}s ago)` : ''}${state.truncated ? ' | TRUNCATED' : ''}`,
      `location: ${indexDirFor(root)}`,
    ].join('\n');
  }

  refresh(root: string, config: SearchConfig): void {
    if (!config.enabled || !root) return;
    try {
      const hash = projectHash(root);
      const cached = this.projects.get(hash);
      if (cached && Date.now() - cached.at < REFRESH_TTL_MS) return;
      const fresh = ensureFresh(root, { maxFileKB: config.maxFileKB, includeGitIgnored: config.includeGitIgnored, deadlineMs: config.scanBudgetMs });
      boundedMapSet(this.projects, hash, { state: fresh.state, at: Date.now() });
    } catch { /* never propagate a background refresh into the commit hook */ }
  }
}
