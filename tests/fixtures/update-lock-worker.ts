import { renameSync } from 'node:fs';
import { acquireUpdateLock, releaseUpdateLock, type UpdateLockClaim } from '../../update-lock';

let claim: UpdateLockClaim | undefined;
process.on('message', (command: { kind: string; install: string }) => {
  if (command.kind === 'acquire') {
    const result = acquireUpdateLock(command.install);
    if (result.ok) claim = result.claim;
    process.send?.(result);
  } else if (command.kind === 'swap') {
    renameSync(command.install, `${command.install}.old`);
    process.send?.({ ok: true });
  } else if (command.kind === 'release') {
    process.send?.({ ok: claim ? releaseUpdateLock(claim) : false });
  }
});
