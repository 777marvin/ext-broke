({ data, executeExtensionAction }) => {
  /* BROKE_CONFIG_DRAFT_HELPER */
  // Precision Instrument Cockpit & Full Command Studio (StatusBadge.jsx).
  // Reads the full config via 'getConfig' and saves through 'setConfig' -
  // the same schema-validated path as ConfigComponent.jsx.
  const [overlayOpen, setOverlayOpen] = React.useState(false);
  const [overlayCfg, setOverlayCfg] = React.useState(null);
  const [overlayError, setOverlayError] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  const [guideVisible, setGuideVisible] = React.useState(false);
  const [guideStep, setGuideStep] = React.useState(1);
  const [setupReadiness, setSetupReadiness] = React.useState(null);
  const [checkingSetup, setCheckingSetup] = React.useState(false);
  const [cmdCategory, setCmdCategory] = React.useState('all');
  const [advancedOpen, setAdvancedOpen] = React.useState(false);

  // Parameterized command inputs & refs for the Command Studio
  const [searchQuery, setSearchQuery] = React.useState('');
  const [diffBudget, setDiffBudget] = React.useState('8000');
  const [snapshotLabel, setSnapshotLabel] = React.useState('');
  const [snapshotIndex, setSnapshotIndex] = React.useState('1');
  const [sliceFocusPath, setSliceFocusPath] = React.useState('');
  const [toolRuleName, setToolRuleName] = React.useState('bash');
  const [toolRuleLines, setToolRuleLines] = React.useState('120');
  const [toolRuleKB, setToolRuleKB] = React.useState('12');
  const [configPathInput, setConfigPathInput] = React.useState('maxContextChars');
  const [configValueInput, setConfigValueInput] = React.useState('60000');
  const [updateTagInput, setUpdateTagInput] = React.useState('');
  const [customCmdInput, setCustomCmdInput] = React.useState('');

  const searchInputRef = React.useRef(null);
  const diffInputRef = React.useRef(null);
  const snapshotLabelRef = React.useRef(null);
  const snapshotIndexRef = React.useRef(null);
  const sliceFocusRef = React.useRef(null);
  const toolNameRef = React.useRef(null);
  const toolLinesRef = React.useRef(null);
  const toolKBRef = React.useRef(null);
  const configPathRef = React.useRef(null);
  const configValueRef = React.useRef(null);
  const updateTagRef = React.useRef(null);
  const customCmdRef = React.useRef(null);

  const setupRequest = React.useRef(0);
  const overlaySession = React.useRef(0);
  const guideButtonRef = React.useRef(null);
  const checkButtonRef = React.useRef(null);
  const onboardingCheckButtonRef = React.useRef(null);
  const restoreCheckFocus = React.useRef(false);
  const guideRevision = React.useRef(0);
  const restoreGuideFocus = React.useRef(false);
  const [readinessMatchesSaved, setReadinessMatchesSaved] = React.useState(false);

  // Quick Commands & Command Studio: state-changing, destructive, or paid/network
  // commands require two-step confirmation (`pendingCommand` holds the armed command).
  const [pendingCommand, setPendingCommand] = React.useState(null);
  const [commandResult, setCommandResult] = React.useState(null);
  const [executingCmd, setExecutingCmd] = React.useState<string | null>(null);
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

  const inputStyle = {
    padding: '6px 10px',
    fontSize: 12,
    border: '1px solid #cbd5e1',
    borderRadius: 6,
    background: '#ffffff',
    color: '#0f172a',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box' as const,
    transition: 'border-color 0.15s, box-shadow 0.15s',
  };

  const selectStyle = {
    padding: '7px 10px',
    fontSize: 12,
    border: '1px solid #cbd5e1',
    borderRadius: 6,
    background: '#ffffff',
    color: '#0f172a',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box' as const,
    cursor: 'pointer',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  };

  const buttonStyle = {
    padding: '7px 10px',
    fontSize: 12,
    border: '1px solid #cbd5e1',
    borderRadius: 6,
    background: '#ffffff',
    color: '#0f172a',
    outline: 'none',
    boxSizing: 'border-box' as const,
    cursor: 'pointer',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  };

  const closeOverlay = () => {
    if (savingRef.current || executingCmd) return;
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
      if (overlayOpen) {
        if (guideVisible && guideStep === 2 && onboardingCheckButtonRef.current) {
          onboardingCheckButtonRef.current.focus();
        } else if (document.activeElement === document.body || document.activeElement === dialogRef.current) {
          checkButtonRef.current?.focus();
        }
      }
    }
  }, [checkingSetup, overlayOpen, guideVisible, guideStep]);

  const openOverlay = async () => {
    const request = ++revision.current;
    const session = ++overlaySession.current;
    const guideRequest = ++guideRevision.current;
    setupRequest.current++;
    setCheckingSetup(false);
    setSetupReadiness(null);
    setGuideVisible(false);
    setGuideStep(1);
    setAdvancedOpen(false);
    setCmdCategory('all');
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
    restoreCheckFocus.current = document.activeElement === checkButtonRef.current || document.activeElement === onboardingCheckButtonRef.current;
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
    const base = overlayCfg ?? c;
    setDraft(mergeConfigDraft(base, c, { ...base, ...patch }));
  };

  const numberCommit = (key, fallback, max = Infinity) => (e) => {
    const n = Math.trunc(Number(e.target.value));
    if (Number.isFinite(n) && n >= 1 && n <= max) patchOverlay({ [key]: n });
    else e.target.value = String(draftRef.current?.[key] ?? fallback);
  };

  const overlayCache = overlayCfg?.cache ?? {};
  const overlayBrevity = overlayCfg?.brevity ?? {};

  // Read-only commands execute immediately on first click; all state-changing,
  // destructive, or paid/network commands use two-step confirmation.
  const READONLY_COMMANDS = new Set([
    'status',
    'stats',
    'why',
    'estimate',
    'measure',
    'selftest',
    'help',
    'index status',
    'slice status',
    'snapshot list',
    'config list',
    'update check',
  ]);
  const isMutatingCommand = (cmd: string) => {
    const normalized = cmd.trim().replace(/^\/?broke\b\s*/i, '');
    if (READONLY_COMMANDS.has(normalized)) return false;
    if (normalized.startsWith('diff') || normalized.startsWith('snapshot show ') || normalized.startsWith('config get ')) return false;
    if (normalized.startsWith('search ') && normalized !== 'search on' && normalized !== 'search off') return false;
    return true;
  };

  const runQuickCommand = async (rawCmd: string) => {
    if (saving || previewing || executingCmd) return;
    const cmd = rawCmd.trim().replace(/^\/?broke\b\s*/i, '');
    if (!cmd) return;
    if (isMutatingCommand(cmd) && pendingCommand !== cmd) {
      setPendingCommand(cmd);
      setCommandResult(null);
      return;
    }
    setPendingCommand(null);
    setCommandResult(null);
    setExecutingCmd(cmd);
    try {
      const res = (await executeExtensionAction?.('runCommand', `broke ${cmd}`)) as { ok?: boolean; message?: string; error?: string } | undefined;
      if (res?.ok === true) {
        setCommandResult({ ok: true, text: res.message ?? '', cmd });
        if (cmd === 'reset' || cmd.startsWith('reset') || cmd.startsWith('flush')) {
          executeExtensionAction?.('refresh').catch?.(() => {});
        }
        // If a command mutated config, sync the draft seamlessly
        if (
          cmd.startsWith('mode ') ||
          cmd.startsWith('autonomy ') ||
          cmd === 'on' ||
          cmd === 'off' ||
          cmd.startsWith('level ') ||
          cmd.startsWith('brevity ') ||
          cmd.startsWith('maxchars ') ||
          cmd.startsWith('protect ') ||
          cmd.startsWith('truncate ') ||
          cmd.startsWith('errors ') ||
          cmd.startsWith('slice ') ||
          cmd.startsWith('search on') ||
          cmd.startsWith('search off') ||
          cmd.startsWith('summarize ') ||
          cmd.startsWith('measure on') ||
          cmd.startsWith('measure off') ||
          cmd.startsWith('config set ')
        ) {
          const fresh = await executeExtensionAction?.('getConfig');
          if (fresh && typeof fresh === 'object') setDraft(fresh);
        }
      } else {
        setCommandResult({ ok: false, text: res?.error ?? 'the command returned no result', cmd });
      }
    } catch {
      setCommandResult({ ok: false, text: 'the command could not be run', cmd });
    } finally {
      setExecutingCmd(null);
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

  const activeBackend = data?.level === 'summarize' && data?.summarizerConfigured !== 'none';
  React.useEffect(() => {
    if (!activeBackend) return undefined;
    const p = setInterval(() => {
      executeExtensionAction?.('refresh').catch?.(() => {});
    }, 10000);
    return () => clearInterval(p);
  }, [activeBackend]);

  const total = data?.totalSavedTokens ?? 0;
  const level = data?.level ?? 'off';
  const configured = data?.summarizerConfigured ?? 'none';
  const ollama = data?.ollama ?? null;
  const cost = data?.cost ?? { savedUsd: null, modelLabel: null };
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
  const dialogMode = overlayOpen ? overlayCfg?.mode ?? data?.mode ?? 'custom' : data?.mode ?? 'custom';
  const dialogAutonomy = overlayOpen ? overlayCfg?.autonomy ?? data?.autonomy ?? 'autonomous' : data?.autonomy ?? 'autonomous';
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
            color: '#185d82',
            background: '#eef7fb',
            border: '#b8d8e8',
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

  const fillPct = obs && obs.inputChars > 0 && maxCtx > 0 ? Math.min(100, Math.round((obs.inputChars / maxCtx) * 100)) : 0;
  const passTotal = savedTokens.structural + savedTokens.error + savedTokens.truncate + savedTokens.summarize;

  // All 1-click commands grouped by category for the Command Studio
  const STUDIO_QUICK_COMMANDS = [
    // Diagnostics
    { label: 'status', cmd: 'status', cat: 'diag', desc: 'Full config + stats + Ollama readiness' },
    { label: 'stats', cmd: 'stats', cat: 'diag', desc: 'Per-pass token savings breakdown' },
    { label: 'why', cmd: 'why', cat: 'diag', desc: 'Gate-by-gate verdict for this task' },
    { label: 'estimate', cmd: 'estimate', cat: 'diag', desc: 'Counterfactual slice/flush/search savings' },
    { label: 'measure', cmd: 'measure', cat: 'diag', desc: 'Per-run measurement ledger summary' },
    { label: 'diff', cmd: 'diff', cat: 'diag', desc: 'Token-budgeted uncommitted diff digest' },
    { label: 'selftest', cmd: 'selftest', cat: 'diag', desc: 'Run synthetic pipeline self-test' },
    { label: 'help', cmd: 'help', cat: 'diag', desc: 'List all /broke subcommands' },
    // Snapshots & Flush
    { label: 'snapshot', cmd: 'snapshot', cat: 'snap', desc: 'Record a manual milestone snapshot now' },
    { label: 'snapshot list', cmd: 'snapshot list', cat: 'snap', desc: 'List recorded snapshots for this task' },
    { label: 'flush', cmd: 'flush', cat: 'snap', desc: 'Flush covered older turns into [broke-state]' },
    { label: 'flush --yes', cmd: 'flush --yes', cat: 'snap', desc: 'Flush immediately without host prompt' },
    { label: 'summarize now', cmd: 'summarize now', cat: 'snap', desc: 'Pre-warm & cache summary of old turns' },
    { label: 'reset', cmd: 'reset', cat: 'snap', desc: 'Clear task stats & cached summary' },
    // Search, Index & Slice
    { label: 'index status', cmd: 'index status', cat: 'search', desc: 'Show local keyword index metrics' },
    { label: 'index rebuild', cmd: 'index rebuild', cat: 'search', desc: 'Rebuild project keyword index now' },
    { label: 'search on', cmd: 'search on', cat: 'search', desc: 'Register broke-search agent tool' },
    { label: 'search off', cmd: 'search off', cat: 'search', desc: 'Unregister broke-search agent tool' },
    { label: 'slice status', cmd: 'slice status', cat: 'search', desc: 'Show ST-slicing mode & active focus' },
    { label: 'slice on', cmd: 'slice on', cat: 'search', desc: 'Enable ST-slicing interface views' },
    { label: 'slice off', cmd: 'slice off', cat: 'search', desc: 'Disable ST-slicing interface views' },
    { label: 'slice focus clear', cmd: 'slice focus clear', cat: 'search', desc: 'Clear explicit slice focus path' },
    // Pipeline, Archives & Modes
    { label: 'on', cmd: 'on', cat: 'pipe', desc: 'Enable Broke compression pipeline' },
    { label: 'off', cmd: 'off', cat: 'pipe', desc: 'Disable Broke compression pipeline' },
    { label: 'mode short', cmd: 'mode short', cat: 'pipe', desc: 'Switch to Safe preset' },
    { label: 'mode normal', cmd: 'mode normal', cat: 'pipe', desc: 'Switch to Balanced preset' },
    { label: 'mode long', cmd: 'mode long', cat: 'pipe', desc: 'Switch to Maximum savings preset' },
    { label: 'mode custom', cmd: 'mode custom', cat: 'pipe', desc: 'Switch to Custom expert mode' },
    { label: 'autonomy autonomous', cmd: 'autonomy autonomous', cat: 'pipe', desc: 'Enable autonomous Broke actions' },
    { label: 'autonomy manual', cmd: 'autonomy manual', cat: 'pipe', desc: 'Manual deterministic compression only' },
    { label: 'level structural', cmd: 'level structural', cat: 'pipe', desc: 'Set level to structural only' },
    { label: 'level truncate', cmd: 'level truncate', cat: 'pipe', desc: 'Set level to structural + truncate' },
    { label: 'level summarize', cmd: 'level summarize', cat: 'pipe', desc: 'Set level to full summarize' },
    { label: 'brevity off', cmd: 'brevity off', cat: 'pipe', desc: 'Disable answer brevity directive' },
    { label: 'brevity lite', cmd: 'brevity lite', cat: 'pipe', desc: 'Set answer brevity to lite' },
    { label: 'brevity full', cmd: 'brevity full', cat: 'pipe', desc: 'Set answer brevity to full' },
    { label: 'brevity ultra', cmd: 'brevity ultra', cat: 'pipe', desc: 'Set answer brevity to ultra' },
    { label: 'errors on', cmd: 'errors on', cat: 'pipe', desc: 'Enable stack-trace/error compression' },
    { label: 'errors off', cmd: 'errors off', cat: 'pipe', desc: 'Disable stack-trace/error compression' },
    { label: 'errors clear', cmd: 'errors clear', cat: 'pipe', desc: 'Delete all archived error outputs now' },
    { label: 'truncate clear', cmd: 'truncate clear', cat: 'pipe', desc: 'Delete all archived truncated outputs now' },
    { label: 'measure on', cmd: 'measure on', cat: 'pipe', desc: 'Enable per-run measurement ledger' },
    { label: 'measure off', cmd: 'measure off', cat: 'pipe', desc: 'Disable per-run measurement ledger' },
    // Config, Summarizer & Updates
    { label: 'config list', cmd: 'config list', cat: 'sys', desc: 'List all settings & non-default values' },
    { label: 'summarize via local', cmd: 'summarize via local', cat: 'sys', desc: 'Use local Ollama summarizer backend' },
    { label: 'summarize via cloud', cmd: 'summarize via cloud', cat: 'sys', desc: 'Use cloud AiderDesk model summarizer' },
    { label: 'summarize allow-remote on', cmd: 'summarize allow-remote on', cat: 'sys', desc: 'Allow non-loopback Ollama host' },
    { label: 'summarize allow-remote off', cmd: 'summarize allow-remote off', cat: 'sys', desc: 'Block non-loopback Ollama host' },
    { label: 'update check', cmd: 'update check', cat: 'sys', desc: 'Check GitHub releases for updates' },
    { label: 'update', cmd: 'update', cat: 'sys', desc: 'Install latest signed release' },
  ];

  const visibleQuickCommands = cmdCategory === 'all'
    ? STUDIO_QUICK_COMMANDS
    : STUDIO_QUICK_COMMANDS.filter((item) => item.cat === cmdCategory);

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
        color: '#0f172a',
        background: 'linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)',
        border: `1px solid ${status.border}`,
        borderRadius: 7,
        padding: '4px 8px',
        boxShadow: '0 1px 3px rgba(15,23,42,0.08), inset 0 1px 0 rgba(255,255,255,0.9)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
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
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: status.color,
          boxShadow: `0 0 0 2px ${status.background}`,
          flex: '0 0 auto',
          ...(isOptimizing ? { animation: 'broke-pulse 1.4s ease-in-out infinite' } : {}),
        }}
      />
      <span style={{ fontSize: 13 }}>💸</span>
      <span style={{ fontWeight: 700, fontSize: 12, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em' }}>
        {total.toLocaleString('en-US')}
      </span>
      {neverSaved && obs && obs.inputChars > 0 && maxCtx > 0 ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#475569', fontSize: 11 }}>
          <span>· {k(obs.inputChars)}/{k(maxCtx)}</span>
          <span
            aria-hidden="true"
            style={{
              width: 24,
              height: 4,
              borderRadius: 2,
              background: '#e2e8f0',
              overflow: 'hidden',
              display: 'inline-block',
            }}
          >
            <span
              style={{
                display: 'block',
                height: '100%',
                width: `${fillPct}%`,
                background: fillPct >= 100 ? '#7030a0' : '#0284c7',
              }}
            />
          </span>
        </span>
      ) : null}
      {level === 'summarize' && configured !== 'none' ? (
        <span title="summarizer backend" style={{ fontSize: 12, padding: '1px 4px', borderRadius: 4, background: '#f1f5f9' }}>
          {configured === 'local' ? '🖥' : '☁'}{ollamaDown ? ' ⚠' : ''}
        </span>
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
          border: '1px solid rgba(15,23,42,0.1)',
          background: '#f8fafc',
          cursor: 'pointer',
          fontSize: 13,
          lineHeight: 1,
          padding: '2px 5px',
          borderRadius: 5,
          color: '#1e293b',
          opacity: 0.9,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = '#e2e8f0'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.9'; e.currentTarget.style.background = '#f8fafc'; }}
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
            background: 'rgba(15, 23, 42, 0.55)',
            fontSize: 12,
          }}
        >
          <div
            style={{
              background: '#ffffff',
              color: '#0f172a',
              border: '1px solid #cbd5e1',
              borderRadius: 14,
              padding: '20px 22px',
              boxSizing: 'border-box',
              width: 540,
              maxWidth: '95vw',
              maxHeight: '90vh',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              boxShadow: '0 20px 45px rgba(15, 23, 42, 0.22), 0 0 0 1px rgba(15, 23, 42, 0.05)',
              fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
            }}
          >
            {/* Precision Instrument Cockpit Header */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
                color: '#f8fafc',
                borderRadius: 10,
                padding: '14px 16px',
                border: '1px solid #334155',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 18 }}>💸</span>
                  <span style={{ fontWeight: 800, fontSize: 18, color: '#ffffff', letterSpacing: '-0.02em' }}>Broke</span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      padding: '2px 6px',
                      borderRadius: 4,
                      background: 'rgba(56, 189, 248, 0.18)',
                      color: '#7dd3fc',
                      border: '1px solid rgba(56, 189, 248, 0.3)',
                    }}
                  >
                    Instrument Cockpit
                  </span>
                </div>
                <div style={{ color: '#cbd5e1', fontSize: 12 }}>Context savings for every task</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                  <span style={{ fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: 4, color: '#e2e8f0' }}>
                    MODE: {String(dialogMode).toUpperCase()}
                  </span>
                  <span style={{ fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: 4, color: '#e2e8f0' }}>
                    LEVEL: {String(dialogEnabled ? dialogLevel : 'off').toUpperCase()}
                  </span>
                  <span style={{ fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: 4, color: '#e2e8f0' }}>
                    AUTO: {String(dialogAutonomy).toUpperCase()}
                  </span>
                  <span style={{ fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: 4, color: '#e2e8f0' }}>
                    RUNS: {passes}
                  </span>
                </div>
              </div>
              <button
                aria-label="Close settings"
                onClick={closeOverlay}
                style={{
                  background: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 18,
                  lineHeight: 1,
                  color: '#e2e8f0',
                  padding: '4px 8px',
                }}
                title="Close settings"
              >
                ×
              </button>
            </div>

            {overlayError ? (
              <div role="alert" style={{ color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', fontSize: 13, fontWeight: 600 }}>
                {overlayError}
              </div>
            ) : null}

            {/* Live Status & Context Budget Instrument Card */}
            <div
              role="status"
              style={{
                fontSize: 13,
                color: status.color,
                lineHeight: 1.5,
                background: status.background,
                padding: '13px 14px',
                borderRadius: 10,
                border: `1px solid ${status.border}`,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 14 }}>
                  <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: '50%', background: status.color, flex: '0 0 auto' }} />
                  {status.heading}
                </div>
                {cost.savedUsd != null && cost.savedUsd > 0 ? (
                  <span style={{ fontSize: 11, fontWeight: 700, background: 'rgba(255,255,255,0.85)', padding: '2px 7px', borderRadius: 99, border: `1px solid ${status.border}` }}>
                    {money.trim()} est.
                  </span>
                ) : null}
              </div>
              <p style={{ margin: '0 0 0 17px', color: '#34424a' }}>{status.detail}</p>

              {/* Context Budget Gauge Bar */}
              {(obs && obs.inputChars > 0 && maxCtx > 0) || passTotal > 0 ? (
                <div style={{ marginLeft: 17, marginTop: 2, paddingTop: 8, borderTop: `1px solid ${status.border}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {obs && obs.inputChars > 0 && maxCtx > 0 ? (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#334155', marginBottom: 3, fontVariantNumeric: 'tabular-nums' }}>
                        <span>Context Budget Fill: <strong>{obs.inputChars.toLocaleString('en-US')}</strong> / {maxCtx.toLocaleString('en-US')} chars</span>
                        <span>{fillPct}% ({obs.belowThreshold ? 'below threshold' : 'lossy passes engaged'})</span>
                      </div>
                      <div style={{ height: 6, borderRadius: 3, background: 'rgba(15,23,42,0.1)', overflow: 'hidden' }}>
                        <div
                          style={{
                            height: '100%',
                            width: `${fillPct}%`,
                            background: obs.belowThreshold ? '#0284c7' : '#16a34a',
                            transition: 'width 0.25s ease',
                          }}
                        />
                      </div>
                    </div>
                  ) : null}

                  {passTotal > 0 ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 11, color: '#334155', fontVariantNumeric: 'tabular-nums' }}>
                      <span>Removed by pass:</span>
                      <span><strong>Structural</strong> {savedTokens.structural.toLocaleString('en-US')}t</span>
                      <span>· <strong>Errors</strong> {savedTokens.error.toLocaleString('en-US')}t</span>
                      <span>· <strong>Truncate</strong> {savedTokens.truncate.toLocaleString('en-US')}t</span>
                      <span>· <strong>Summarize</strong> {savedTokens.summarize.toLocaleString('en-US')}t</span>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            {previewing ? (
              <div role="status" style={{ color: '#856404', fontSize: 13, padding: '10px', background: '#fff3cd', border: '1px solid #ffeeba', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>⏳</span> Previewing preset...
              </div>
            ) : null}

            {!overlayCfg ? (
              <div style={{ opacity: 0.9, color: '#666', textAlign: 'center', padding: '40px', fontSize: 14 }}>
                <span style={{ display: 'block', fontSize: 24, marginBottom: 12 }}>🔄</span>
                Loading configuration...
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <button
                    ref={guideButtonRef}
                    type="button"
                    onClick={() => { guideRevision.current++; setGuideVisible(true); }}
                    disabled={saving}
                    style={{ ...buttonStyle, minHeight: 34, fontWeight: 600, background: '#f8fafc' }}
                  >
                    Setup guide
                  </button>
                  <button
                    type="button"
                    onClick={() => setAdvancedOpen((prev) => !prev)}
                    disabled={saving}
                    style={{ ...buttonStyle, minHeight: 34, fontWeight: 600, color: '#0369a1', border: '1px solid #bae6fd', background: '#f0f9ff' }}
                  >
                    {advancedOpen ? 'Hide Command Studio' : 'Open Command Studio (All Commands)'}
                  </button>
                </div>

                {/* Interactive 3-Step Onboarding Flow (F7.2 + Full UI Command Integration) */}
                {guideVisible ? (
                  <section
                    aria-label="Getting started"
                    style={{
                      padding: 15,
                      border: '1px solid #93c5fd',
                      borderRadius: 10,
                      background: 'linear-gradient(180deg, #eff6ff 0%, #f8fafc 100%)',
                      color: '#1e293b',
                      fontSize: 12.5,
                      lineHeight: 1.55,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <h2 style={{ margin: 0, fontSize: 16, color: '#0f172a', fontWeight: 750 }}>Welcome to Broke</h2>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {[
                          { step: 1, label: '1. Approach' },
                          { step: 2, label: '2. Readiness' },
                          { step: 3, label: '3. Command Studio' },
                        ].map((s) => (
                          <button
                            key={s.step}
                            type="button"
                            onClick={() => setGuideStep(s.step)}
                            disabled={saving}
                            style={{
                              padding: '3px 8px',
                              fontSize: 11,
                              fontWeight: guideStep === s.step ? 700 : 500,
                              borderRadius: 99,
                              border: `1px solid ${guideStep === s.step ? '#0284c7' : '#cbd5e1'}`,
                              background: guideStep === s.step ? '#0284c7' : '#ffffff',
                              color: guideStep === s.step ? '#ffffff' : '#334155',
                              cursor: 'pointer',
                            }}
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <p style={{ margin: 0 }}>
                      Balanced is recommended: shorten older technical output without extra software. Your first request and recent turns stay protected.
                    </p>
                    <p style={{ margin: 0 }}>
                      Your approach applies to every task. This guide keeps your current settings; changes take effect only when you Save.
                    </p>
                    <p style={{ margin: 0 }}>
                      A short conversation may show zero savings. Maximum savings optionally uses a local or cloud summarizer; checking setup does not generate a summary or measure its quality.
                    </p>

                    {/* Interactive Onboarding Step Cards */}
                    <div style={{ background: '#ffffff', border: '1px solid #dbeafe', borderRadius: 8, padding: '10px 12px' }}>
                      {guideStep === 1 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div style={{ fontWeight: 700, color: '#0f172a' }}>Step 1: Choose your operating approach</div>
                          <div style={{ fontSize: 12, color: '#475569' }}>
                            <strong>Safe</strong> tidies duplicates only · <strong>Balanced</strong> trims old logs &amp; tool outputs · <strong>Maximum savings</strong> summarizes old turns via Ollama or Cloud.
                          </div>
                        </div>
                      ) : guideStep === 2 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div style={{ fontWeight: 700, color: '#0f172a' }}>Step 2: Verify readiness in one click</div>
                          <div style={{ fontSize: 12, color: '#475569' }}>
                            Run a metadata-only readiness check for your current draft without sending conversation content:
                          </div>
                          <div>
                            <button
                              ref={onboardingCheckButtonRef}
                              type="button"
                              onClick={() => void checkSetup()}
                              disabled={saving || checkingSetup}
                              style={{ ...buttonStyle, padding: '5px 10px', fontWeight: 600, background: '#f0f9ff', border: '1px solid #7dd3fc', color: '#0369a1' }}
                            >
                              {checkingSetup ? 'Checking setup...' : 'Run Readiness Check Now'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div style={{ fontWeight: 700, color: '#0f172a' }}>Step 3: Every command is clickable in the UI</div>
                          <div style={{ fontSize: 12, color: '#475569' }}>
                            No need to memorize CLI syntax: launch diagnostics, snapshots, flush, local search, ST-slicing, diffs, and updates directly from the <strong>Command Studio</strong> below.
                          </div>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              onClick={() => { setAdvancedOpen(true); setCmdCategory('all'); }}
                              disabled={saving}
                              style={{ ...buttonStyle, padding: '4px 9px', fontSize: 11, fontWeight: 600, background: '#0f172a', color: '#fff' }}
                            >
                              Explore All Commands
                            </button>
                            <button
                              type="button"
                              onClick={() => void runQuickCommand('index status')}
                              disabled={saving}
                              style={{ ...buttonStyle, padding: '4px 9px', fontSize: 11, fontWeight: 600 }}
                            >
                              Try: Check Search Index
                            </button>
                            <button
                              type="button"
                              onClick={() => void runQuickCommand('snapshot list')}
                              disabled={saving}
                              style={{ ...buttonStyle, padding: '4px 9px', fontSize: 11, fontWeight: 600 }}
                            >
                              Try: List Snapshots
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button type="button" onClick={finishGuide} disabled={saving} style={{ ...buttonStyle, minHeight: 38, fontWeight: 700, background: '#0066cc', color: '#fff', border: '1px solid #005bb7' }}>
                          Got it
                        </button>
                        <button type="button" onClick={finishGuide} disabled={saving} style={{ ...buttonStyle, minHeight: 38 }}>
                          Skip introduction
                        </button>
                      </div>
                      {guideStep < 3 ? (
                        <button
                          type="button"
                          onClick={() => setGuideStep((s) => Math.min(3, s + 1))}
                          disabled={saving}
                          style={{ ...buttonStyle, minHeight: 34, fontSize: 11, fontWeight: 600 }}
                        >
                          Next step →
                        </button>
                      ) : null}
                    </div>
                  </section>
                ) : null}

                {/* Everyday Controls */}
                <fieldset
                  disabled={saving}
                  onChangeCapture={invalidatePreview}
                  style={{
                    border: '1px solid #e2e8f0',
                    borderRadius: 10,
                    padding: '12px 14px',
                    margin: 0,
                    background: '#f8fafc',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                  }}
                >
                  <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', fontWeight: 650, fontSize: 13, color: '#0f172a' }}>
                    <input
                      type="checkbox"
                      checked={overlayCfg.enabled ?? true}
                      onChange={(e) => patchOverlay({ enabled: e.target.checked })}
                      style={{ width: 17, height: 17, accentColor: '#0066cc', cursor: 'pointer' }}
                    />
                    Use Broke automatically
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontWeight: 650, fontSize: 12, color: '#0f172a' }}>
                    Savings approach
                    <select value={overlayCfg.mode ?? 'custom'} onChange={(e) => void selectMode(e.target.value)} style={{ ...selectStyle, marginTop: 4 }}>
                      <option value="short">Safe - tidy repeated content only</option>
                      <option value="normal">Balanced - shorten old technical output (recommended)</option>
                      <option value="long">Maximum savings - summarize older work (setup required)</option>
                      <option value="custom">Custom - expert settings</option>
                    </select>
                  </label>
                  <p style={{ fontSize: 11, color: '#475569', margin: 0, lineHeight: 1.5 }}>
                    This choice applies to every task. Balanced is the recommended default and does not require extra software.
                  </p>
                  {overlayCfg.mode === 'long' ? (
                    <div style={{ fontSize: 11, color: '#6d4d13', lineHeight: 1.5, background: '#fff8e8', border: '1px solid #ead39b', borderRadius: 6, padding: '8px 10px' }}>
                      Maximum savings needs local Ollama or a configured cloud model. Cloud summaries can cost money and send older conversation content to that provider.
                    </div>
                  ) : null}
                </fieldset>

                {/* Common Actions */}
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
                        minHeight: 42,
                        fontSize: 12,
                        lineHeight: 1.25,
                        background: '#ffffff',
                        border: '1px solid #94a3b8',
                        borderRadius: 8,
                        cursor: saving || previewing ? 'not-allowed' : 'pointer',
                        color: '#0f172a',
                        fontWeight: 650,
                        opacity: saving || previewing ? 0.5 : 1,
                        boxShadow: '0 1px 2px rgba(15,23,42,0.05)',
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                {/* Setup Readiness Inspector */}
                {checkingSetup || setupReadiness ? (
                  <section
                    role="status"
                    aria-label="Setup readiness"
                    aria-live="polite"
                    aria-busy={checkingSetup}
                    style={{
                      padding: 14,
                      border: '1px solid #b8d8e8',
                      borderRadius: 10,
                      background: '#eef7fb',
                      color: '#34424a',
                      fontSize: 12,
                      lineHeight: 1.5,
                    }}
                  >
                    <h2 style={{ margin: '0 0 10px', fontSize: 14 }}>{checkingSetup ? 'Checking setup...' : 'Setup readiness'}</h2>
                    {checkingSetup ? (
                      <p style={{ margin: 0 }}>Checking the current settings. No summary will be generated.</p>
                    ) : (
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

                {/* Structured Command Result Inspector */}
                {commandResult ? (
                  <div
                    role="status"
                    style={{
                      padding: commandResult.cmd === 'stats' && commandResult.ok ? '12px 14px' : '10px 12px',
                      fontSize: 12,
                      lineHeight: 1.45,
                      background: commandResult.ok ? '#f4fbf5' : '#fdf1f1',
                      border: `1px solid ${commandResult.ok ? '#b9ddc5' : '#e6b7b7'}`,
                      borderRadius: 10,
                      color: commandResult.ok ? '#1e4620' : '#7a1f1f',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 700, fontSize: 13, color: commandResult.ok ? '#19633b' : '#8a2d24' }}>
                          {commandResult.cmd === 'stats' && commandResult.ok ? 'Savings & Usage Breakdown' : 'Command Output'}
                        </span>
                        <span
                          style={{
                            fontSize: 10,
                            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                            background: 'rgba(15,23,42,0.08)',
                            padding: '2px 6px',
                            borderRadius: 4,
                            color: '#1e293b',
                          }}
                        >
                          /broke {commandResult.cmd}
                        </span>
                      </div>
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
                      <pre
                        style={{
                          margin: 0,
                          fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                          fontSize: 11.5,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          maxHeight: 220,
                          overflowY: 'auto',
                          background: 'rgba(255,255,255,0.75)',
                          padding: '8px 10px',
                          borderRadius: 6,
                          border: '1px solid rgba(15,23,42,0.08)',
                        }}
                      >
                        {commandResult.text}
                      </pre>
                    )}
                  </div>
                ) : null}

                {/* Progressive Disclosure: Deep Pipeline Controls & Full Command Studio */}
                <details
                  open={advancedOpen}
                  onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
                  style={{ borderTop: '1px solid #e2e8f0', paddingTop: 14 }}
                >
                  <summary style={{ cursor: 'pointer', color: '#0f172a', fontSize: 13, fontWeight: 700, padding: '4px 0' }}>
                    Advanced settings and diagnostics
                  </summary>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 12 }}>
                    <p style={{ margin: 0, color: '#475569', fontSize: 12 }}>
                      The selftest below exercises synthetic input with a stub summarizer. It does not check the configured backend or model.
                    </p>

                    {/* Core Expert Settings */}
                    <fieldset
                      disabled={saving}
                      onChangeCapture={invalidatePreview}
                      style={{
                        border: '1px solid #e2e8f0',
                        borderRadius: 8,
                        padding: 12,
                        margin: 0,
                        background: '#f8fafc',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 12,
                      }}
                    >
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontWeight: 600, fontSize: 12, color: '#0f172a' }}>
                        Broke automation
                        <select value={overlayCfg.autonomy ?? 'autonomous'} onChange={(e) => patchOverlay({ autonomy: e.target.value })} style={{ ...selectStyle, marginTop: 4 }}>
                          <option value="autonomous">Autonomous - follow feature switches</option>
                          <option value="manual">Manual - no automatic LLM calls or stored-history rewrites</option>
                        </select>
                      </label>
                      <p style={{ fontSize: 11, color: '#64748b', margin: 0, lineHeight: 1.5 }}>
                        Host agent permissions are unchanged. Manual also pauses automatic snapshots and index refreshes; explicit commands still work.
                      </p>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontWeight: 600, fontSize: 12, color: '#0f172a' }}>
                        Compression level
                        <select value={overlayCfg.level ?? 'truncate'} onChange={(e) => patchOverlay({ level: e.target.value })} style={{ ...selectStyle, marginTop: 4 }}>
                          <option value="structural">Structural - content-preserving only</option>
                          <option value="truncate">Truncate - + truncation of old tool outputs</option>
                          <option value="summarize">Summarize - + LLM summary (needs backend)</option>
                        </select>
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontWeight: 600, fontSize: 12, color: '#0f172a' }}>
                        Answer brevity
                        <select value={overlayBrevity.level ?? 'off'} onChange={(e) => patchOverlay({ brevity: { ...overlayBrevity, level: e.target.value } })} style={{ ...selectStyle, marginTop: 4 }}>
                          <option value="off">Off - normal responses</option>
                          <option value="lite">Lite - concise prose, no filler</option>
                          <option value="full">Full - terse caveman-style fragments</option>
                          <option value="ultra">Ultra - maximum telegraphic compression</option>
                        </select>
                      </label>
                      <div style={{ display: 'flex', gap: 12 }}>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, fontWeight: 600, fontSize: 12, color: '#0f172a' }}>
                          Max context chars
                          <input
                            key={overlayCfg.maxContextChars}
                            type="number"
                            min="1"
                            defaultValue={String(overlayCfg.maxContextChars ?? 60000)}
                            onBlur={numberCommit('maxContextChars', 60000)}
                            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                            style={{ ...inputStyle, marginTop: 4 }}
                          />
                        </label>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, fontWeight: 600, fontSize: 12, color: '#0f172a' }}>
                          Protected turns
                          <input
                            key={overlayCfg.protectedTurns}
                            type="number"
                            min="1"
                            max="50"
                            defaultValue={String(overlayCfg.protectedTurns ?? 2)}
                            onBlur={numberCommit('protectedTurns', 2, 50)}
                            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                            style={{ ...inputStyle, marginTop: 4 }}
                          />
                        </label>
                      </div>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontWeight: 600, fontSize: 12, color: '#0f172a' }} title="Auto detects the cache rules from the task model.">
                        Cache profile (prompt-cache friendly mode)
                        <select value={overlayCache.profile ?? 'off'} onChange={(e) => patchOverlay({ cache: { ...overlayCache, profile: e.target.value } })} style={{ ...selectStyle, marginTop: 4 }}>
                          <option value="off">Off - plain behavior</option>
                          <option value="auto">Auto - detect from task model (recommended)</option>
                          <option value="anthropic">Anthropic - Claude models</option>
                          <option value="openai">OpenAI - GPT/o-models</option>
                        </select>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }} title="Allows one cache-invalidating rewrite on a real budget overrun.">
                        <input
                          type="checkbox"
                          checked={overlayCache.escapeHatch ?? true}
                          onChange={(e) => patchOverlay({ cache: { ...overlayCache, escapeHatch: e.target.checked } })}
                          style={{ width: 16, height: 16, accentColor: '#0066cc', cursor: 'pointer' }}
                        />
                        <span style={{ fontSize: 12.5, color: '#0f172a' }}>Escape hatch on budget overruns</span>
                      </label>
                      <div style={{ fontSize: 11, color: '#64748b' }}>Full configuration: AiderDesk settings → Extensions → Broke.</div>
                    </fieldset>

                    {/* Command Studio: 100% UI Command Coverage */}
                    <div
                      style={{
                        border: '1px solid #cbd5e1',
                        borderRadius: 10,
                        padding: 14,
                        background: '#ffffff',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 14,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                        <div>
                          <div style={{ fontWeight: 750, fontSize: 13, color: '#0f172a' }}>Command Studio — Run Any /broke Command</div>
                          <div style={{ fontSize: 11, color: '#64748b' }}>Read-only commands run immediately; state-changing commands arm for confirmation.</div>
                        </div>
                      </div>

                      {/* Category Filter Pills */}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                        {[
                          { id: 'all', label: 'All Commands' },
                          { id: 'diag', label: 'Diagnostics' },
                          { id: 'snap', label: 'Snapshots & Flush' },
                          { id: 'search', label: 'Search & Slice' },
                          { id: 'pipe', label: 'Pipeline & Archives' },
                          { id: 'sys', label: 'Config & Updates' },
                        ].map((cat) => (
                          <button
                            key={cat.id}
                            type="button"
                            onClick={() => setCmdCategory(cat.id)}
                            disabled={saving || previewing}
                            style={{
                              padding: '4px 9px',
                              fontSize: 11,
                              fontWeight: cmdCategory === cat.id ? 700 : 500,
                              borderRadius: 99,
                              border: `1px solid ${cmdCategory === cat.id ? '#0f172a' : '#cbd5e1'}`,
                              background: cmdCategory === cat.id ? '#0f172a' : '#f8fafc',
                              color: cmdCategory === cat.id ? '#ffffff' : '#334155',
                              cursor: 'pointer',
                            }}
                          >
                            {cat.label}
                          </button>
                        ))}
                      </div>

                      {/* 1-Click Quick Command Grid */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(145px, 1fr))', gap: 7 }}>
                        {visibleQuickCommands.map((item) => {
                          const armed = pendingCommand === item.cmd;
                          const mutating = isMutatingCommand(item.cmd);
                          const isRunning = executingCmd === item.cmd;
                          return (
                            <button
                              key={item.cmd}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void runQuickCommand(item.cmd);
                              }}
                              disabled={saving || previewing || executingCmd !== null}
                              style={{
                                padding: '7px 9px',
                                fontSize: 11.5,
                                background: isRunning ? '#e0f2fe' : armed ? '#fff3cd' : '#ffffff',
                                border: `1px solid ${isRunning ? '#0284c7' : armed ? '#d4a017' : '#cbd5e1'}`,
                                borderRadius: 6,
                                cursor: saving || previewing || executingCmd !== null ? 'not-allowed' : 'pointer',
                                color: isRunning ? '#0369a1' : armed ? '#7a5c00' : '#0f172a',
                                textAlign: 'left',
                                fontWeight: 500,
                                opacity: saving || previewing || (executingCmd !== null && !isRunning) ? 0.5 : 1,
                                transition: 'all 0.15s ease',
                                boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
                              }}
                              onMouseEnter={(e) => {
                                if (!saving && !previewing && !executingCmd && !armed) {
                                  e.currentTarget.style.background = '#f0f7ff';
                                  e.currentTarget.style.borderColor = '#0066cc';
                                  e.currentTarget.style.color = '#0066cc';
                                }
                              }}
                              onMouseLeave={(e) => {
                                if (!saving && !previewing && !executingCmd && !armed) {
                                  e.currentTarget.style.background = '#ffffff';
                                  e.currentTarget.style.borderColor = '#cbd5e1';
                                  e.currentTarget.style.color = '#0f172a';
                                }
                              }}
                              title={isRunning ? `Running /broke ${item.label}...` : armed ? 'Click again to run this command' : mutating ? `${item.desc} - needs a second click to confirm` : item.desc}
                            >
                              {isRunning ? (
                                <>Running <span style={{ fontWeight: 700 }}>/broke {item.label}...</span></>
                              ) : armed ? (
                                <>Confirm? <span style={{ fontWeight: 700 }}>/broke {item.label}</span></>
                              ) : (
                                <>/broke <span style={{ fontWeight: 700 }}>{item.label}</span></>
                              )}
                            </button>
                          );
                        })}
                      </div>

                      {/* Parameterized Command Workbench */}
                      <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{ fontWeight: 700, fontSize: 12, color: '#0f172a' }}>Parameterized Command Builders</div>

                        {/* 1. Local Project Search & Diff Digest */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
                          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 7, padding: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <span style={{ fontSize: 11, fontWeight: 650, color: '#334155' }}>Local Search (broke-search)</span>
                            <div style={{ display: 'flex', gap: 5 }}>
                              <input
                                ref={searchInputRef}
                                type="text"
                                aria-label="Search query"
                                placeholder="Query (e.g. compressMessages)"
                                defaultValue={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                onBlur={(e) => setSearchQuery(e.target.value)}
                                style={inputStyle}
                              />
                              <button
                                type="button"
                                disabled={saving || previewing || executingCmd !== null}
                                onClick={() => {
                                  const q = (searchInputRef.current?.value ?? searchQuery).trim();
                                  if (q) void runQuickCommand(`search ${q}`);
                                }}
                                style={{ ...buttonStyle, fontWeight: 650, whiteSpace: 'nowrap' }}
                              >
                                Run search
                              </button>
                            </div>
                          </div>

                          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 7, padding: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <span style={{ fontSize: 11, fontWeight: 650, color: '#334155' }}>Diff Digest Budget (chars)</span>
                            <div style={{ display: 'flex', gap: 5 }}>
                              <input
                                ref={diffInputRef}
                                type="number"
                                aria-label="Diff char budget"
                                min="500"
                                max="40000"
                                defaultValue={diffBudget}
                                onChange={(e) => setDiffBudget(e.target.value)}
                                onBlur={(e) => setDiffBudget(e.target.value)}
                                style={inputStyle}
                              />
                              <button
                                type="button"
                                disabled={saving || previewing || executingCmd !== null}
                                onClick={() => {
                                  const b = (diffInputRef.current?.value ?? diffBudget).trim();
                                  void runQuickCommand(b ? `diff ${b}` : 'diff');
                                }}
                                style={{ ...buttonStyle, fontWeight: 650, whiteSpace: 'nowrap' }}
                              >
                                Run diff
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* 2. Snapshots & Flush Undo */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
                          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 7, padding: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <span style={{ fontSize: 11, fontWeight: 650, color: '#334155' }}>Record Labeled Snapshot</span>
                            <div style={{ display: 'flex', gap: 5 }}>
                              <input
                                ref={snapshotLabelRef}
                                type="text"
                                aria-label="Snapshot label"
                                placeholder="Label (optional)"
                                defaultValue={snapshotLabel}
                                onChange={(e) => setSnapshotLabel(e.target.value)}
                                onBlur={(e) => setSnapshotLabel(e.target.value)}
                                style={inputStyle}
                              />
                              <button
                                type="button"
                                disabled={saving || previewing || executingCmd !== null}
                                onClick={() => {
                                  const lbl = (snapshotLabelRef.current?.value ?? snapshotLabel).trim();
                                  const cmd = lbl ? `snapshot ${lbl}` : 'snapshot';
                                  void runQuickCommand(cmd);
                                }}
                                style={{ ...buttonStyle, fontWeight: 650, whiteSpace: 'nowrap' }}
                              >
                                {executingCmd === ((snapshotLabelRef.current?.value ?? snapshotLabel).trim() ? `snapshot ${(snapshotLabelRef.current?.value ?? snapshotLabel).trim()}` : 'snapshot')
                                  ? 'Saving...'
                                  : pendingCommand === ((snapshotLabelRef.current?.value ?? snapshotLabel).trim() ? `snapshot ${(snapshotLabelRef.current?.value ?? snapshotLabel).trim()}` : 'snapshot')
                                  ? 'Confirm?'
                                  : 'Save snapshot'}
                              </button>
                            </div>
                          </div>

                          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 7, padding: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <span style={{ fontSize: 11, fontWeight: 650, color: '#334155' }}>Inspect or Restore Snapshot #</span>
                            <div style={{ display: 'flex', gap: 5 }}>
                              <input
                                ref={snapshotIndexRef}
                                type="number"
                                aria-label="Snapshot number"
                                min="1"
                                defaultValue={snapshotIndex}
                                onChange={(e) => setSnapshotIndex(e.target.value)}
                                onBlur={(e) => setSnapshotIndex(e.target.value)}
                                style={{ ...inputStyle, width: 64 }}
                              />
                              <button
                                type="button"
                                disabled={saving || previewing || executingCmd !== null}
                                onClick={() => {
                                  const idx = (snapshotIndexRef.current?.value ?? snapshotIndex).trim() || '1';
                                  void runQuickCommand(`snapshot show ${idx}`);
                                }}
                                style={{ ...buttonStyle, fontWeight: 650, whiteSpace: 'nowrap' }}
                              >
                                Show #
                              </button>
                              <button
                                type="button"
                                disabled={saving || previewing || executingCmd !== null}
                                onClick={() => {
                                  const idx = (snapshotIndexRef.current?.value ?? snapshotIndex).trim() || '1';
                                  void runQuickCommand(`flush --undo ${idx}`);
                                }}
                                style={{ ...buttonStyle, fontWeight: 650, whiteSpace: 'nowrap' }}
                              >
                                {executingCmd === `flush --undo ${(snapshotIndexRef.current?.value ?? snapshotIndex).trim() || '1'}`
                                  ? 'Undoing...'
                                  : pendingCommand === `flush --undo ${(snapshotIndexRef.current?.value ?? snapshotIndex).trim() || '1'}`
                                  ? 'Confirm undo?'
                                  : 'Undo flush #'}
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* 3. ST-Slicing Focus & Per-Tool Truncation Rule */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
                          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 7, padding: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <span style={{ fontSize: 11, fontWeight: 650, color: '#334155' }}>ST-Slicing Focus File Path</span>
                            <div style={{ display: 'flex', gap: 5 }}>
                              <input
                                ref={sliceFocusRef}
                                type="text"
                                aria-label="Slice focus path"
                                placeholder="src/index.ts"
                                defaultValue={sliceFocusPath}
                                onChange={(e) => setSliceFocusPath(e.target.value)}
                                onBlur={(e) => setSliceFocusPath(e.target.value)}
                                style={inputStyle}
                              />
                              <button
                                type="button"
                                disabled={saving || previewing || executingCmd !== null}
                                onClick={() => {
                                  const p = (sliceFocusRef.current?.value ?? sliceFocusPath).trim();
                                  if (p) void runQuickCommand(`slice focus ${p}`);
                                }}
                                style={{ ...buttonStyle, fontWeight: 650, whiteSpace: 'nowrap' }}
                              >
                                {executingCmd === `slice focus ${(sliceFocusRef.current?.value ?? sliceFocusPath).trim()}`
                                  ? 'Setting...'
                                  : pendingCommand === `slice focus ${(sliceFocusRef.current?.value ?? sliceFocusPath).trim()}`
                                  ? 'Confirm?'
                                  : 'Set focus'}
                              </button>
                            </div>
                          </div>

                          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 7, padding: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <span style={{ fontSize: 11, fontWeight: 650, color: '#334155' }}>Per-Tool Truncation (tool · lines · KB)</span>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <input
                                ref={toolNameRef}
                                type="text"
                                aria-label="Truncation tool name"
                                placeholder="bash"
                                defaultValue={toolRuleName}
                                onChange={(e) => setToolRuleName(e.target.value)}
                                onBlur={(e) => setToolRuleName(e.target.value)}
                                style={{ ...inputStyle, flex: 1.2 }}
                              />
                              <input
                                ref={toolLinesRef}
                                type="number"
                                aria-label="Truncation tool lines"
                                min="1"
                                defaultValue={toolRuleLines}
                                onChange={(e) => setToolRuleLines(e.target.value)}
                                onBlur={(e) => setToolRuleLines(e.target.value)}
                                style={{ ...inputStyle, width: 58 }}
                              />
                              <input
                                ref={toolKBRef}
                                type="number"
                                aria-label="Truncation tool KB"
                                min="1"
                                defaultValue={toolRuleKB}
                                onChange={(e) => setToolRuleKB(e.target.value)}
                                onBlur={(e) => setToolRuleKB(e.target.value)}
                                style={{ ...inputStyle, width: 52 }}
                              />
                              <button
                                type="button"
                                disabled={saving || previewing || executingCmd !== null || !(toolNameRef.current?.value ?? toolRuleName).trim()}
                                onClick={() => {
                                  const t = (toolNameRef.current?.value ?? toolRuleName).trim();
                                  const l = (toolLinesRef.current?.value ?? toolRuleLines).trim() || '200';
                                  const k = (toolKBRef.current?.value ?? toolRuleKB).trim() || '20';
                                  if (t) void runQuickCommand(`truncate tool ${t} ${l} ${k}`);
                                }}
                                style={{ ...buttonStyle, padding: '6px 8px', fontWeight: 650 }}
                              >
                                {executingCmd === `truncate tool ${(toolNameRef.current?.value ?? toolRuleName).trim()} ${(toolLinesRef.current?.value ?? toolRuleLines).trim() || '200'} ${(toolKBRef.current?.value ?? toolRuleKB).trim() || '20'}`
                                  ? 'Applying...'
                                  : pendingCommand === `truncate tool ${(toolNameRef.current?.value ?? toolRuleName).trim()} ${(toolLinesRef.current?.value ?? toolRuleLines).trim() || '200'} ${(toolKBRef.current?.value ?? toolRuleKB).trim() || '20'}`
                                  ? 'Confirm?'
                                  : 'Apply rule'}
                              </button>
                              <button
                                type="button"
                                disabled={saving || previewing || executingCmd !== null || !(toolNameRef.current?.value ?? toolRuleName).trim()}
                                onClick={() => {
                                  const t = (toolNameRef.current?.value ?? toolRuleName).trim();
                                  if (t) void runQuickCommand(`truncate tool ${t} reset`);
                                }}
                                style={{ ...buttonStyle, padding: '6px 8px' }}
                                title="Reset tool rule to global limits"
                              >
                                {executingCmd === `truncate tool ${(toolNameRef.current?.value ?? toolRuleName).trim()} reset`
                                  ? 'Resetting...'
                                  : pendingCommand === `truncate tool ${(toolNameRef.current?.value ?? toolRuleName).trim()} reset`
                                  ? 'Confirm?'
                                  : 'Reset rule'}
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* 4. Config Path Get/Set & Version Pin Update */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
                          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 7, padding: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <span style={{ fontSize: 11, fontWeight: 650, color: '#334155' }}>Config Key Inspector (get / set)</span>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <input
                                ref={configPathRef}
                                type="text"
                                aria-label="Config key path"
                                placeholder="flush.confirm"
                                defaultValue={configPathInput}
                                onChange={(e) => setConfigPathInput(e.target.value)}
                                onBlur={(e) => setConfigPathInput(e.target.value)}
                                style={{ ...inputStyle, flex: 1.2 }}
                              />
                              <input
                                ref={configValueRef}
                                type="text"
                                aria-label="Config key value"
                                placeholder="value"
                                defaultValue={configValueInput}
                                onChange={(e) => setConfigValueInput(e.target.value)}
                                onBlur={(e) => setConfigValueInput(e.target.value)}
                                style={{ ...inputStyle, flex: 1 }}
                              />
                              <button
                                type="button"
                                disabled={saving || previewing || executingCmd !== null}
                                onClick={() => {
                                  const p = (configPathRef.current?.value ?? configPathInput).trim();
                                  if (p) void runQuickCommand(`config get ${p}`);
                                }}
                                style={{ ...buttonStyle, padding: '6px 8px', fontWeight: 650 }}
                              >
                                Get key
                              </button>
                              <button
                                type="button"
                                disabled={saving || previewing || executingCmd !== null}
                                onClick={() => {
                                  const p = (configPathRef.current?.value ?? configPathInput).trim();
                                  const v = (configValueRef.current?.value ?? configValueInput).trim();
                                  if (p && v) void runQuickCommand(`config set ${p} ${v}`);
                                }}
                                style={{ ...buttonStyle, padding: '6px 8px', fontWeight: 650 }}
                              >
                                {executingCmd === `config set ${(configPathRef.current?.value ?? configPathInput).trim()} ${(configValueRef.current?.value ?? configValueInput).trim()}`
                                  ? 'Setting...'
                                  : pendingCommand === `config set ${(configPathRef.current?.value ?? configPathInput).trim()} ${(configValueRef.current?.value ?? configValueInput).trim()}`
                                  ? 'Confirm?'
                                  : 'Set key'}
                              </button>
                            </div>
                          </div>

                          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 7, padding: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <span style={{ fontSize: 11, fontWeight: 650, color: '#334155' }}>Pin / Rollback Version Tag</span>
                            <div style={{ display: 'flex', gap: 5 }}>
                              <input
                                ref={updateTagRef}
                                type="text"
                                aria-label="Release version tag"
                                placeholder="v1.4.0"
                                defaultValue={updateTagInput}
                                onChange={(e) => setUpdateTagInput(e.target.value)}
                                onBlur={(e) => setUpdateTagInput(e.target.value)}
                                style={inputStyle}
                              />
                              <button
                                type="button"
                                disabled={saving || previewing || executingCmd !== null}
                                onClick={() => {
                                  const tag = (updateTagRef.current?.value ?? updateTagInput).trim();
                                  if (tag) void runQuickCommand(`update ${tag}`);
                                }}
                                style={{ ...buttonStyle, fontWeight: 650, whiteSpace: 'nowrap' }}
                              >
                                {executingCmd === `update ${(updateTagRef.current?.value ?? updateTagInput).trim()}`
                                  ? 'Installing...'
                                  : pendingCommand === `update ${(updateTagRef.current?.value ?? updateTagInput).trim()}`
                                  ? 'Confirm?'
                                  : 'Install tag'}
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* 5. Universal Command Bar */}
                        <div style={{ background: '#0f172a', borderRadius: 8, padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12, color: '#38bdf8', fontWeight: 700 }}>/broke</span>
                          <input
                            ref={customCmdRef}
                            type="text"
                            aria-label="Universal broke command"
                            placeholder="Type any subcommand (e.g. truncate 150 15, errors minchars 6000, summarize after 6)..."
                            defaultValue={customCmdInput}
                            onChange={(e) => setCustomCmdInput(e.target.value)}
                            onBlur={(e) => setCustomCmdInput(e.target.value)}
                            onKeyDown={(e) => {
                              const val = (customCmdRef.current?.value ?? customCmdInput).trim();
                              if (e.key === 'Enter' && val) {
                                e.preventDefault();
                                void runQuickCommand(val);
                              }
                            }}
                            style={{
                              ...inputStyle,
                              background: '#1e293b',
                              color: '#f8fafc',
                              border: '1px solid #334155',
                              fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                            }}
                          />
                          <button
                            type="button"
                            disabled={saving || previewing || executingCmd !== null}
                            onClick={() => {
                              const val = (customCmdRef.current?.value ?? customCmdInput).trim();
                              if (val) void runQuickCommand(val);
                            }}
                            style={{
                              ...buttonStyle,
                              background: '#0284c7',
                              color: '#ffffff',
                              border: '1px solid #0369a1',
                              fontWeight: 700,
                              whiteSpace: 'nowrap',
                              
                            }}
                          >
                            {executingCmd === (customCmdRef.current?.value ?? customCmdInput).trim().replace(/^\/?broke\b\s*/i, '')
                              ? 'Executing...'
                              : pendingCommand && pendingCommand === (customCmdRef.current?.value ?? customCmdInput).trim().replace(/^\/?broke\b\s*/i, '')
                              ? 'Confirm execute?'
                              : 'Execute'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </details>
              </>
            )}

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', borderTop: '1px solid #e2e8f0', paddingTop: 14, marginTop: 2 }}>
              <button
                type="button"
                onClick={closeOverlay}
                disabled={saving}
                style={{
                  padding: '8px 16px',
                  fontSize: 13,
                  fontWeight: 500,
                  background: '#f8fafc',
                  border: '1px solid #cbd5e1',
                  borderRadius: 6,
                  cursor: 'pointer',
                  color: '#334155',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#e2e8f0'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = '#f8fafc'; }}
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
