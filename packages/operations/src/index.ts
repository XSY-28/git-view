import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { OPERATION_LIMITS, QueryError, toAppError, type GitAdapter, type OperationReceipt, type RepositorySession } from '@git-view/contracts';
import { createGitWriteAdapter, type IndexWriteEvidence } from '../../git-write/src/index.js';
import { createRepositoryWriter, type RepositoryEvidence } from '../../git-write/src/repository.js';
import { preparePreview, type PreviewInput, type StoredPreview } from './preview.js';
import { createReceiptStore, sameRepository, type StoredReceipt } from './receipts.js';
import { serialized } from './queue.js';
import { indexWritesUnavailable, supportsIndexWrites } from '../../git-write/src/platform.js';

export type { PreviewInput } from './preview.js';
const liveOperations = new Set<string>();
const idSchema = z.string().uuid();
function requireId(id: string) { if (!idSchema.safeParse(id).success) throw new QueryError('INVALID_REQUEST', '操作或预览 ID 无效。'); }

export async function createOperations(options: { directory: string; read: GitAdapter; writer?: ReturnType<typeof createGitWriteAdapter>; repositoryWriter?: ReturnType<typeof createRepositoryWriter>; now?: () => number; previewLifetimeMs?: number }) {
  if (!supportsIndexWrites()) {
    const unavailable = async (): Promise<never> => { throw indexWritesUnavailable(); };
    return { preview: unavailable, execute: unavailable, receipt: unavailable, pending: async () => ({ receipts: [] as OperationReceipt[] }) };
  }
  const writer = options.writer ?? createGitWriteAdapter();
  const repositoryWriter = options.repositoryWriter ?? createRepositoryWriter();
  const now = options.now ?? Date.now;
  const lifetime = options.previewLifetimeMs ?? OPERATION_LIMITS.previewLifetimeMs;
  if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > OPERATION_LIMITS.previewLifetimeMs) throw new QueryError('INVALID_REQUEST', '操作预览有效期必须在 0 至 60 秒内。');
  const store = await createReceiptStore(options.directory);
  const ownerId = randomUUID();
  const previews = new Map<string, StoredPreview>();
  const timestamp = () => new Date(now()).toISOString();
  function cleanup() { for (const [id, value] of previews) if (Date.parse(value.preview.expiresAt) <= now()) previews.delete(id); }
  function assertRepository(record: StoredReceipt, session: RepositorySession) {
    if (!sameRepository(record.repository, session.repository)) throw new QueryError('INVALID_REQUEST', '此操作回执不属于当前工作区。');
  }
  async function reconcile(record: StoredReceipt): Promise<OperationReceipt> {
    if (record.receipt.status !== 'running' && record.receipt.status !== 'unknown') return structuredClone(record.receipt);
    if (liveOperations.has(store.key(record.receipt.operationId)) || await store.hasLiveLock(record.repository, record.ownerId)) return structuredClone(record.receipt);
    const receipt = { ...record.receipt };
    if (record.evidence && 'kind' in record.evidence) {
      const outcome = await repositoryWriter.reconcile(record.repository, record.evidence);
      Object.assign(receipt, outcome);
    } else if (record.evidence) {
      let verified = false;
      try { verified = await writer.verify(record.repository, record.evidence); } catch { /* A failed read cannot prove the outcome. */ }
      receipt.status = verified ? 'succeeded' : 'unknown';
      receipt.message = verified ? '已重新核对暂存区，操作结果与保存的执行证据一致。' : '结果待核实：当前仓库状态不能唯一确认上次操作的结果；不会自动重复执行。';
    } else {
      receipt.status = 'failed';
      receipt.message = '上次操作在保存执行证据之前中断，未开始写入；请重新预览。';
    }
    receipt.finishedAt = timestamp();
    await store.save({ ...record, receipt });
    return structuredClone(receipt);
  }
  async function receipt(session: RepositorySession, operationId: string): Promise<OperationReceipt> {
    requireId(operationId);
    const record = await store.load(operationId);
    if (!record) throw new QueryError('INVALID_REQUEST', '没有找到此操作回执。');
    assertRepository(record, session);
    return reconcile(record);
  }
  async function pending(session: RepositorySession): Promise<{ receipts: OperationReceipt[] }> {
    const records = await store.listUnresolved(session.repository);
    const receipts: OperationReceipt[] = [];
    for (const record of records) receipts.push(await reconcile(record));
    receipts.sort((first, second) => first.startedAt.localeCompare(second.startedAt));
    const result = { receipts };
    if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) throw new QueryError('OUTPUT_LIMIT', '待核实操作列表超过传输限制，无法完整显示；请按操作 ID 查询回执。');
    return result;
  }
  async function preview(session: RepositorySession, input: PreviewInput, signal?: AbortSignal) {
    cleanup();
    const result = await preparePreview(options.read, writer, session, input, now, lifetime, signal, repositoryWriter);
    cleanup();
    while (previews.size >= 32) previews.delete(previews.keys().next().value!);
    previews.set(result.preview.previewId, result);
    return structuredClone(result.preview);
  }
  async function execute(session: RepositorySession, previewId: string, operationId: string, allowHooks = false): Promise<OperationReceipt> {
    requireId(previewId); requireId(operationId);
    // Holding this queue through the receipt write ensures duplicate clicks see the
    // persisted outcome. No transport cancellation reaches an accepted execution.
    return serialized(session.repository.commonGitDir, async () => {
      const previous = await store.load(operationId);
      if (previous) {
        assertRepository(previous, session);
        if (previous.receipt.previewId !== previewId) throw new QueryError('INVALID_REQUEST', '此操作 ID 已绑定其他预览，请查询原操作回执。');
        return reconcile(previous);
      }
      cleanup();
      const saved = previews.get(previewId);
      if (!saved || saved.sessionId !== session.sessionId || saved.generation !== session.generation || !sameRepository(saved.prepared.repository, session.repository)) throw new QueryError('STALE_RESULT', '操作预览已过期、已使用或不属于当前会话，请重新预览。', true);
      if (saved.preview.requiresHookConsent && !allowHooks) throw new QueryError('INVALID_REQUEST', '请先明确允许此操作运行仓库 hooks 和已配置的签名程序。');
      const releaseCommon = await store.lock(session.repository, ownerId, true);
      let release: () => Promise<void>;
      try { release = await store.lock(session.repository, ownerId); } catch (error) { await releaseCommon(); throw error; }
      let record: StoredReceipt = {
        schemaVersion: 1, repository: structuredClone(session.repository), ownerId, pid: process.pid,
        receipt: { operationId, previewId, worktreeId: session.repository.worktreeId, kind: saved.preview.kind, status: 'running', message: '正在核对并执行操作。', paths: [...saved.prepared.paths], startedAt: timestamp() },
      };
      let evidence: IndexWriteEvidence | RepositoryEvidence | undefined;
      let accepted = false;
      try {
        // An operation ID is durable before any executor activity. A failed save
        // leaves the preview available because the index has not been touched.
        if (!await store.reserve(record)) {
          const existing = await store.load(operationId);
          if (!existing) throw new QueryError('INTERNAL_ERROR', '操作回执保留状态不一致，请查询原操作。');
          assertRepository(existing, session);
          if (existing.receipt.previewId !== previewId) throw new QueryError('INVALID_REQUEST', '此操作 ID 已绑定其他预览，请查询原操作回执。');
          return reconcile(existing);
        }
        previews.delete(previewId);
        accepted = true;
        liveOperations.add(store.key(operationId));
        try {
          const persist = async (value: IndexWriteEvidence | RepositoryEvidence) => {
            record = { ...record, evidence: value }; await store.save(record); evidence = value;
          };
          if ('input' in saved.prepared) {
            const outcome = await repositoryWriter.execute(saved.prepared, operationId, persist);
            record.receipt = { ...record.receipt, ...outcome, finishedAt: timestamp() };
          } else {
            await writer.execute(saved.prepared, persist);
            if (!evidence || 'kind' in evidence) throw new QueryError('INTERNAL_ERROR', '执行器没有保存正确的安装证据。');
            const verified = await writer.verify(session.repository, evidence);
            record.receipt = { ...record.receipt, status: verified ? 'succeeded' : 'unknown', message: verified ? (saved.preview.kind === 'stage-files' ? '已暂存所选文件的完整当前内容。' : '已取消暂存所选文件，工作文件内容保持不变。') : '结果待核实：写入后仓库状态发生变化；不会自动重复执行。', finishedAt: timestamp() };
          }
        } catch (error) {
          if (evidence && 'kind' in evidence) {
            let outcome;
            try { outcome = await repositoryWriter.reconcile(session.repository, evidence); } catch { /* Preserve uncertainty. */ }
            record.receipt = { ...record.receipt, ...(outcome ?? { status: 'unknown' as const, message: '结果待核实，不会自动重复执行。' }), finishedAt: timestamp() };
            if (record.receipt.status !== 'succeeded') record.receipt.message += ` ${toAppError(error).message}`;
          } else {
            let verified = false;
            if (evidence) try { verified = await writer.verify(session.repository, evidence); } catch { /* Preserve uncertainty. */ }
            record.receipt = { ...record.receipt, status: verified ? 'succeeded' : evidence ? 'unknown' : 'failed', message: verified ? '写入后的响应异常，但已核对暂存区并确认操作成功。' : evidence ? `结果待核实：${toAppError(error).message} 不会自动重复执行。` : `${'input' in saved.prepared ? '未开始写入' : '未更新暂存区'}：${toAppError(error).message}`, finishedAt: timestamp() };
          }
        }
        try { await store.save(record); }
        catch { record.receipt = { ...record.receipt, status: 'unknown', message: '结果待核实：无法保存最终回执；请查询此操作 ID，系统不会自动重复执行。', finishedAt: timestamp() }; }
        return structuredClone(record.receipt);
      } finally {
        if (accepted) liveOperations.delete(store.key(operationId));
        // A cleanup failure must never turn a durable execution into a retryable
        // transport error. The remaining lock will refuse later writes safely.
        await release().catch(() => {});
        await releaseCommon().catch(() => {});
      }
    });
  }
  return { preview, execute, receipt, pending };
}
export type Operations = Awaited<ReturnType<typeof createOperations>>;
