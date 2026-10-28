/** Release host directory handles for swaps and restore observation on every exit. */
import { runUpdate, type UpdateHooks, type UpdateRequest, type UpdateResult } from './update';

interface WatcherLifecycle {
  closeWatcher: () => void;
  startWatcher: () => void;
  progress: (line: string) => void;
}
type UpdateRunner = (request: UpdateRequest, hooks: UpdateHooks) => Promise<UpdateResult>;

export async function runUpdateWithLifecycle(request: UpdateRequest, lifecycle: WatcherLifecycle, runner: UpdateRunner = runUpdate): Promise<UpdateResult> {
  let closed = false;
  try {
    return await runner(request, {
      onBeforeSwap: () => { lifecycle.closeWatcher(); closed = true; },
      onAfterSwap: () => { lifecycle.startWatcher(); closed = false; },
      progress: lifecycle.progress,
    });
  } finally {
    if (closed) {
      lifecycle.startWatcher();
      lifecycle.progress('broke: config watcher restored after failed update');
    }
  }
}
