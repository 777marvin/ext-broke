// Assembled inside StatusBadge's function: use the existing config/setup/command owners.
const cpOriginal = React.useRef(null as any);
const [cpView, cpSetView] = React.useState('control');
const [cpDiscard, cpSetDiscard] = React.useState(false);
const cpDiscardOrigin = React.useRef(null as HTMLElement | null);
const cpKeepRef = React.useRef(null as HTMLButtonElement | null);
const cpTabs = React.useRef([] as HTMLButtonElement[]);
const [cpReplay, cpSetReplay] = React.useState(false);
const cpReplayTimer = React.useRef(null as ReturnType<typeof setTimeout> | null);
const [cpQuery, cpSetQuery] = React.useState({ scope: 'task', page: 0 });
const [cpStats, cpSetStats] = React.useState(null as any);
const [cpStatsLoading, cpSetStatsLoading] = React.useState(false);
const [cpStatsError, cpSetStatsError] = React.useState('');
const [cpUnits, cpSetUnits] = React.useState('tokens');
const [cpChart, cpSetChart] = React.useState('step');
const [cpPass, cpSetPass] = React.useState('truncate');
const [cpRunSelection, cpSetRunSelection] = React.useState('');
const cpRequest = React.useRef(0);
const cpFlight = React.useRef(null as { key: string; request: number } | null);
const cpDataKey = React.useRef('');
const cpAction = React.useRef(executeExtensionAction);
cpAction.current = executeExtensionAction;
const cpDirty = !!overlayCfg && !!cpOriginal.current && JSON.stringify(overlayCfg) !== JSON.stringify(cpOriginal.current);
const cpFormat = (value) => Math.round(value).toLocaleString('en-US');
const cpConvert = (value) => cpUnits === 'tokens' ? Math.round(value / 4) : value;
const cpUnitName = cpUnits === 'tokens' ? 'estimated tokens' : 'characters';
const cpPasses = [
  { key: 'structural', label: 'Clean', color: '#5477ed', description: 'Empty and repeated content removed by structural cleanup.' },
  { key: 'error', label: 'Errors & logs', color: '#398e83', description: 'Matching compiler and test output reduced by the error pass.' },
  { key: 'truncate', label: 'Trim', color: '#7b8dd5', description: 'Eligible older technical output shortened by truncation.' },
  { key: 'summarize', label: 'Summarize', color: '#9277cd', description: 'Eligible older conversation turns replaced by a summary.' },
];
const cpDepth = dialogLevel === 'summarize' ? 2 : dialogLevel === 'truncate' ? 1 : 0;
const cpModeNames = { short: 'Safe', normal: 'Balanced', long: 'Maximum savings', custom: 'Custom settings' };
const cpCloseRequest = () => {
  if (savingRef.current || executingCmd) return;
  if (cpDirty) { cpDiscardOrigin.current = document.activeElement as HTMLElement; cpSetDiscard(true); }
  else closeOverlay();
};
const cpKeepEditing = () => { cpSetDiscard(false); cpDiscardOrigin.current?.focus(); };
React.useEffect(() => { if (cpDiscard) cpKeepRef.current?.focus(); }, [cpDiscard]);
React.useEffect(() => () => { if (cpReplayTimer.current) clearTimeout(cpReplayTimer.current); }, []);
const cpPlay = () => {
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (cpReplayTimer.current) clearTimeout(cpReplayTimer.current);
  cpSetReplay(false);
  cpReplayTimer.current = setTimeout(() => { cpSetReplay(true); cpReplayTimer.current = setTimeout(() => cpSetReplay(false), 850); }, 20);
};
const cpLoadStats = React.useCallback(async () => {
  if (!overlayOpen || cpView !== 'statistics' || document.hidden) return;
  const key = `${cpQuery.scope}:${cpQuery.page}`;
  if (cpFlight.current?.key === key) return;
  const request = ++cpRequest.current;
  cpFlight.current = { key, request };
  cpSetStatsLoading(true); cpSetStatsError('');
  try {
    const result = (await cpAction.current?.('getStatistics', { ...cpQuery })) as { error?: { message?: string }; runs?: unknown[]; state?: string } | null;
    if (cpRequest.current !== request) return;
    if (result?.error) { cpSetStatsError(result.error.message || 'Recorded history could not be read.'); return; }
    if (!result || !Array.isArray(result.runs) || typeof result.state !== 'string' || !['ready', 'empty', 'partial', 'no-task'].includes(result.state)) {
      cpSetStatsError('Recorded history could not be read. Please retry.'); return;
    }
    cpDataKey.current = key; cpSetStats(result);
  } catch { if (cpRequest.current === request) cpSetStatsError('Recorded history could not be read. Please retry.'); }
  finally { if (cpRequest.current === request) { cpFlight.current = null; cpSetStatsLoading(false); } }
}, [overlayOpen, cpView, cpQuery.scope, cpQuery.page]);
React.useEffect(() => {
  cpRequest.current++; cpFlight.current = null;
  if (!overlayOpen || cpView !== 'statistics') { cpSetStatsLoading(false); return; }
  if (cpDataKey.current !== `${cpQuery.scope}:${cpQuery.page}`) { cpSetStats(null); cpSetRunSelection(''); }
  void cpLoadStats();
  const timer = setInterval(() => void cpLoadStats(), 5000);
  return () => { clearInterval(timer); cpRequest.current++; cpFlight.current = null; };
}, [overlayOpen, cpView, cpQuery.scope, cpQuery.page, cpLoadStats]);
const cpTabKey = (event, index) => {
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : event.key === 'ArrowLeft' ? (index + 1) % 2 : event.key === 'ArrowRight' ? (index + 1) % 2 : null;
  if (next !== null) { event.preventDefault(); cpSetView(next === 0 ? 'control' : 'statistics'); cpTabs.current[next]?.focus(); }
};
const cpControlView = (
  <section role="tabpanel" id="broke-control-panel" aria-labelledby="broke-control-tab" hidden={cpView !== 'control'}>
    {guideVisible ? <section className="cp-intro" aria-label="Getting started">
      <h2>Welcome to Broke</h2>
      <p>Balanced shortens older technical output without extra software. Your first request and recent turns stay protected.</p>
      <p className="cp-small" style={{ marginTop: 7 }}>Changes apply to every task only when you Save. A short conversation may show zero reduction.</p>
      <div className="cp-row" style={{ marginTop: 10, justifyContent: 'flex-start' }}>
        <button type="button" onClick={finishGuide} disabled={saving}>Got it</button>
        <button type="button" onClick={finishGuide} disabled={saving}>Skip introduction</button>
      </div>
    </section> : null}
    <div className="cp-hero"><h2>Shape what goes next.</h2><p>Choose the last included step. See the depth before applying your settings.</p></div>
    <div className="cp-status" role="status" style={{ borderColor: status.color, background: status.background }}>
      <strong style={{ color: status.color }}>{status.heading}</strong><p>{status.detail}</p>
      {dialogAutonomy === 'manual' && dialogEnabled ? <p className="cp-small" style={{ marginTop: 5 }}>Manual policy: deterministic compression can run; automatic summaries and other autonomous actions are paused.</p> : null}
    </div>
    <div className="cp-stage-layout">
      <div className={`cp-material${cpReplay ? ' cp-replaying' : ''}`} style={{ opacity: dialogEnabled ? 1 : .65 }}>
        <svg viewBox="0 0 960 328" role="img" aria-label="Context Press: an illustration of the selected compression depth, not a measured reduction">
          <path d="M120 75L565 48L815 104M120 253L565 280L815 224" fill="none" stroke="#72dbcf" strokeWidth="4" />
          <circle cx="120" cy="75" r="5" fill="#72dbcf" /><circle cx="120" cy="253" r="5" fill="#72dbcf" />
          <g className="cp-pages" style={{ transform: `scaleY(${[1,.72,.42][cpDepth]})` }}>
            {['#6c83de','#8b9fea','#a5b7ff','#c2ccff','#8499ec'].map((color, index) => <path key={color} d={`M170 ${122+index*12}L492 ${83+index*12}L696 ${145+index*12}L373 ${184+index*12}Z`} fill={color} stroke="#c3ceff" />)}
            <path d="M170 122V170L373 232V184Z" fill="#536ac3" opacity=".7" /><path d="M373 184L696 145V193L373 232Z" fill="#394f9d" opacity=".6" />
            <path d="M265 146L499 118M290 156L529 128M316 165L557 138" stroke="#e3e9ff" strokeWidth="3" opacity=".8" />
          </g>
          <path d="M739 139L847 126L897 141L789 155Z" fill="#cbd5ff" stroke="#e0e6ff" /><path d="M739 139V177L789 193V155Z" fill="#647bd7" /><path d="M789 155L897 141V179L789 193Z" fill="#8ea4ff" />
          <path d="M740 203L848 190L897 205L789 220Z" fill="none" stroke="#7084be" strokeDasharray="4 5" />
          <path d="M675 216L721 211L714 206M721 211L715 217" fill="none" stroke="#a4b5df" strokeWidth="2" />
        </svg>
        <div className="cp-visual-caption"><span>Illustration · {cpModeNames[dialogMode] ?? 'Custom settings'}</span><button type="button" className="cp-replay" onClick={cpPlay} disabled={saving || !dialogEnabled}>Replay</button></div>
      </div>
      <fieldset className="cp-depth" disabled={saving || previewing || !overlayCfg || !dialogEnabled}>
        <legend>Choose the last included step</legend>
        {[
          { mode: 'short', title: 'Clean', detail: 'Tidy empty and repeated content.' },
          { mode: 'normal', title: 'Trim', detail: 'Also shorten older technical output.' },
          { mode: 'long', title: 'Summarize', detail: 'Also summarize eligible older work.' },
        ].map((stage, index) => <label key={stage.mode} className={`cp-option${cpDepth >= index ? ' cp-included' : ''}${dialogMode === stage.mode ? ' cp-selected' : ''}`}>
          <input type="radio" name="broke-compression-depth" value={stage.mode} checked={dialogMode === stage.mode} onChange={() => void selectMode(stage.mode)} aria-label={`${stage.title} (${cpModeNames[stage.mode]})`} />
          <strong>{stage.title}</strong><p>{stage.detail}</p><small>{cpDepth >= index ? 'Included' : index === 2 ? 'Optional · needs model' : 'Not included'}</small>
        </label>)}
      </fieldset>
    </div>
    <label className="cp-enable"><input type="checkbox" checked={overlayCfg?.enabled ?? true} disabled={saving || !overlayCfg} onChange={e => patchOverlay({ enabled: e.target.checked })} />Enable Broke</label>
    <div className="cp-selection"><strong>{cpModeNames[dialogMode] ?? 'Custom settings'}{dialogMode === 'normal' ? ' · recommended' : ''}</strong>
      <p>{dialogMode === 'custom' ? 'Your individually adjusted settings are kept. Choosing a stage explicitly applies its preset.' : cpDepth === 0 ? 'Clean only. Text is retained; message framing may change.' : cpDepth === 1 ? 'Clean + Trim. No extra software needed.' : 'Clean + Trim + Summarize. A configured model is required.'}</p>
      {dialogMode === 'custom' ? <button type="button" onClick={() => setAdvancedOpen(true)} style={{ marginTop: 8 }}>Inspect custom settings</button> : null}
    </div>
    {dialogEnabled && dialogLevel === 'summarize' ? <div className="cp-alert"><strong>Summaries use your configured model</strong>
      <p>Local Ollama or a configured cloud model is required. Cloud summaries can cost money and send older conversation content to that provider.</p>
      {(localSummaryNeedsSetup || localSummaryUnconfirmed) ? <button type="button" onClick={() => void selectMode('normal')} disabled={saving || previewing} style={{ marginTop: 8 }}>Choose Balanced</button> : null}
    </div> : null}
    <p className="cp-safe-note">Your first request and recent turns stay protected. The default pipeline leaves stored task history unchanged.</p>
    <div className="cp-row" style={{ marginTop: 13, justifyContent: 'flex-start' }}>
      <button type="button" ref={checkButtonRef} onClick={() => void checkSetup()} aria-busy={checkingSetup} disabled={saving || previewing || checkingSetup}>Check setup</button>
      <button type="button" onClick={() => cpSetView('statistics')}>View savings</button>
      {total === 0 ? <button type="button" onClick={() => { setAdvancedOpen(true); void runQuickCommand('why'); }}>Why no savings yet?</button> : null}
    </div>
    {checkingSetup || setupReadiness ? <section className="cp-setup" role="status" aria-label="Setup readiness" aria-busy={checkingSetup}>
      <h3>{checkingSetup ? 'Checking setup...' : 'Setup readiness'}</h3>
      {checkingSetup ? <p>Checking the displayed draft. No summary will be generated.</p> : <><dl>{['basic','backend','model','automatic'].map(key => <div key={key}><dt>{setupReadiness[key].heading}</dt><dd>{setupReadiness[key].detail}</dd></div>)}</dl><p className="cp-small">These metadata checks do not prove model quality, speed or billing savings. Save applies changes.</p></>}
    </section> : null}
  </section>
);

