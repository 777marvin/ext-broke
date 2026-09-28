/*
 * Per-message "broke: why" row for the host's message dropdown menu
 * (AiderDesk 0.85's `task-message-bar-menu` placement).
 *
 * The host mounts a component at this placement once per FINISHED message,
 * so this file is written to cost as close to nothing per instance as a
 * component can:
 *   - it is registered with `loadData: false`, so no per-message data fetch
 *     (an IPC round-trip per message on a long task is exactly the kind of
 *     cost that makes an extension feel broken);
 *   - it reads NO props beyond the action dispatcher and ignores the `message`
 *     the host hands it - no history access, no per-message computation;
 *   - it holds one piece of state (armed/ran) for the feedback the host's
 *     menu gives no room for.
 *
 * A menu item cannot show a report, so `why` - whose output is a multi-line
 * gate-by-gate verdict - cannot render here. The row therefore runs the
 * command and says so honestly: the report lands in the task log, which is
 * where `/broke why` has always written it.
 */
({ executeExtensionAction }) => {
  const [state, setState] = React.useState('idle');

  const run = async () => {
    if (state === 'running') return;
    setState('running');
    try {
      const res = (await executeExtensionAction?.('runCommand', 'broke why')) as
        | { ok?: boolean; message?: string; error?: string }
        | undefined;
      if (res?.ok === true) setState('logged');
      else setState('failed');
    } catch {
      setState('failed');
    }
  };

  const label = state === 'running' ? 'broke: running…' : state === 'logged' ? 'broke: logged to the task' : state === 'failed' ? 'broke: failed (see the task log)' : 'broke: why';
  const style = { display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 0, cursor: state === 'running' ? 'wait' : 'pointer', color: 'inherit', font: 'inherit', padding: 0 } as const;

  return (
    <button type="button" onClick={run} disabled={state === 'running'} style={style} title="/broke why - the gate-by-gate verdict for this task, written to the task log">
      {label}
    </button>
  );
};
