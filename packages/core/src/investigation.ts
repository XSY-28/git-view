import { INVESTIGATION_LIMITS, QueryError, investigationFilterKey, type ApiRequest, type GitAdapter, type RepositoryIdentity, type StashDetail } from '@git-view/contracts';

export type InvestigationRequest = Extract<ApiRequest, { action: 'search' | 'file-history' | 'file-history-change' | 'blame' | 'records' | 'stash-detail' | 'stash-change' }>;
type Observation = { kind: 'file' | 'stash' | 'reflog'; entries: Set<string> };

/** Session authorization only: facts and object reads remain in the Git adapter. */
export class InvestigationSession {
  private cursors = new Map<string, string>();
  private observations = new Map<string, Observation>();
  private stashes = new Map<string, { detail: StashDetail; bytes: number }>();
  private stashBytes = 0;
  clear() { this.cursors.clear(); this.observations.clear(); this.stashes.clear(); this.stashBytes = 0; }
  private cursor(cursor: string | undefined, key: string) {
    if (cursor && this.cursors.get(cursor) !== key) throw new QueryError('STALE_RESULT', '历史调查分页已失效，请重新读取。', true);
  }
  private rememberCursor(cursor: string | undefined, key: string) {
    if (cursor) { this.cursors.set(cursor, key); if (this.cursors.size > INVESTIGATION_LIMITS.cursors) this.cursors.delete(this.cursors.keys().next().value!); }
  }
  private remember(id: string, kind: Observation['kind'], entries: string[]) {
    const previous = this.observations.get(id);
    const observation = previous?.kind === kind ? previous : { kind, entries: new Set<string>() };
    entries.forEach(id => observation.entries.add(id)); this.observations.set(id, observation);
    if (this.observations.size > INVESTIGATION_LIMITS.snapshots) this.observations.delete(this.observations.keys().next().value!);
  }
  private authorize(id: string, entryId: string, kind: Observation['kind']) {
    const observation = this.observations.get(id);
    if (!observation || observation.kind !== kind || !observation.entries.has(entryId)) throw new QueryError('STALE_RESULT', '历史调查观测已失效，请重新读取。', true);
  }
  async execute(adapter: GitAdapter, repo: RepositoryIdentity, request: InvestigationRequest, signal: AbortSignal, current: () => boolean) {
    switch (request.action) {
      case 'search': {
        const options = { scope: request.scope, ref: request.ref, term: request.term, field: request.field, cursor: request.cursor };
        const key = `search:${investigationFilterKey(options)}`; this.cursor(request.cursor, key);
        const result = await adapter.searchCommits(repo, options, signal);
        if (current()) this.rememberCursor(result.nextCursor, key);
        return result;
      }
      case 'file-history': {
        const options = { endpoint: request.endpoint, path: request.path, cursor: request.cursor };
        const key = `file:${investigationFilterKey(options)}`; this.cursor(request.cursor, key);
        const result = await adapter.listFileHistory(repo, options, signal);
        if (current()) { this.rememberCursor(result.nextCursor, key); this.remember(result.snapshotId, 'file', result.entries.map(item => item.entryId)); }
        return result;
      }
      case 'file-history-change': this.authorize(request.snapshotId, request.entryId, 'file'); return adapter.readFileHistoryChange(repo, request.snapshotId, request.entryId, signal);
      case 'blame': this.authorize(request.snapshotId, request.entryId, 'file'); return adapter.blameFileHistory(repo, request.snapshotId, request.entryId, request.side, signal);
      case 'records': {
        const options = { kind: request.kind, ref: request.ref, cursor: request.cursor };
        const key = `records:${investigationFilterKey(options)}`; this.cursor(request.cursor, key);
        const result = await adapter.listRecords(repo, options, signal);
        if (current()) { this.rememberCursor(result.nextCursor, key); this.remember(result.snapshotId, result.kind, result.entries.map(item => item.recordId)); }
        return result;
      }
      case 'stash-detail': {
        this.authorize(request.snapshotId, request.recordId, 'stash');
        const detail = await adapter.readStash(repo, request.snapshotId, request.recordId, signal);
        if (current()) {
          const key = `${request.snapshotId}:${request.recordId}`; const bytes = Buffer.byteLength(JSON.stringify(detail));
          if (bytes > INVESTIGATION_LIMITS.snapshotBytes) throw new QueryError('OUTPUT_LIMIT', '历史调查结果超过安全上限，未返回不完整结果。');
          this.stashBytes -= this.stashes.get(key)?.bytes ?? 0; this.stashes.set(key, { detail, bytes }); this.stashBytes += bytes;
          while (this.stashes.size > INVESTIGATION_LIMITS.snapshots || this.stashBytes > INVESTIGATION_LIMITS.totalBytes) {
            const first = this.stashes.keys().next().value!; this.stashBytes -= this.stashes.get(first)!.bytes; this.stashes.delete(first);
          }
        }
        return detail;
      }
      case 'stash-change': {
        this.authorize(request.snapshotId, request.recordId, 'stash');
        const detail = this.stashes.get(`${request.snapshotId}:${request.recordId}`)?.detail;
        const entry = detail?.parts.find(part => part.kind === request.part)?.changes.find(item => item.id === request.entryId);
        if (!detail || !entry) throw new QueryError('STALE_RESULT', 'stash 快照已失效，请重新读取详情。', true);
        return adapter.readStashChange(repo, detail, request.part, entry, signal);
      }
    }
  }
}
