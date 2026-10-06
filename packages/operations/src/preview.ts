import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { OPERATION_LIMITS, QueryError, type Diff, type GitAdapter, type OperationPreview, type RepositorySession } from '@git-view/contracts';
import type { createGitWriteAdapter, PreparedIndexOperation } from '../../git-write/src/index.js';
import { sameRepository } from './receipts.js';

export const previewInputSchema = z.object({
  kind: z.enum(['stage-files', 'unstage-files']), entryIds: z.array(z.string().min(1).max(512)).min(1).max(OPERATION_LIMITS.selectedFiles), fingerprint: z.string().min(1).max(512),
}).strict();
export type PreviewInput = z.infer<typeof previewInputSchema>;
export type StoredPreview = { preview: OperationPreview; sessionId: string; generation: number; prepared: PreparedIndexOperation };

export async function preparePreview(read: GitAdapter, writer: ReturnType<typeof createGitWriteAdapter>, session: RepositorySession, input: PreviewInput, now: () => number, lifetime: number, signal?: AbortSignal): Promise<StoredPreview> {
  const parsed = previewInputSchema.safeParse(input);
  if (!parsed.success || new Set(input.entryIds).size !== input.entryIds.length) throw new QueryError('INVALID_REQUEST', '请明确选择 1 至 200 个不重复的文件变化。');
  const overview = await read.readOverview(session.repository, signal);
  if (!sameRepository(overview.repository, session.repository) || overview.fingerprint !== input.fingerprint) throw new QueryError('STALE_RESULT', '文件或仓库状态已变化，请刷新后重新预览。', true);
  if (!overview.complete) throw new QueryError('OUTPUT_LIMIT', '当前文件列表不完整，无法安全生成操作预览。');
  if (overview.changes.conflicts.length || overview.operation.length) throw new QueryError('UNSUPPORTED_REPOSITORY', '首版不在冲突或 merge、rebase 等进行中状态执行暂存操作，请先在外部 Git 中处理。');
  const available = input.kind === 'stage-files' ? [...overview.changes.unstaged, ...overview.changes.untracked] : overview.changes.staged;
  const files = input.entryIds.map(id => {
    const entry = available.find(candidate => candidate.id === id);
    if (!entry) throw new QueryError('STALE_RESULT', '所选文件已不在对应的暂存分组中，请刷新后重新选择。', true);
    if (!entry.supported) throw new QueryError('UNSUPPORTED_PATH', '所选文件路径不能安全写入，首版只支持有效 UTF-8 路径。');
    return entry;
  });
  const diffs: Diff[] = [];
  const warnings = [...overview.warnings];
  if (input.kind === 'stage-files' && files.some(entry => overview.changes.staged.some(staged => staged.rawPath === entry.rawPath))) warnings.push('所选文件已有暂存内容；这次会将整个文件的当前版本放入暂存区。');
  let bytes = 0;
  for (const entry of files) {
    let diff: Diff;
    try { diff = await read.readChange(session.repository, entry, input.fingerprint, signal); }
    catch (error) {
      if (!(error instanceof QueryError) || error.code !== 'OUTPUT_LIMIT') throw error;
      diff = { entry, comparison: entry.comparison, text: '', format: 'unavailable', complete: false, reason: '差异超过读取限制，未展开内容。', base: entry.comparison === 'head-index' ? 'HEAD' : entry.comparison === 'index-worktree' ? 'index' : '空文件', target: entry.comparison === 'head-index' ? 'index' : '工作区' };
    }
    const size = Buffer.byteLength(JSON.stringify(diff));
    if (bytes + size > 1024 * 1024) diff = { ...diff, text: '', format: 'unavailable', complete: false, reason: '操作差异预览总量超过 1 MiB，未展开此文件内容。' };
    bytes += Buffer.byteLength(JSON.stringify(diff));
    if (!diff.complete || diff.reason) warnings.push(`${entry.path}：${diff.reason ?? '内容预览不完整。'}${!diff.complete ? ' 确认后仍将操作整个文件。' : ''}`);
    diffs.push(diff);
  }
  // Preparation verifies the final read state and freezes the intended file content.
  const prepared = await writer.prepare(session.repository, input.kind, files, input.fingerprint, signal);
  if (signal?.aborted) throw new QueryError('CANCELLED', '操作预览已取消。', true);
  const created = now();
  const preview: OperationPreview = { previewId: randomUUID(), worktreeId: session.repository.worktreeId, kind: input.kind, createdAt: new Date(created).toISOString(), expiresAt: new Date(created + lifetime).toISOString(), files, diffs, warnings };
  if (Buffer.byteLength(JSON.stringify(preview)) > 2 * 1024 * 1024) throw new QueryError('OUTPUT_LIMIT', '操作预览及路径信息超过 2 MiB，请减少本次选择的文件数。');
  return { preview, sessionId: session.sessionId, generation: session.generation, prepared };
}
