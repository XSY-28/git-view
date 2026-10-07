import { watch, type FSWatcher } from 'node:fs';
import type { WatchState } from '../../shared/transport';
import type { RepositoryIdentity } from '@git-view/contracts';
import { watchFingerprint } from './watch-fingerprint';

const MAX_WATCHED_WORKTREES = 32;
type Entry = WatchState & { handles: FSWatcher[]; dirty: boolean; baselineInvalidated: boolean; controller: AbortController; fingerprint?: string; pending?: Promise<void> };
/** Filesystem events request an observation; only a changed observation invalidates reads. */
export class RepositoryWatchers {
  private entries = new Map<string, Entry>();
  async state(repository: RepositoryIdentity): Promise<WatchState> {
    let entry = this.entries.get(repository.worktreeId);
    if (!entry) {
      if (this.entries.size >= MAX_WATCHED_WORKTREES) this.remove(this.entries.keys().next().value!);
      entry = { revision: 0, watching: true, handles: [], dirty: true, baselineInvalidated: false, controller: new AbortController() };
      const current = entry;
      for (const path of new Set([repository.worktreeRoot, repository.gitDir, repository.commonGitDir])) {
        try {
          const handle = watch(path, { recursive: true, persistent: false }, () => { current.dirty = true; });
          handle.on('error', () => { current.watching = false; current.revision++; });
          current.handles.push(handle);
        } catch { current.watching = false; }
      }
      this.entries.set(repository.worktreeId, entry);
    } else {
      this.entries.delete(repository.worktreeId); this.entries.set(repository.worktreeId, entry);
    }
    const current = entry;
    if (current.watching && current.dirty && !current.pending) {
      current.dirty = false;
      current.pending = watchFingerprint(repository, current.controller.signal).then(fingerprint => {
        if (current.controller.signal.aborted) return;
        if (current.fingerprint === undefined) current.baselineInvalidated = current.dirty;
        else {
          if (current.baselineInvalidated || current.fingerprint !== fingerprint) current.revision++;
          current.baselineInvalidated = false;
        }
        current.fingerprint = fingerprint;
      }).catch(() => {
        if (!current.controller.signal.aborted) { current.watching = false; current.revision++; }
      }).finally(() => { current.pending = undefined; });
    }
    // Concurrent focus/poll requests share the same scan. Events arriving during
    // it remain dirty for the next poll, rather than extending it indefinitely.
    await current.pending;
    return { revision: entry.revision, watching: entry.watching };
  }
  private remove(id: string) { const entry = this.entries.get(id); entry?.controller.abort(); entry?.handles.forEach(handle => handle.close()); this.entries.delete(id); }
  close() { for (const id of this.entries.keys()) this.remove(id); }
}
