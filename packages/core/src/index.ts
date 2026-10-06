import { randomUUID } from 'node:crypto';
import { QueryError, queryKey, toAppError, overviewSchema, type ApiRequest, type ApiResponse, type GitAdapter, type ReadStamp, type RepositorySession, type RawOverview, type CommitDetail } from '@git-view/contracts';
import { explain } from './explanations';
import { historyFilterKey } from '@git-view/contracts';
import { readNavigation } from './navigation';
export { explain } from './explanations';

type State = { session: RepositorySession; overview?: RawOverview; commits: Map<string, CommitDetail>; historyCursors: Map<string, string>; active: Map<string, { id: string; controller: AbortController }> };

/** At most two semantic Git reads run per worktree, including different UI sessions. */
class ReadQueue {
  private active = 0;
  private waiters: (() => void)[] = [];
  async run<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new QueryError('CANCELLED', '读取已取消。', true);
    if (this.active >= 2) await new Promise<void>((resolve, reject) => {
      const next = () => { signal.removeEventListener('abort', cancel); resolve(); };
      const cancel = () => { this.waiters = this.waiters.filter(item => item !== next); reject(new QueryError('CANCELLED', '读取已取消。', true)); };
      this.waiters.push(next);
      signal.addEventListener('abort', cancel, { once: true });
    });
    // A released slot is reserved for the waiter before it is resumed.
    else this.active++;
    try { if (signal.aborted) throw new QueryError('CANCELLED', '读取已取消。', true); return await fn(); }
    finally { const next = this.waiters.shift(); if (next) next(); else this.active--; }
  }
}

