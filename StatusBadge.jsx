({ data, executeExtensionAction }) => {
  // Badge settings overlay (task 7): one-click access to the core knobs.
  // The overlay reads the full config via 'getConfig' and saves through
  // 'setConfig' - the same validated path as the settings dialog (a schema
  // rejection returns ok:false and keeps the previous config, which the
  // overlay shows as an error line instead of silently "saving").
  const [overlayOpen, setOverlayOpen] = React.useState(false);
  const [overlayCfg, setOverlayCfg] = React.useState(null);
  const [overlayError, setOverlayError] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  const [guideVisible, setGuideVisible] = React.useState(false);
  const [setupReadiness, setSetupReadiness] = React.useState(null);
  const [checkingSetup, setCheckingSetup] = React.useState(false);
  const setupRequest = React.useRef(0);
  const overlaySession = React.useRef(0);
  const guideButtonRef = React.useRef(null);
  const checkButtonRef = React.useRef(null);
  const restoreCheckFocus = React.useRef(false);
  const guideRevision = React.useRef(0);
  const restoreGuideFocus = React.useRef(false);
  const [readinessMatchesSaved, setReadinessMatchesSaved] = React.useState(false);
  // Quick Commands (H1): a command that mutates state or spends an LLM
  // call is two-step - `pendingCommand` holds the armed button, the
  // second click runs it. `commandResult` shows what came back instead of
  // the old fire-and-forget `.catch(() => {})`, which is what kept the
  // dead action invisible in v1.2.1/v1.2.2.
  const [pendingCommand, setPendingCommand] = React.useState(null);
  const [commandResult, setCommandResult] = React.useState(null);
  const revision = React.useRef(0);
  const gearRef = React.useRef(null);
  const dialogRef = React.useRef(null);
  const draftRef = React.useRef(null);
  const savingRef = React.useRef(false);
  const setDraft = (next) => { draftRef.current = next; setOverlayCfg(next); };
  const invalidatePreview = () => {
    revision.current++;
    setPreviewing(false);
    setupRequest.current++;
    setCheckingSetup(false);
    setSetupReadiness(null);
    setReadinessMatchesSaved(false);
  };

  // Shared input/select styles for the overlay
  const inputStyle = {
    padding: '6px 10px',
    fontSize: 13,
    border: '1px solid rgba(0,0,0,0.2)',
    borderRadius: 6,
    background: '#fff',
    color: '#000',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box' as const,
    transition: 'border-color 0.15s, box-shadow 0.15s',
  };

  const selectStyle = {
    padding: '6px 10px',
    fontSize: 13,
    border: '1px solid rgba(0,0,0,0.2)',
    borderRadius: 6,
    background: '#fff',
    color: '#000',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box' as const,
    cursor: 'pointer',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  };

  const closeOverlay = () => {
    if (savingRef.current) return;
    invalidatePreview();
    overlaySession.current++;
    setPendingCommand(null);
    setCommandResult(null);
    setOverlayOpen(false);
  };
  React.useEffect(() => {
    if (!overlayOpen) return undefined;
    const dialog = dialogRef.current;
    dialog?.showModal();
    dialog?.focus();
    return () => {
      revision.current++;
      dialog?.close();
      gearRef.current?.focus();
    };
  }, [overlayOpen]);
  React.useEffect(() => {
    if (restoreGuideFocus.current && !saving && !guideVisible && overlayOpen) {
      restoreGuideFocus.current = false;
      guideButtonRef.current?.focus();
    }
  }, [saving, guideVisible, overlayOpen]);
  React.useEffect(() => {
    if (!checkingSetup && restoreCheckFocus.current) {
      restoreCheckFocus.current = false;
      if (overlayOpen && (document.activeElement === document.body || document.activeElement === dialogRef.current)) checkButtonRef.current?.focus();
    }
  }, [checkingSetup, overlayOpen]);

  const openOverlay = async () => {
    const request = ++revision.current;
    const session = ++overlaySession.current;
    const guideRequest = ++guideRevision.current;
    setupRequest.current++;
    setCheckingSetup(false);
    setSetupReadiness(null);
    setGuideVisible(false);
    restoreGuideFocus.current = false;
    setReadinessMatchesSaved(true);
    setOverlayOpen(true);
    setDraft(null);
    setOverlayError(null);
    setPendingCommand(null);
    setCommandResult(null);
    try {
      const c = await executeExtensionAction?.('getConfig');
      if (!c || typeof c !== 'object') throw new Error('Missing config');
      if (revision.current === request) setDraft(c);
      const setup = (await executeExtensionAction?.('getSetupState')) as { dismissed?: boolean } | undefined;
      if (overlaySession.current === session && guideRevision.current === guideRequest) setGuideVisible(setup?.dismissed === false);
    } catch {
      if (revision.current === request) setOverlayError('could not load the config');
    }
  };
  const finishGuide = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setOverlayError(null);
    guideRevision.current++;
    try {
      const state = (await executeExtensionAction?.('dismissSetup')) as { dismissed?: boolean } | undefined;
      if (state?.dismissed !== true) throw new Error('Missing setup state');
      setGuideVisible(false);
      restoreGuideFocus.current = true;
    } catch {
      setOverlayError('could not save the introduction status; please try again');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const checkSetup = async () => {
    if (!draftRef.current || savingRef.current || checkingSetup) return;
    const request = ++setupRequest.current;
    restoreCheckFocus.current = document.activeElement === checkButtonRef.current;
    setCheckingSetup(true);
    setSetupReadiness(null);
    setOverlayError(null);
    try {
      const result = (await executeExtensionAction?.('getSetupReadiness', draftRef.current)) as Record<string, { state: string; heading: string; detail: string }> | undefined;
      if (!result?.basic || !result?.backend || !result?.model || !result?.automatic) throw new Error('Missing setup result');
      if (setupRequest.current === request) setSetupReadiness(result);
    } catch {
      if (setupRequest.current === request) setOverlayError('could not check the setup; please try again');
    } finally {
      if (setupRequest.current === request) setCheckingSetup(false);
    }
  };
  const selectMode = async (mode) => {
    const request = ++revision.current;
    setPreviewing(true);
    setOverlayError(null);
    try {
      const next = await executeExtensionAction?.('previewMode', draftRef.current, mode);
      if (!next || typeof next !== 'object') throw new Error('Missing preset response');
      if (revision.current === request) setDraft(next);
    } catch {
      if (revision.current === request) setOverlayError('could not preview the preset; your settings were kept');
    } finally {
      if (revision.current === request) setPreviewing(false);
    }
  };
  const saveOverlay = async () => {
    if (savingRef.current || previewing || !draftRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const res = (await executeExtensionAction?.('setConfig', draftRef.current)) as { ok?: boolean; config?: Record<string, unknown> } | undefined;
      if (res?.ok !== true || !res.config) {
        setOverlayError('invalid value - the previous config was kept');
        return;
      }
      setDraft(res.config);
      revision.current++;
      setOverlayOpen(false);
      executeExtensionAction?.('refresh').catch?.(() => {});
    } catch {
      setOverlayError('could not save the config');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const patchOverlay = (patch) => {
    if (savingRef.current) return;
    invalidatePreview();
    const c = draftRef.current;
    if (!c) return;
    const changed = ['level', 'maxContextChars', 'protectedTurns'].some((key) => key in patch && patch[key] !== c[key])
      || ('brevity' in patch && patch.brevity?.level !== c.brevity?.level);
    setDraft({ ...c, ...patch, ...(changed ? { mode: 'custom' } : {}) });
  };
  const numberCommit = (key, fallback, max = Infinity) => (e) => {
    const n = Math.trunc(Number(e.target.value));
    if (Number.isFinite(n) && n >= 1 && n <= max) patchOverlay({ [key]: n });
    else e.target.value = String(draftRef.current?.[key] ?? fallback);
  };
  const overlayCache = overlayCfg?.cache ?? {};
  const overlayBrevity = overlayCfg?.brevity ?? {};
  // Commands that change state or spend money from a single click.
  // `reset` destroys this task's stats and `summarize now` triggers a real
  // summarizer call. The synthetic setup check is safe to run directly.
  // The read-only ones (status/stats/why/estimate/measure/help) run directly.
  const MUTATING_QUICK_COMMANDS = ['summarize now', 'reset'];
  const runQuickCommand = async (cmd) => {
    if (saving || previewing) return;
    if (MUTATING_QUICK_COMMANDS.includes(cmd) && pendingCommand !== cmd) {
      setPendingCommand(cmd);
      setCommandResult(null);
      return;
    }
    setPendingCommand(null);
    setCommandResult(null);
    try {
      const res = (await executeExtensionAction?.('runCommand', `broke ${cmd}`)) as { ok?: boolean; message?: string; error?: string } | undefined;
      if (res?.ok === true) setCommandResult({ ok: true, text: res.message ?? '', cmd });
      else setCommandResult({ ok: false, text: res?.error ?? 'the command returned no result', cmd });
    } catch {
      // A dead click must be visible, not swallowed.
      setCommandResult({ ok: false, text: 'the command could not be run', cmd });
    }
  };
  const dialogKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeOverlay(); }
    if (e.key === 'Tab') {
      const controls = (Array.from(dialogRef.current.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),summary')) as HTMLElement[])
        .filter((el) => !el.closest('details:not([open])') || el.tagName === 'SUMMARY');
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first) { e.preventDefault(); return; }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { e.preventDefault(); first.focus(); }
    }
  };

  // Polling fallback: re-fetches the data every 10s even if a push event
  // (triggerUIDataRefresh after a compression run) was missed by the
  // renderer - same pattern as the ext-savemytoken badge.
  // BRK-029: the poll runs ONLY while a summarizer backend is actually
  // active (level 'summarize' with a configured backend). Without one the
  // data is static between user actions - push events cover those - and
  // an idle interval would only keep the renderer busy.
  const activeBackend = data?.level === 'summarize' && data?.summarizerConfigured !== 'none';
  React.useEffect(() => {
    if (!activeBackend) return undefined;
    const p = setInterval(() => {
      executeExtensionAction?.('refresh').catch?.(() => {});
    }, 10000);
    return () => clearInterval(p);
  }, [activeBackend]);

  // Always render: until the first data fetch arrives the badge shows 0
  // instead of disappearing entirely.
  const total = data?.totalSavedTokens ?? 0;
  const level = data?.level ?? 'off';
  const configured = data?.summarizerConfigured ?? 'none';
  const ollama = data?.ollama ?? null;
  const cost = data?.cost ?? { savedUsd: null, modelLabel: null };
  // Idle transparency (XF17): when nothing was ever compressed for this
  // task, show WHY instead of a bare suspicious 0 - the last optimize run's
  // input size vs the configured threshold.
  const maxCtx = data?.maxContextChars ?? 0;
  const passes = data?.passes ?? 0;
  const obs = data?.observation ?? null;
  const isOptimizing = data?.isOptimizing === true;
  const neverSaved = total === 0 && passes === 0;
  const savedTokens = data?.savedTokens ?? { structural: 0, error: 0, truncate: 0, summarize: 0 };
  const estimates = data?.estimates ?? null;
  const providerUsage = data?.providerUsage ?? null;
  const observedReduction = data?.observedReduction ?? null;
  const k = (n) => `${Math.round(n / 1000)}k`;

  const money =
    cost.savedUsd != null && cost.savedUsd > 0
      ? ` ≈ $${cost.savedUsd < 0.01 ? cost.savedUsd.toFixed(4) : cost.savedUsd.toFixed(2)}`
      : '';
  const ollamaDown = configured === 'local' && ollama && !ollama.reachable;
  const dialogEnabled = overlayOpen ? overlayCfg?.enabled ?? level !== 'off' : level !== 'off';
  const dialogLevel = overlayOpen ? overlayCfg?.level ?? level : level;
  const dialogBackend = overlayOpen ? overlayCfg?.summarize?.via ?? configured : configured;
  const currentReadiness = overlayOpen ? setupReadiness ?? (readinessMatchesSaved ? data?.setupReadiness : null) : data?.setupReadiness;
  const summaryIssue = currentReadiness?.backend?.state === 'blocked' || currentReadiness?.backend?.state === 'unavailable'
    ? currentReadiness.backend
    : currentReadiness?.model?.state === 'unavailable' ? currentReadiness.model : null;
  const localSummaryNeedsSetup = dialogEnabled && dialogLevel === 'summarize' && dialogBackend === 'local' && (!!ollamaDown || !!summaryIssue);
  const localSummaryUnconfirmed = dialogEnabled && dialogLevel === 'summarize' && dialogBackend === 'local'
    && !localSummaryNeedsSetup && (!currentReadiness || ['unknown', 'checking', 'unchecked'].includes(currentReadiness.model?.state));
  const status = isOptimizing
    ? {
        heading: 'Broke is compressing',
        detail: 'Shortening older context for the next turn.',
        color: '#7030a0',
        background: '#f7f0fa',
        border: '#d8bfe8',
      }
    : !dialogEnabled
    ? {
        heading: 'Broke is off',
        detail: 'Turn it on to shorten older technical context automatically.',
        color: '#8a2d24',
        background: '#fff4f2',
        border: '#efc6c0',
      }
    : localSummaryNeedsSetup
      ? {
          heading: summaryIssue?.heading ?? 'Local summaries need setup',
          detail: summaryIssue ? `Basic compression still works. ${summaryIssue.detail}` : 'Basic compression still works. Start Ollama to enable the maximum-savings approach.',
          color: '#7a5512',
          background: '#fff8e8',
          border: '#ead39b',
        }
      : localSummaryUnconfirmed
        ? {
            heading: 'Basic compression is ready',
            detail: 'Local summaries have not been confirmed. Choose Check setup to check the backend and configured model.',
            color: '#185d82', background: '#eef7fb', border: '#b8d8e8',
          }
      : total > 0
        ? {
            heading: 'Broke is saving context',
            detail: `About ${total.toLocaleString('en-US')} input tokens removed so far${money}. Your saved task history is unchanged.`,
            color: '#19633b',
            background: '#eef8f1',
            border: '#b9ddc5',
          }
        : {
            heading: 'Broke is ready',
            detail: neverSaved && obs?.inputChars > 0 && obs?.belowThreshold
              ? 'This conversation is still short, so there is nothing to compress yet. There is nothing else to set up.'
              : 'It will shorten older technical context automatically. There is nothing else to set up.',
            color: '#185d82',
            background: '#eef7fb',
            border: '#b8d8e8',
          };
  const title = isOptimizing ? 'Broke is compressing context...' : `${status.heading}. ${status.detail}`;
  const statusLabel = isOptimizing
    ? 'Broke is compressing context...'
    : `${status.heading}. ${total.toLocaleString('en-US')} estimated input tokens saved.`;
  return (
    <div
      role="status"
      aria-label={statusLabel}
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        color: '#000',
        background: '#fff',
        border: '1px solid rgba(0,0,0,0.15)',
        borderRadius: 6,
        padding: '4px 8px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
      }}
    >
      <style>{`
        .broke-settings :focus-visible { outline: 2px solid #0066cc; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { .broke-status-dot { animation: none !important; } }
        @keyframes broke-pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.35); opacity: 0.55; }
        }
      `}</style>
      <span
        className="broke-status-dot"
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: status.color,
          flex: '0 0 auto',
          ...(isOptimizing ? { animation: 'broke-pulse 1.4s ease-in-out infinite' } : {}),
        }}
      />
      <span style={{ fontSize: 14 }}>💸</span>
      <span style={{ fontWeight: 600, fontSize: 13 }}>{total.toLocaleString('en-US')}</span>
      {neverSaved && obs && obs.inputChars > 0 && maxCtx > 0 ? (
        <span style={{ color: '#666', fontSize: 11 }}>
          · {k(obs.inputChars)}/{k(maxCtx)}
        </span>
      ) : null}
      {level === 'summarize' && configured !== 'none' ? (
        <span title="summarizer backend" style={{ fontSize: 13 }}>{configured === 'local' ? '🖥' : '☁'}{ollamaDown ? ' ⚠' : ''}</span>
      ) : null}
      <button
        type="button"
        ref={gearRef}
        aria-haspopup="dialog"
        aria-expanded={overlayOpen}
        aria-label={statusLabel}
        title={statusLabel}
        onClick={(e) => {
          e.stopPropagation();
          openOverlay();
        }}
        style={{
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          fontSize: 14,
          lineHeight: 1,
          padding: '2px 4px',
          borderRadius: 4,
          color: '#333',
          opacity: 0.8,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'rgba(0,0,0,0.05)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.8'; e.currentTarget.style.background = 'transparent'; }}
      >
        ⚙
      </button>
      {overlayOpen ? (
        <dialog
          className="broke-settings"
          ref={dialogRef}
          tabIndex={-1}
          aria-label="Broke settings"
          aria-modal="true"
          onCancel={(e) => { e.preventDefault(); closeOverlay(); }}
          onKeyDown={dialogKeyDown}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            inset: 0,
            margin: 'auto',
            padding: 0,
            border: 0,
            whiteSpace: 'normal',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.45)',
            fontSize: 12,
          }}
        >
          <div
            style={{
              background: '#ffffff',
              color: '#000000',
              border: '1px solid rgba(0,0,0,0.12)',
              borderRadius: 12,
              padding: '24px',
              boxSizing: 'border-box',
              width: 460,
              maxWidth: '94vw',
              maxHeight: '88vh',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
              boxShadow: '0 8px 30px rgba(0,0,0,0.12)',
              fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid rgba(0,0,0,0.08)', paddingBottom: 16 }}>
              <div>
                <div style={{ fontWeight: 750, fontSize: 19, color: '#111', letterSpacing: '-0.01em' }}>Broke</div>
                <div style={{ marginTop: 3, color: '#666', fontSize: 12 }}>Context savings for every task</div>
              </div>
              <button aria-label="Close settings" onClick={closeOverlay} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 20, color: '#777', padding: 4 }} title="Close settings">×</button>
            </div>
            
            {overlayError ? <div role="alert" style={{ color: '#d32f2f', background: '#ffebee', border: '1px solid #ffcdd2', borderRadius: 8, padding: '10px 14px', fontSize: 13, fontWeight: 500 }}>{overlayError}</div> : null}
            
            <div role="status" style={{ fontSize: 13, color: status.color, lineHeight: 1.55, background: status.background, padding: '13px 14px', borderRadius: 8, border: `1px solid ${status.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 14 }}>
                <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: '50%', background: status.color, flex: '0 0 auto' }} />
                {status.heading}
              </div>
              <p style={{ margin: '6px 0 0 17px', color: '#34424a' }}>{status.detail}</p>
            </div>
            
            {previewing ? <div role="status" style={{ color: '#856404', fontSize: 13, padding: '10px', background: '#fff3cd', border: '1px solid #ffeeba', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ animation: 'spin 1s linear infinite' }}>⏳</span> Previewing preset...
            </div> : null}
            
            {!overlayCfg ? (
              <div style={{ opacity: 0.9, color: '#666', textAlign: 'center', padding: '40px', fontSize: 14 }}>
                <span style={{ display: 'block', fontSize: 24, marginBottom: 12 }}>🔄</span>
                Loading configuration...
              </div>
            ) : (
              <>
                <button ref={guideButtonRef} type="button" onClick={() => { guideRevision.current++; setGuideVisible(true); }} disabled={saving}
                  style={{ ...selectStyle, width: 'auto', alignSelf: 'flex-start', minHeight: 36 }}>Setup guide</button>
                {guideVisible ? (
                  <section aria-label="Getting started" style={{ padding: 14, border: '1px solid #b8d8e8', borderRadius: 8, background: '#eef7fb', color: '#34424a', fontSize: 13, lineHeight: 1.55 }}>
                    <h2 style={{ margin: '0 0 8px', fontSize: 16, color: '#111' }}>Welcome to Broke</h2>
                    <p style={{ margin: '0 0 8px' }}>Balanced is recommended: shorten older technical output without extra software. Your first request and recent turns stay protected.</p>
                    <p style={{ margin: '0 0 8px' }}>Your approach applies to every task. This guide keeps your current settings; changes take effect only when you Save.</p>
                    <p style={{ margin: '0 0 12px' }}>A short conversation may show zero savings. Maximum savings optionally uses a local or cloud summarizer; checking setup does not generate a summary or measure its quality.</p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button type="button" onClick={finishGuide} disabled={saving} style={{ ...selectStyle, width: 'auto', minHeight: 40 }}>Got it</button>
                      <button type="button" onClick={finishGuide} disabled={saving} style={{ ...selectStyle, width: 'auto', minHeight: 40 }}>Skip introduction</button>
                    </div>
                  </section>
                ) : null}
                <fieldset disabled={saving} onChangeCapture={invalidatePreview} style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', fontWeight: 650, fontSize: 13, color: '#222' }}>
                    <input
                      type="checkbox"
                      checked={overlayCfg.enabled ?? true}
                      onChange={(e) => patchOverlay({ enabled: e.target.checked })}
                      style={{ width: 17, height: 17, accentColor: '#0066cc', cursor: 'pointer' }}
                    />
                    Use Broke automatically
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontWeight: 650, fontSize: 12, color: '#222' }}>Savings approach
                  <select value={overlayCfg.mode ?? 'custom'} onChange={(e) => void selectMode(e.target.value)} style={{ ...selectStyle, marginTop: 4 }}>
                    <option value="short">Safe - tidy repeated content only</option>
                    <option value="normal">Balanced - shorten old technical output (recommended)</option>
                    <option value="long">Maximum savings - summarize older work (setup required)</option>
                    <option value="custom">Custom - expert settings</option>
                  </select>
                  </label>
                  <p style={{ fontSize: 11, color: '#666', margin: 0, lineHeight: 1.5 }}>
                    This choice applies to every task. Balanced is the recommended default and does not require extra software.
                  </p>
                  {overlayCfg.mode === 'long' ? (
                    <div style={{ fontSize: 11, color: '#6d4d13', lineHeight: 1.5, background: '#fff8e8', border: '1px solid #ead39b', borderRadius: 6, padding: '8px 10px' }}>
                      Maximum savings needs local Ollama or a configured cloud model. Cloud summaries can cost money and send older conversation content to that provider.
                    </div>
                  ) : null}
                </fieldset>

                <div aria-label="Common actions" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
                  {[
                    { label: 'Check setup', cmd: 'setup', desc: 'Check readiness for your current settings without generating a summary' },
                    { label: 'View savings', cmd: 'stats', desc: 'Show what Broke has removed in this task' },
                    { label: 'Why no savings yet?', cmd: 'why', desc: 'Explain what Broke is waiting for' },
                  ].map((item) => (
                    <button
                      key={item.cmd}
                      ref={item.cmd === 'setup' ? checkButtonRef : undefined}
                      type="button"
                      onClick={(e) => { e.stopPropagation(); if (item.cmd === 'setup') void checkSetup(); else void runQuickCommand(item.cmd); }}
                      disabled={saving || previewing || (item.cmd === 'setup' && checkingSetup)}
                      title={item.desc}
                      style={{
                        padding: '9px 8px',
                        minHeight: 44,
                        fontSize: 12,
                        lineHeight: 1.25,
                        background: '#ffffff',
                        border: '1px solid #b8c7d1',
                        borderRadius: 7,
                        cursor: saving || previewing ? 'not-allowed' : 'pointer',
                        color: '#164d6a',
                        fontWeight: 650,
                        opacity: saving || previewing ? 0.5 : 1,
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                {checkingSetup || setupReadiness ? (
                  <section role="status" aria-label="Setup readiness" aria-live="polite" aria-busy={checkingSetup}
                    style={{ padding: 14, border: '1px solid #b8d8e8', borderRadius: 8, background: '#eef7fb', color: '#34424a', fontSize: 12, lineHeight: 1.5 }}>
                    <h2 style={{ margin: '0 0 10px', fontSize: 14 }}>{checkingSetup ? 'Checking setup...' : 'Setup readiness'}</h2>
                    {checkingSetup ? <p style={{ margin: 0 }}>Checking the current settings. No summary will be generated.</p> : (
                      <>
                        <dl style={{ margin: 0 }}>
                          {['basic', 'backend', 'model', 'automatic'].map((key) => (
                            <div key={key} style={{ marginBottom: 10 }}>
                              <dt style={{ fontWeight: 700 }}>{setupReadiness[key].heading}</dt>
                              <dd style={{ margin: '3px 0 0' }}>{setupReadiness[key].detail}</dd>
                            </div>
                          ))}
                        </dl>
                        <p style={{ margin: 0 }}>These checks do not prove summary quality, speed or billing savings. Results describe the settings shown here; Save applies changes.</p>
                      </>
                    )}
                  </section>
                ) : null}

                {commandResult ? (
                  <div
                    role="status"
                    style={{
                      padding: commandResult.cmd === 'stats' && commandResult.ok ? '12px 14px' : '9px 11px',
                      fontSize: 12,
                      lineHeight: 1.45,
                      background: commandResult.ok ? '#f4fbf5' : '#fdf1f1',
                      border: `1px solid ${commandResult.ok ? '#b9ddc5' : '#e6b7b7'}`,
                      borderRadius: 8,
                      color: commandResult.ok ? '#1e4620' : '#7a1f1f',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 700, fontSize: 13, color: commandResult.ok ? '#19633b' : '#8a2d24' }}>
                        {commandResult.cmd === 'stats' && commandResult.ok ? 'Savings & Usage Breakdown' : 'Result'}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setCommandResult(null); }}
                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16, color: '#666', padding: '0 4px', lineHeight: 1 }}
                        title="Dismiss result"
                        aria-label="Dismiss result"
                      >
                        ×
                      </button>
                    </div>

                    {commandResult.cmd === 'stats' && commandResult.ok ? (
                      <>
                        <div style={{ borderBottom: '1px solid rgba(25,99,59,0.15)', paddingBottom: 8 }}>
                          <div style={{ fontWeight: 700, fontSize: 12, color: '#19633b', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span>📉</span> Observed Context Reduction
                          </div>
                          <div style={{ marginTop: 4, color: '#2a3a30' }}>
                            <strong>{total.toLocaleString('en-US')}</strong> estimated tokens (
                            {observedReduction?.measuredChars != null
                              ? `${observedReduction.measuredChars.toLocaleString('en-US')} chars`
                              : `${(total * 4).toLocaleString('en-US')} chars`}
                            ) removed across {passes} compression run{passes === 1 ? '' : 's'}.
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '4px 8px', marginTop: 6, fontSize: 11, color: '#3f5245' }}>
                            <div>Structural: {savedTokens.structural.toLocaleString('en-US')} tok</div>
                            <div>Errors/logs: {savedTokens.error.toLocaleString('en-US')} tok</div>
                            <div>Truncate: {savedTokens.truncate.toLocaleString('en-US')} tok</div>
                            <div>Summarize: {savedTokens.summarize.toLocaleString('en-US')} tok</div>
                          </div>
                          {obs && obs.inputChars > 0 ? (
                            <div style={{ marginTop: 6, fontSize: 11, color: '#556b5d' }}>
                              Current context: {obs.inputChars.toLocaleString('en-US')} / {maxCtx.toLocaleString('en-US')} chars ({obs.belowThreshold ? 'below threshold' : 'over threshold'})
                            </div>
                          ) : null}
                        </div>

                        <div style={{ borderBottom: '1px solid rgba(25,99,59,0.15)', paddingBottom: 8 }}>
                          <div style={{ fontWeight: 700, fontSize: 12, color: '#185d82', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span>🔌</span> Provider-Reported Usage (Last Call)
                          </div>
                          {providerUsage ? (
                            <div style={{ marginTop: 4, color: '#163f54' }}>
                              <div>Sent tokens: {providerUsage.sentTokens.toLocaleString('en-US')}</div>
                              {providerUsage.cacheReadTokens > 0 || providerUsage.cacheWriteTokens > 0 ? (
                                <div style={{ fontSize: 11, marginTop: 2, color: '#185d82' }}>
                                  Prompt Cache: {providerUsage.cacheReadTokens.toLocaleString('en-US')} read | {providerUsage.cacheWriteTokens.toLocaleString('en-US')} written
                                </div>
                              ) : null}
                              {providerUsage.messageCost != null ? (
                                <div style={{ fontSize: 11, marginTop: 2, color: '#185d82' }}>
                                  Billed message cost: ${providerUsage.messageCost < 0.01 ? providerUsage.messageCost.toFixed(4) : providerUsage.messageCost.toFixed(2)}
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            <div style={{ marginTop: 4, fontSize: 11, color: '#556677' }}>
                              Awaiting next API call or not reported by current provider.
                            </div>
                          )}
                          <div style={{ marginTop: 5, fontSize: 11, color: '#556b5d', fontStyle: 'italic' }}>
                            A measurement ledger does not prove a billed saving. Provider caching and tier rates determine real costs.
                          </div>
                        </div>

                        <div>
                          <div style={{ fontWeight: 700, fontSize: 12, color: '#7a5512', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span>💵</span> Modeled Monetary Estimate
                          </div>
                          {cost.savedUsd != null && cost.savedUsd > 0 ? (
                            <div style={{ marginTop: 4, color: '#4a3608' }}>
                              <strong>≈ ${cost.savedUsd < 0.01 ? cost.savedUsd.toFixed(4) : cost.savedUsd.toFixed(2)}</strong> estimated savings at current {cost.modelLabel ?? 'model'} pricing.
                              <div style={{ marginTop: 2, fontSize: 11, color: '#66776c' }}>
                                Modeled estimate (removed tokens × input rate). Not a guaranteed billing reduction.
                              </div>
                            </div>
                          ) : (
                            <div style={{ marginTop: 4, fontSize: 11, color: '#66776c' }}>
                              No input rate registered for current model (no artificial dollar amount shown).
                            </div>
                          )}
                        </div>

                        {estimates && (estimates.slice > 0 || estimates.flush > 0 || estimates.search > 0) ? (
                          <div style={{ borderTop: '1px solid rgba(25,99,59,0.15)', paddingTop: 8, fontSize: 11, color: '#44554a' }}>
                            <div style={{ fontWeight: 650, color: '#33443a', marginBottom: 2 }}>📦 Avoided Context (Counterfactuals)</div>
                            <div>
                              {estimates.slice > 0 ? `Slicing: ~${estimates.slice.toLocaleString('en-US')} tok · ` : ''}
                              {estimates.flush > 0 ? `Flush: ~${estimates.flush.toLocaleString('en-US')} tok · ` : ''}
                              {estimates.search > 0 ? `Search: ~${estimates.search.toLocaleString('en-US')} tok` : ''}
                            </div>
                            <div style={{ marginTop: 2, color: '#77887d' }}>
                              Avoided by tool choices; not part of measured prompt reduction totals.
                            </div>
                          </div>
                        ) : null}

                        <details style={{ marginTop: 4, borderTop: '1px solid rgba(0,0,0,0.08)', paddingTop: 6 }}>
                          <summary style={{ cursor: 'pointer', fontSize: 11, color: '#556655', fontWeight: 600 }}>
                            Raw terminal output
                          </summary>
                          <pre style={{ margin: '6px 0 0', fontSize: 11, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#222' }}>
                            {commandResult.text}
                          </pre>
                        </details>
                      </>
                    ) : (
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 160, overflowY: 'auto' }}>
                        {commandResult.text}
                      </div>
                    )}
                  </div>
                ) : null}

                <details style={{ borderTop: '1px solid rgba(0,0,0,0.08)', paddingTop: 14 }}>
                  <summary style={{ cursor: 'pointer', color: '#34424a', fontSize: 12, fontWeight: 700, padding: '4px 0' }}>
                    Advanced settings and diagnostics
                  </summary>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 14 }}>
                    <p style={{ margin: 0, color: '#666', fontSize: 12 }}>The selftest below exercises synthetic input with a stub summarizer. It does not check the configured backend or model.</p>
                    <fieldset disabled={saving} onChangeCapture={invalidatePreview} style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontWeight: 500, fontSize: 12, color: '#222' }}>Broke automation
                        <select value={overlayCfg.autonomy ?? 'autonomous'} onChange={(e) => patchOverlay({ autonomy: e.target.value })} style={{ ...selectStyle, marginTop: 4 }}>
                          <option value="autonomous">Autonomous - follow feature switches</option>
                          <option value="manual">Manual - no automatic LLM calls or stored-history rewrites</option>
                        </select>
                      </label>
                      <p style={{ fontSize: 11, color: '#666', margin: 0, lineHeight: 1.5 }}>Host agent permissions are unchanged. Manual also pauses automatic snapshots and index refreshes; explicit commands still work.</p>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontWeight: 500, fontSize: 12, color: '#222' }}>Compression level
                        <select value={overlayCfg.level ?? 'truncate'} onChange={(e) => patchOverlay({ level: e.target.value })} style={{ ...selectStyle, marginTop: 4 }}>
                          <option value="structural">Structural - content-preserving only</option>
                          <option value="truncate">Truncate - + truncation of old tool outputs</option>
                          <option value="summarize">Summarize - + LLM summary (needs backend)</option>
                        </select>
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontWeight: 500, fontSize: 12, color: '#222' }}>Answer brevity
                        <select value={overlayBrevity.level ?? 'off'} onChange={(e) => patchOverlay({ brevity: { ...overlayBrevity, level: e.target.value } })} style={{ ...selectStyle, marginTop: 4 }}>
                          <option value="off">Off - normal responses</option>
                          <option value="lite">Lite - concise prose, no filler</option>
                          <option value="full">Full - terse caveman-style fragments</option>
                          <option value="ultra">Ultra - maximum telegraphic compression</option>
                        </select>
                      </label>
                      <div style={{ display: 'flex', gap: 12 }}>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, fontWeight: 500, fontSize: 12, color: '#222' }}>Max context chars
                          <input key={overlayCfg.maxContextChars} type="number" min="1" defaultValue={String(overlayCfg.maxContextChars ?? 60000)} onBlur={numberCommit('maxContextChars', 60000)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} style={{ ...inputStyle, marginTop: 4 }} />
                        </label>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, fontWeight: 500, fontSize: 12, color: '#222' }}>Protected turns
                          <input key={overlayCfg.protectedTurns} type="number" min="1" max="50" defaultValue={String(overlayCfg.protectedTurns ?? 2)} onBlur={numberCommit('protectedTurns', 2, 50)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} style={{ ...inputStyle, marginTop: 4 }} />
                        </label>
                      </div>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontWeight: 500, fontSize: 12, color: '#222' }} title="Auto detects the cache rules from the task model.">
                        Cache profile (prompt-cache friendly mode)
                        <select value={overlayCache.profile ?? 'off'} onChange={(e) => patchOverlay({ cache: { ...overlayCache, profile: e.target.value } })} style={{ ...selectStyle, marginTop: 4 }}>
                          <option value="off">Off - plain behavior</option>
                          <option value="auto">Auto - detect from task model (recommended)</option>
                          <option value="anthropic">Anthropic - Claude models</option>
                          <option value="openai">OpenAI - GPT/o-models</option>
                        </select>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }} title="Allows one cache-invalidating rewrite on a real budget overrun.">
                        <input type="checkbox" checked={overlayCache.escapeHatch ?? true} onChange={(e) => patchOverlay({ cache: { ...overlayCache, escapeHatch: e.target.checked } })} style={{ width: 16, height: 16, accentColor: '#0066cc', cursor: 'pointer' }} />
                        <span style={{ fontSize: 13, color: '#222' }}>Escape hatch on budget overruns</span>
                      </label>
                      <div style={{ fontSize: 11, color: '#777' }}>Full configuration: AiderDesk settings → Extensions → Broke.</div>
                    </fieldset>

                    <div>
                      <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 9, color: '#34424a' }}>Command tools</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 8 }}>
                        {[
                          { label: 'status', cmd: 'status', desc: 'Show config + stats' },
                          { label: 'stats', cmd: 'stats', desc: 'Per-pass token savings' },
                          { label: 'why', cmd: 'why', desc: 'Why 0 saved?' },
                          { label: 'estimate', cmd: 'estimate', desc: 'Slice/flush/search avoided' },
                          { label: 'measure', cmd: 'measure', desc: 'Per-run measurement ledger' },
                          { label: 'summarize now', cmd: 'summarize now', desc: 'Pre-warm summary cache' },
                          { label: 'reset', cmd: 'reset', desc: 'Clear task stats' },
                          { label: 'selftest', cmd: 'selftest', desc: 'Run pipeline self-test' },
                          { label: 'help', cmd: 'help', desc: 'Show all commands' },
                        ].map((item) => {
                          const armed = pendingCommand === item.cmd;
                          const mutating = MUTATING_QUICK_COMMANDS.includes(item.cmd);
                          return (
                    <button
                      key={item.cmd}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void runQuickCommand(item.cmd);
                      }}
                      disabled={saving || previewing}
                      style={{
                        padding: '8px 10px',
                        fontSize: 12,
                        background: armed ? '#fff3cd' : '#ffffff',
                        border: `1px solid ${armed ? '#d4a017' : 'rgba(0,0,0,0.12)'}`,
                        borderRadius: 6,
                        cursor: saving || previewing ? 'not-allowed' : 'pointer',
                        color: armed ? '#7a5c00' : '#333',
                        textAlign: 'left',
                        fontWeight: 500,
                        opacity: saving || previewing ? 0.5 : 1,
                        transition: 'all 0.15s ease',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                      }}
                      onMouseEnter={(e) => { if (!saving && !previewing && !armed) { e.currentTarget.style.background = '#f0f7ff'; e.currentTarget.style.borderColor = '#0066cc'; e.currentTarget.style.color = '#0066cc'; } }}
                      onMouseLeave={(e) => { if (!saving && !previewing && !armed) { e.currentTarget.style.background = '#ffffff'; e.currentTarget.style.borderColor = 'rgba(0,0,0,0.12)'; e.currentTarget.style.color = '#333'; } }}
                      title={armed ? 'Click again to run this command' : mutating ? `${item.desc} - needs a second click to confirm` : item.desc}
                    >
                      {armed ? (
                        <>Confirm? <span style={{ fontWeight: 700 }}>/broke {item.label}</span></>
                      ) : (
                        <>/broke <span style={{ fontWeight: 700 }}>{item.label}</span></>
                      )}
                    </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </details>
              </>
            )}
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', borderTop: '1px solid rgba(0,0,0,0.08)', paddingTop: 16, marginTop: 4 }}>
              <button
                type="button"
                onClick={closeOverlay}
                disabled={saving}
                style={{
                  padding: '8px 16px',
                  fontSize: 13,
                  fontWeight: 500,
                  background: '#f8f9fa',
                  border: '1px solid rgba(0,0,0,0.12)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  color: '#444',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#e9ecef'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = '#f8f9fa'; }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveOverlay()}
                disabled={saving || previewing || !overlayCfg}
                style={{
                  padding: '8px 24px',
                  fontSize: 13,
                  fontWeight: 600,
                  background: '#0066cc',
                  border: '1px solid #005bb7',
                  borderRadius: 6,
                  cursor: (saving || previewing || !overlayCfg) ? 'not-allowed' : 'pointer',
                  color: '#fff',
                  transition: 'all 0.15s',
                  boxShadow: '0 2px 4px rgba(0,102,204,0.2)',
                }}
                onMouseEnter={(e) => { if (!saving && !previewing && overlayCfg) { e.currentTarget.style.background = '#005bb7'; e.currentTarget.style.boxShadow = '0 4px 8px rgba(0,102,204,0.3)'; } }}
                onMouseLeave={(e) => { if (!saving && !previewing && overlayCfg) { e.currentTarget.style.background = '#0066cc'; e.currentTarget.style.boxShadow = '0 2px 4px rgba(0,102,204,0.2)'; } }}
              >
                {saving ? 'saving...' : 'Save'}
              </button>
            </div>
          </div>
        </dialog>
      ) : null}
    </div>
  );
}
