import { randomUUID } from 'node:crypto';
import { INVESTIGATION_LIMITS, type FileHistoryPage, type RecordPage, type SearchPage } from '@git-view/contracts';
import { GitReadError } from './runner.js';

export type InvestigationSnapshot = { kind: 'search'; data: SearchPage; key: string } | { kind: 'file'; data: FileHistoryPage; key: string } | { kind: 'records'; data: RecordPage; key: string };

/** Bounded immutable observations; cursors carry no revision expressions or paths. */
export class InvestigationStore {
  private snapshots = new Map<string, { snapshot: InvestigationSnapshot; bytes: number }>();
  private cursors = new Map<string, { snapshotId: string; offset: number }>();
  private bytes = 0;
  constructor(private pageSize: number, private cursorLimit: number) {}
  save(snapshot: InvestigationSnapshot, signal?: AbortSignal) {
    if (signal?.aborted) throw new GitReadError('CANCELLED', '读取已取消。');
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    if (bytes > INVESTIGATION_LIMITS.snapshotBytes) throw new GitReadError('OUTPUT_LIMIT', '历史调查结果超过安全上限，未返回不完整结果。');
    this.snapshots.set(snapshot.data.snapshotId, { snapshot, bytes }); this.bytes += bytes;
    while (this.snapshots.size > INVESTIGATION_LIMITS.snapshots || this.bytes > INVESTIGATION_LIMITS.totalBytes) {
      const oldest = this.snapshots.keys().next().value!;
      this.bytes -= this.snapshots.get(oldest)!.bytes; this.snapshots.delete(oldest);
    }
  }
  get(id: string, worktreeId: string) {
    const snapshot = this.snapshots.get(id)?.snapshot;
    if (!snapshot || snapshot.data.worktreeId !== worktreeId) throw new GitReadError('STALE_RESULT', '历史调查观测已失效，请重新读取。', true);
    return snapshot;
  }
  cursor(id: string, worktreeId: string, key: string, kind: InvestigationSnapshot['kind']) {
    const cursor = this.cursors.get(id);
    if (!cursor) throw new GitReadError('STALE_RESULT', '历史调查分页已失效，请重新读取。', true);
    const snapshot = this.get(cursor.snapshotId, worktreeId);
    if (snapshot.key !== key || snapshot.kind !== kind) throw new GitReadError('STALE_RESULT', '历史调查分页属于其他查询，请重新读取。', true);
    return { snapshot, offset: cursor.offset };
  }
  page(snapshot: InvestigationSnapshot, offset: number) {
    const values = snapshot.kind === 'search' ? snapshot.data.commits : snapshot.data.entries;
    let nextCursor: string | undefined;
    if (values.length > offset + this.pageSize) {
      nextCursor = randomUUID(); this.cursors.set(nextCursor, { snapshotId: snapshot.data.snapshotId, offset: offset + this.pageSize });
      if (this.cursors.size > this.cursorLimit) this.cursors.delete(this.cursors.keys().next().value!);
    }
    return { offset, end: offset + this.pageSize, ...(nextCursor ? { nextCursor } : {}) };
  }
}
