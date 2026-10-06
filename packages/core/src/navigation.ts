import { navigationSchema, type GitAdapter, type RepositoryIdentity } from '@git-view/contracts';

/** Navigation is a query; choosing a returned worktree still opens a canonical session. */
export async function readNavigation(adapter: GitAdapter, repository: RepositoryIdentity, signal?: AbortSignal) {
  return navigationSchema.parse(await adapter.listNavigation(repository, signal));
}
