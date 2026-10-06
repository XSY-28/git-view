import { isAbsolute } from 'node:path';
import { QueryError, toAppError, type ApiRequest, type ApiResponse, type RepositorySession, type OperationRequest } from '@git-view/contracts';
import { createGitAdapter } from '@git-view/git-cli';
import { createOperations } from '../../../packages/operations/src/index';
import { RecentStore, ensurePrivateDirectory } from './storage';
import { RepositoryWatchers } from './watch';

export interface RepositoryQueries {
  open(path: string, signal?: AbortSignal): Promise<RepositorySession>;
  execute(request: ApiRequest, signal?: AbortSignal): Promise<ApiResponse>;
  getSession(id: string): RepositorySession;
  suspendWorktree?(worktreeId: string): () => void;
  close?(): void;
}
export const failure = (error: unknown, requestId = 'transport'): ApiResponse => ({ schemaVersion: 1, ok: false, error: toAppError(error), requestId, finishedAt: new Date().toISOString() });
export const success = (data: unknown) => ({ schemaVersion: 1 as const, ok: true as const, data });
/** Host-independent application operations; authentication and dialogs belong to each host. */
export async function createLocalService(queries: RepositoryQueries, directory: string) {
  await ensurePrivateDirectory(directory);
  const recents = new RecentStore(directory); await recents.load();
  const watchers = new RepositoryWatchers();
  const operations = await createOperations({ directory, read: createGitAdapter() });
  return {
    recents,
    session: (id: string) => success(queries.getSession(id)),
    watch: (id: string) => success(watchers.state(queries.getSession(id).repository)),
    async operation(request: OperationRequest, signal?: AbortSignal) {
      const session = queries.getSession(request.sessionId);
      if (request.action === 'preview') return success(await operations.preview(session, { kind: request.kind, entryIds: request.entryIds, fingerprint: request.fingerprint }, signal));
      if (request.action === 'receipt') return success(await operations.receipt(session, request.operationId));
      if (request.action === 'pending') return success(await operations.pending(session));
      // Once submitted, losing a transport must not cancel or repeat a write.
      const resume = queries.suspendWorktree?.(session.repository.worktreeId);
      try { return success(await operations.execute(session, request.previewId, request.operationId)); }
      finally { resume?.(); }
    },
    async request(request: ApiRequest, signal?: AbortSignal) {
      if (request.action === 'recents') return success(recents.list());
      if (request.action === 'heartbeat') return success({ alive: true });
      if (request.action === 'open') {
        if (!isAbsolute(request.path) || request.path.includes('\0')) throw new QueryError('INVALID_REQUEST', '请提供明确的本机绝对路径。');
        const session = await queries.open(request.path, signal);
        await recents.add(session.repository);
        return success(session);
      }
      return queries.execute(request, signal);
    },
    close() { watchers.close(); queries.close?.(); },
  };
}