const cpRows = cpStats?.runs ?? [];
const cpSummary = cpStats?.summary;
const cpRunId = run => `${run.at}:${run.charsBefore}:${run.charsAfter}`;
const cpSelectedRun = cpRows.find(run => cpRunId(run) === cpRunSelection) ?? cpRows[cpRows.length - 1];
const cpMaxPass = Math.max(1, ...cpPasses.map(pass => Math.abs(cpSummary?.passChars?.[pass.key] ?? 0)));
const cpMaxRun = Math.max(1, ...cpRows.map(run => Math.abs(run.netChars)));
const cpStatisticsView = (
  <section role="tabpanel" id="broke-statistics-panel" aria-labelledby="broke-statistics-tab" hidden={cpView !== 'statistics'} aria-busy={cpStatsLoading}>
    <div className="cp-row"><div className="cp-hero"><h2>Every step, accounted for.</h2><p>Recorded context reduction. Estimated tokens stay labeled.</p></div>
      <label className="cp-filter">Recorded runs<select aria-label="Statistics scope" value={cpQuery.scope} onChange={event => cpSetQuery({ scope: event.target.value, page: 0 })}><option value="task">This task</option><option value="retained">Retained history</option></select></label>
    </div>
    {cpStatsError ? <div className="cp-error" role="alert" data-stale={!!cpStats} style={{ marginTop: 15 }}><strong>{cpStats ? 'Showing previous measurements. ' : ''}</strong>{cpStatsError}<button type="button" onClick={() => void cpLoadStats()} disabled={cpStatsLoading} style={{ marginLeft: 9 }}>Retry</button></div> : null}
    {cpStatsLoading && !cpStats ? <p role="status" className="cp-small" style={{ marginTop: 14 }}>Loading recorded history...</p> : null}
    {cpStats?.state === 'no-task' ? <div className="cp-detail" role="status"><strong>No task is open</strong>Select Retained history explicitly to inspect the installation's recorded runs.</div> : null}
    {cpStats && cpStats.state !== 'no-task' && !cpSummary ? <div className="cp-detail" role="status"><strong>No runs recorded yet</strong>{cpStats.recordingEnabled ? 'Future compression runs will add measurements. Earlier missing records cannot be reconstructed.' : 'History recording is off. Enable Record run history below and Save to record future runs.'}</div> : null}
    {cpSummary ? <>
      <div className="cp-stat-top"><div><p className="cp-unit-label">Net reduction · {cpUnits === 'tokens' ? 'Estimated tokens' : 'Measured characters'}</p><strong className="cp-number">{cpFormat(cpConvert(cpSummary.netChars))}</strong><p className="cp-small">{cpSummary.netChars < 0 ? 'Net added context' : 'Net context removed'} across {cpSummary.runs} recorded runs.</p></div>
        <div className="cp-small"><p>{cpFormat(cpSummary.charsBefore)} characters before</p><p>{cpFormat(cpSummary.charsAfter)} characters after</p><p style={{ marginTop: 5 }}>Summed over individual calls, including repeated material.</p></div>
      </div>
      <div className="cp-toolbar"><div className="cp-toggles" role="group" aria-label="Statistics diagram"><button type="button" aria-pressed={cpChart === 'step'} onClick={() => cpSetChart('step')}>By step</button><button type="button" aria-pressed={cpChart === 'time'} onClick={() => cpSetChart('time')}>Over time</button></div>
        <div className="cp-toggles" role="group" aria-label="Statistics units"><button type="button" aria-pressed={cpUnits === 'tokens'} onClick={() => cpSetUnits('tokens')}>Estimated tokens</button><button type="button" aria-pressed={cpUnits === 'chars'} onClick={() => cpSetUnits('chars')}>Characters</button></div>
      </div>
      {cpChart === 'step' ? <>
        <p className="cp-chart-note">Per-step contributions can overlap. The net total is measured before minus after.</p>
        {cpPasses.map(pass => <button type="button" key={pass.key} className="cp-bar" aria-pressed={cpPass === pass.key} onClick={() => cpSetPass(pass.key)} aria-label={`${pass.label}: ${cpFormat(cpConvert(cpSummary.passChars[pass.key]))} ${cpUnitName}${cpStats.unknownPassRecords ? ', known contributions only' : ''}`}>
          <span>{pass.label}</span><span className="cp-bar-track" aria-hidden="true"><span className="cp-bar-fill" style={{ width: `${Math.abs(cpSummary.passChars[pass.key]) / cpMaxPass * 100}%`, background: pass.color }} /></span><span className="cp-value">{cpFormat(cpConvert(cpSummary.passChars[pass.key]))}</span>
        </button>)}
        <div className="cp-net-row"><span>Net reconciliation<br /><small className="cp-small">Overlap and marker overhead; not an additional saving.</small></span><span className="cp-value">{cpSummary.reconciliationChars == null ? 'Unavailable' : cpFormat(cpConvert(cpSummary.reconciliationChars))}</span></div>
        <div className="cp-detail" role="status"><strong>{cpPasses.find(pass => pass.key === cpPass)?.label}</strong>{cpPasses.find(pass => pass.key === cpPass)?.description}</div>
        <details className="cp-disclosure"><summary>Contribution table</summary><table className="cp-table"><caption>Known contributions in {cpUnitName}; not additive shares.</caption><thead><tr><th scope="col">Step</th><th scope="col">Contribution</th></tr></thead><tbody>{cpPasses.map(pass => <tr key={pass.key}><th scope="row">{pass.label}</th><td>{cpFormat(cpConvert(cpSummary.passChars[pass.key]))}</td></tr>)}</tbody></table></details>
      </> : <>
        <p className="cp-chart-note">Each bar is a recorded run. Positive removes context; negative adds context.</p>
        <div className="cp-chart-scroll"><div className="cp-timeline" role="group" aria-label="Recorded runs">
          {cpRows.map((run, index) => { const height = Math.abs(run.netChars) / cpMaxRun * 61; const occurrence = cpRows.slice(0,index).filter(other => cpRunId(other) === cpRunId(run)).length; return <button type="button" key={`${cpRunId(run)}:${occurrence}`} className="cp-run" data-net-chars={run.netChars} aria-pressed={cpSelectedRun === run} aria-label={`${new Date(run.at).toLocaleString('en-US')}: ${cpFormat(cpConvert(Math.abs(run.netChars)))} ${cpUnitName} ${run.netChars < 0 ? 'added' : 'removed'}`} onClick={() => cpSetRunSelection(cpRunId(run))}>
            <span className="cp-run-canvas" aria-hidden="true"><span className="cp-zero" /><span className="cp-run-bar" style={{ height, top: run.netChars >= 0 ? 65-height : 65, background: run.netChars < 0 ? '#a34136' : '#3456ec' }} /></span><span className="cp-run-index">{index + 1}</span>
          </button>; })}
        </div></div>
        {cpSelectedRun ? <div className="cp-detail" role="status"><strong>{new Date(cpSelectedRun.at).toLocaleString('en-US')} · {cpFormat(cpConvert(Math.abs(cpSelectedRun.netChars)))} {cpUnitName} {cpSelectedRun.netChars < 0 ? 'added' : 'removed'}</strong><p>{cpFormat(cpSelectedRun.charsBefore)} → {cpFormat(cpSelectedRun.charsAfter)} characters.</p><p>{cpPasses.map(pass => `${pass.label}: ${cpSelectedRun.passChars[pass.key] == null ? 'Unavailable' : cpFormat(cpConvert(cpSelectedRun.passChars[pass.key]))}`).join(' · ')}</p><p>Net reconciliation: {cpSelectedRun.reconciliationChars == null ? 'Unavailable' : cpFormat(cpConvert(cpSelectedRun.reconciliationChars))}</p></div> : null}
        <div className="cp-row" style={{ marginTop: 12 }}><p className="cp-small">Showing {cpStats.totalRuns ? Math.max(1, cpStats.totalRuns - (cpStats.page+1)*60+1) : 0}–{Math.max(0, cpStats.totalRuns-cpStats.page*60)} of {cpStats.totalRuns} runs</p><div className="cp-toggles"><button type="button" disabled={cpStatsLoading || (cpStats.page+1)*60 >= cpStats.totalRuns} onClick={() => cpSetQuery({ ...cpQuery, page: cpStats.page+1 })}>Older</button><button type="button" disabled={cpStatsLoading || cpStats.page === 0} onClick={() => cpSetQuery({ ...cpQuery, page: cpStats.page-1 })}>Newer</button></div></div>
      </>}
    </> : null}
    {cpStats?.state === 'partial' || cpStats?.skippedRecords || cpStats?.unknownPassRecords ? <p className="cp-chart-note" role="status">Partial data: {cpStats.skippedRecords} malformed records skipped; {cpStats.unknownPassRecords} records have incomplete step counters. Known contributions are partial; unavailable values are not measured zero.</p> : null}
    {cpStats?.unattributedRecords ? <p className="cp-chart-note" role="status">{cpStats.unattributedRecords} ledger {cpStats.unattributedRecords === 1 ? 'line' : 'lines'} could not be attributed to a task{cpQuery.scope === 'task' ? ' and are excluded from this task' : ' and are already counted in the skipped records above'}.</p> : null}
    <div className="cp-row" style={{ marginTop: 18, paddingTop: 13, borderTop: '1px solid #d7ddf1' }}><div><strong style={{ fontSize: 13 }}>Keep a run history</strong><p className="cp-small">Future measurements only. Turning this off keeps recorded history.</p></div><label className="cp-record"><input type="checkbox" checked={overlayCfg?.stats?.measure ?? true} disabled={saving || !overlayCfg} onChange={event => patchOverlay({ stats: { ...(draftRef.current?.stats ?? {}), measure: event.target.checked } })} />Record run history</label></div>
    <details className="cp-disclosure"><summary>Provider usage &amp; avoided context</summary>
      {cpQuery.scope !== 'task' ? <p className="cp-chart-note">These additional counters are task-specific. Select This task to inspect them; they are not summed across retained history.</p> : <>
        <p className="cp-chart-note">Last available completed call — separate usage, not the selected run's saving.</p>
        <table className="cp-table"><caption>Additional task counters, excluded from net reduction</caption><tbody>
          <tr><th scope="row">Provider-reported sent tokens</th><td>{cpStats?.taskExtras?.providerUsage ? cpFormat(cpStats.taskExtras.providerUsage.sentTokens) : 'Unavailable'}</td></tr>
          <tr><th scope="row">Cache-read tokens</th><td>{cpStats?.taskExtras?.providerUsage?.cacheReadTokens == null ? 'Unavailable' : cpFormat(cpStats.taskExtras.providerUsage.cacheReadTokens)}</td></tr>
          <tr><th scope="row">Cache-written tokens</th><td>{cpStats?.taskExtras?.providerUsage?.cacheWriteTokens == null ? 'Unavailable' : cpFormat(cpStats.taskExtras.providerUsage.cacheWriteTokens)}</td></tr>
          {['slice','search','flush'].map(key => <tr key={key}><th scope="row">Avoided context · {key} (estimate)</th><td>{cpStats?.taskExtras?.avoidedChars?.[key] == null ? 'Unavailable' : `${cpFormat(cpConvert(cpStats.taskExtras.avoidedChars[key]))} ${cpUnitName}`}</td></tr>)}
        </tbody></table>
      </>}
    </details>
    <p className="cp-chart-note">Token estimates use characters ÷ 4, rounded. Retained history is rotation-bounded, not unlimited all-time history. Neither these measurements nor provider usage proves a billing reduction. Changing a preset does not rewrite history.</p>
  </section>
);