export function createRepositoryQueries(adapter: GitAdapter) {
  const sessions = new Map<string, State>();
  const queues = new Map<string, ReadQueue>();
  const writes = new Map<string, number>();
  function clearWorktree(worktreeId: string) {
    for (const state of sessions.values()) {
      if (state.session.repository.worktreeId !== worktreeId) continue;
      state.active.forEach(active => active.controller.abort());
      state.active.clear(); state.overview = undefined; state.commits.clear(); state.historyCursors.clear();
    }
  }
  function suspendWorktree(worktreeId: string) {
    writes.set(worktreeId, (writes.get(worktreeId) ?? 0) + 1);
    clearWorktree(worktreeId);
    let released = false;
    return () => {
      if (released) return;
      released = true; clearWorktree(worktreeId);
      const remaining = (writes.get(worktreeId) ?? 1) - 1;
      if (remaining) writes.set(worktreeId, remaining); else writes.delete(worktreeId);
    };
  }
  function stateFor(id: string) {
    const state = sessions.get(id);
    if (!state) throw new QueryError('STALE_RESULT', '仓库会话已失效，请重新打开。', true);
    return state;
  }
  async function open(path: string, signal?: AbortSignal): Promise<RepositorySession> {
    const repository = await adapter.resolveRepository(path, signal);
    const session = { sessionId: randomUUID(), generation: 0, repository };
    sessions.set(session.sessionId, { session, commits: new Map(), historyCursors: new Map(), active: new Map() });
    if (!queues.has(repository.worktreeId)) queues.set(repository.worktreeId, new ReadQueue());
    return session;
  }
  async function execute(request: ApiRequest, signal?: AbortSignal): Promise<ApiResponse> {
    const startedAt = new Date().toISOString();
    let stamp: ReadStamp | undefined;
    let state: State | undefined;
    let controller: AbortController | undefined;
    try {
      if (request.action === 'open') return { schemaVersion: 1, ok: true, data: await open(request.path, signal) };
      if (!('generation' in request)) throw new QueryError('INVALID_REQUEST', '此请求不属于仓库查询。');
      state = stateFor(request.sessionId);
      if (writes.has(state.session.repository.worktreeId)) throw new QueryError('REPOSITORY_BUSY', '暂存状态正在更新，请在操作完成后刷新。', true);
      const key = queryKey(request, state.session.repository.worktreeId);
      stamp = { sessionId: request.sessionId, generation: request.generation, queryKey: key, requestId: request.requestId, observationId: randomUUID(), startedAt, finishedAt: startedAt };
      if (request.generation < state.session.generation) throw new QueryError('STALE_RESULT', '这次读取已被更新的刷新取代。', true);
      if (request.generation > state.session.generation) {
        state.active.forEach(active => active.controller.abort());
        state.active.clear(); state.overview = undefined; state.commits.clear(); state.historyCursors.clear();
        state.session = { ...state.session, generation: request.generation };
      }
      state.active.get(key)?.controller.abort();
      controller = new AbortController();
      const readSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      state.active.set(key, { id: request.requestId, controller });
      const captured = state;
      const data = await queues.get(state.session.repository.worktreeId)!.run(readSignal, async () => {
        const repository = captured.session.repository;
        switch (request.action) {
          case 'navigation': return readNavigation(adapter, repository, readSignal);
          case 'overview': {
            const overview = await adapter.readOverview(repository, readSignal);
            if (!readSignal.aborted && captured.session.generation === request.generation) captured.overview = overview;
            return overviewSchema.parse({ ...overview, stamp: { ...stamp!, finishedAt: new Date().toISOString() }, explanations: explain(overview, stamp!.observationId) });
          }
          case 'change': {
            if (!captured.overview || captured.overview.fingerprint !== request.fingerprint) throw new QueryError('STALE_RESULT', '概览已经变化，请刷新后重新选择文件。', true);
            const entry = Object.values(captured.overview.changes).flat().find(entry => entry.id === request.entryId);
            if (!entry) throw new QueryError('STALE_RESULT', '此变化已不在当前观测中，请刷新。', true);
            return adapter.readChange(repository, entry, request.fingerprint, readSignal);
          }
          case 'history': {
            const filter = historyFilterKey(request);
            if (request.cursor && captured.historyCursors.get(request.cursor) !== filter) throw new QueryError('STALE_RESULT', '历史分页属于旧观测、其他引用筛选或排序，请刷新历史。', true);
            const history = await adapter.listHistory(repository, { scope: request.scope, ref: request.ref, order: request.order, cursor: request.cursor }, readSignal);
            if (!readSignal.aborted && history.nextCursor) captured.historyCursors.set(history.nextCursor, filter);
            return history;
          }
          case 'commit': {
            const detail = await adapter.readCommit(repository, request.oid, readSignal);
            if (!readSignal.aborted) captured.commits.set(request.oid, detail);
            return detail;
          }
          case 'commit-change': {
            const detail = captured.commits.get(request.oid) ?? await adapter.readCommit(repository, request.oid, readSignal);
            const entry = detail.changes.find(entry => entry.id === request.entryId);
            if (!entry) throw new QueryError('INVALID_REQUEST', '该文件不属于选择的提交。');
            return adapter.readCommitChange(repository, request.oid, entry, readSignal);
          }
        }
      });
      if (state.session.generation !== request.generation || state.active.get(key)?.id !== request.requestId || readSignal.aborted) throw new QueryError('STALE_RESULT', '旧读取结果已丢弃。', true);
      stamp.finishedAt = new Date().toISOString();
      return { schemaVersion: 1, ok: true, data, stamp };
    } catch (error) {
      if (stamp) stamp.finishedAt = new Date().toISOString();
      return { schemaVersion: 1, ok: false, error: toAppError(error), requestId: request.requestId, finishedAt: new Date().toISOString(), ...(stamp ? { stamp } : {}) };
    } finally {
      if (state && stamp && state.active.get(stamp.queryKey)?.controller === controller) state.active.delete(stamp.queryKey);
    }
  }
  return { open, execute, suspendWorktree, getSession: (id: string) => ({ ...stateFor(id).session }), close: () => { sessions.forEach(state => state.active.forEach(active => active.controller.abort())); sessions.clear(); queues.clear(); writes.clear(); } };
}
