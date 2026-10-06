import { watch, type FSWatcher } from 'node:fs';
import type { WatchState } from '../../shared/transport';
import type { RepositoryIdentity } from '@git-view/contracts';

const MAX_WATCHED_WORKTREES = 32;
type Entry = WatchState & { handles: FSWatcher[] };
/** Events invalidate observations. They never claim which Git fact changed. */
export class RepositoryWatchers {
  private entries = new Map<string, Entry>();
  state(repository: RepositoryIdentity): WatchState {
    let entry = this.entries.get(repository.worktreeId);
    if (!entry) {
      if (this.entries.size >= MAX_WATCHED_WORKTREES) this.remove(this.entries.keys().next().value!);
      entry = { revision: 0, watching: true, handles: [] };
      const current = entry;
      for (const path of new Set([repository.worktreeRoot, repository.gitDir, repository.commonGitDir])) {
        try {
          const handle = watch(path, { recursive: true, persistent: false }, () => { current.revision++; });
          handle.on('error', () => { current.watching = false; current.revision++; });
          current.handles.push(handle);
        } catch { current.watching = false; }
      }
      this.entries.set(repository.worktreeId, entry);
    } else {
      this.entries.delete(repository.worktreeId); this.entries.set(repository.worktreeId, entry);
    }
    return { revision: entry.revision, watching: entry.watching };
  }
  private remove(id: string) { this.entries.get(id)?.handles.forEach(handle => handle.close()); this.entries.delete(id); }
  close() { for (const id of this.entries.keys()) this.remove(id); }
}
