import type { ChangeEntry } from '@git-view/contracts';

export function matchesFileFilter(entry: Pick<ChangeEntry, 'path' | 'oldPath'>, filter: string): boolean {
  const query = filter.trim().toLocaleLowerCase();
  return !query || entry.path.toLocaleLowerCase().includes(query) || Boolean(entry.oldPath?.toLocaleLowerCase().includes(query));
}
