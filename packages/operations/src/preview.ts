import { randomUUID } from 'node:crypto';
import { OPERATION_LIMITS, operationInputSchema, QueryError, type OperationInput, type Diff, type GitAdapter, type OperationPreview, type RepositorySession } from '@git-view/contracts';
import type { createGitWriteAdapter, PreparedIndexOperation } from '../../git-write/src/index.js';
import { createRepositoryWriter, type PreparedRepositoryOperation } from '../../git-write/src/repository.js';
import { sameRepository } from './receipts.js';

export const previewInputSchema = operationInputSchema;
export type PreviewInput = OperationInput;
export type StoredPreview = { preview: OperationPreview; sessionId: string; generation: number; prepared: PreparedIndexOperation | PreparedRepositoryOperation };

export async function preparePreview(read: GitAdapter, writer: ReturnType<typeof createGitWriteAdapter>, session: RepositorySession, input: PreviewInput, now: () => number, lifetime: number, signal?: AbortSignal, repositoryWriter = createRepositoryWriter()): Promise<StoredPreview> {
  const parsed = previewInputSchema.safeParse(input);
  if (!parsed.success || ('entryIds' in input && new Set(input.entryIds).size !== input.entryIds.length)) throw new QueryError('INVALID_REQUEST', '操作参数无效，请检查文件选择、提交说明或分支名称。');
  const overview = await read.readOverview(session.repository, signal);
  if (!sameRepository(overview.repository, session.repository) || overview.fingerprint !== input.fingerprint) throw new QueryError('STALE_RESULT', '文件或仓库状态已变化，请刷新后重新预览。', true);
  if (!overview.complete) throw new QueryError('OUTPUT_LIMIT', '当前文件列表不完整，无法安全生成操作预览。');
  if (overview.changes.conflicts.length || overview.operation.length) throw new QueryError('UNSUPPORTED_REPOSITORY', '存在冲突或 merge、rebase 等进行中的操作，请先处理后再执行。');
  const available = input.kind === 'stage-files' ? [...overview.changes.unstaged, ...overview.changes.untracked] : overview.changes.staged;
  const entryIds = 'entryIds' in input ? input.entryIds : input.kind === 'commit' ? overview.changes.staged.map(entry => entry.id) : [];
  if (entryIds.length > OPERATION_LIMITS.selectedFiles) throw new QueryError('OUTPUT_LIMIT', '一次最多预览 200 个变化文件。');
  const files = entryIds.map(id => {
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
  const prepared = 'entryIds' in input
    ? await writer.prepare(session.repository, input.kind, files, input.fingerprint, signal)
    : await repositoryWriter.prepare(session.repository, input, signal);
  const context = 'input' in prepared ? { headOid: prepared.state.headOid, branch: prepared.state.headRef?.replace(/^refs\/heads\//, '') ?? null,
    ...(prepared.input.kind === 'commit' ? { message: prepared.input.message } : { targetBranch: prepared.input.branch, targetOid: prepared.targetOid }) } : undefined;
  if (context) warnings.push('此操作按 Git 配置运行 hooks；提交还可能运行签名程序。它们可修改文件、暂存区或其他引用，请仅在信任本地仓库时允许执行。');
  if (signal?.aborted) throw new QueryError('CANCELLED', '操作预览已取消。', true);
  const created = now();
  const preview: OperationPreview = { previewId: randomUUID(), worktreeId: session.repository.worktreeId, kind: input.kind, createdAt: new Date(created).toISOString(), expiresAt: new Date(created + lifetime).toISOString(), files, diffs, warnings, ...(context ? { context, requiresHookConsent: true } : {}) };
  if (Buffer.byteLength(JSON.stringify(preview)) > 2 * 1024 * 1024) throw new QueryError('OUTPUT_LIMIT', '操作预览及路径信息超过 2 MiB，请减少本次选择的文件数。');
  return { preview, sessionId: session.sessionId, generation: session.generation, prepared };
}
