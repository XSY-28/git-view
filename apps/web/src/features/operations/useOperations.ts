import { useRef, useState } from 'react';
import { operationPreviewSchema, operationReceiptSchema, pendingOperationsSchema, type OperationInput, type OperationKind, type ChangeEntry, type OperationPreview, type OperationReceipt, type Overview, type RepositorySession } from '@git-view/contracts';
import { operationApi, errorMessage, ApiError } from '../../state/api';

export type { OperationKind } from '@git-view/contracts';
export const operationLabel = (kind: OperationKind) => ({ 'stage-files': '暂存', 'unstage-files': '取消暂存', commit: '提交', 'create-branch': '创建分支', 'switch-branch': '切换分支' })[kind];
export type OperationState = {
  kind?: OperationKind; entryIds: string[]; preview?: OperationPreview;
  phase: 'idle' | 'previewing' | 'executing' | 'checking' | 'discovering' | 'discovery-failed';
  remainingCount?: number;
  receipt?: OperationReceipt; error?: string;
};
const idle = (): OperationState => ({ entryIds: [], phase: 'idle' });
const storageKey = (worktreeId: string) => `git-view:pending-operation:${worktreeId}`;
const unresolved = (receipt?: OperationReceipt) => receipt?.status === 'unknown' || receipt?.status === 'running';

export function useOperations(options: {
  overview?: Overview; available: boolean;
  beforeExecute: () => void; afterExecute: (receipt?: OperationReceipt) => void;
}) {
  const latest = useRef(options); latest.current = options;
  const context = useRef<RepositorySession | undefined>(undefined);
  const version = useRef(0);
  const discoveryVersion = useRef(0);
  const backlog = useRef<OperationReceipt[]>([]);
  const previewAbort = useRef<AbortController | undefined>(undefined);
  const stateRef = useRef<OperationState>(idle());
  const [state, setState] = useState<OperationState>(stateRef.current);
  // A ref closes the same-event/double-click window before React renders disabled controls.
  const executing = useRef(false);
  function update(next: OperationState) { const value = { ...next, remainingCount: backlog.current.length }; stateRef.current = value; setState(value); }
  function accepts(session: RepositorySession, serial: number) { return context.current?.sessionId === session.sessionId && context.current.repository.worktreeId === session.repository.worktreeId && version.current === serial; }
  function persist(receipt: OperationReceipt) { sessionStorage.setItem(storageKey(receipt.worktreeId), JSON.stringify(receipt)); }
  function clearStored(worktreeId: string) { try { sessionStorage.removeItem(storageKey(worktreeId)); } catch { /* The receipt remains visible in this page. */ } }
  function invalidate(message?: string) {
    if (executing.current) return;
    previewAbort.current?.abort(); version.current += 1;
    const previous = stateRef.current;
    update({ ...previous, entryIds: [], kind: undefined, preview: undefined, phase: previous.phase === 'discovering' || previous.phase === 'discovery-failed' ? previous.phase : 'idle', error: message && (previous.preview || previous.phase === 'previewing') ? message : previous.error });
  }
  function settle(receipt: OperationReceipt) {
    if (unresolved(receipt)) persist(receipt); else clearStored(receipt.worktreeId);
    update({ ...idle(), receipt });
  }
  async function recover() {
    const active = context.current; const pending = stateRef.current.receipt;
    if (!active || !pending || !unresolved(pending) || executing.current) return;
    const serial = ++version.current;
    executing.current = true;
    update({ ...stateRef.current, phase: 'checking', error: undefined });
    latest.current.beforeExecute();
    try {
      const receipt = await operationApi({ schemaVersion: 1, requestId: crypto.randomUUID(), sessionId: active.sessionId, action: 'receipt', operationId: pending.operationId }, operationReceiptSchema);
      if (!accepts(active, serial)) return;
      if (receipt.worktreeId !== active.repository.worktreeId || receipt.operationId !== pending.operationId || receipt.previewId !== pending.previewId) throw new Error('操作回执与当前仓库或操作不匹配，未采用此结果。');
      settle(receipt);
    } catch (error) {
      if (accepts(active, serial)) update({ ...idle(), receipt: pending, error: errorMessage(error) });
    } finally {
      if (accepts(active, serial)) { executing.current = false; latest.current.afterExecute(stateRef.current.receipt); }
    }
  }
  function activate(session: RepositorySession) {
    previewAbort.current?.abort(); version.current += 1; discoveryVersion.current += 1; context.current = session; executing.current = false;
    let receipt: OperationReceipt | undefined;
    try {
      const saved = sessionStorage.getItem(storageKey(session.repository.worktreeId));
      if (saved) { const parsed = operationReceiptSchema.safeParse(JSON.parse(saved)); if (parsed.success && parsed.data.worktreeId === session.repository.worktreeId && unresolved(parsed.data)) receipt = parsed.data; }
    } catch { /* Session storage can be unavailable in restricted browser environments. */ }
    backlog.current = [];
    update({ ...idle(), receipt, phase: 'discovering' });
    queueMicrotask(() => { if (context.current?.sessionId === session.sessionId) void discover(); });
  }
  async function discover() {
    const active = context.current;
    if (!active || executing.current) return;
    const serial = ++discoveryVersion.current;
    const cached = stateRef.current.receipt;
    const isCurrent = () => context.current?.sessionId === active.sessionId && discoveryVersion.current === serial;
    update({ ...idle(), receipt: cached, phase: 'discovering' });
    try {
      const result = await operationApi({ schemaVersion: 1, requestId: crypto.randomUUID(), sessionId: active.sessionId, action: 'pending' }, pendingOperationsSchema);
      if (!isCurrent()) return;
      if (result.receipts.some(receipt => receipt.worktreeId !== active.repository.worktreeId)) throw new Error('待核实回执与当前仓库不匹配。');
      const receipts = [...result.receipts];
      if (cached && !receipts.some(receipt => receipt.operationId === cached.operationId)) receipts.push(cached);
      receipts.sort((a, b) => Number(unresolved(b)) - Number(unresolved(a)));
      const first = receipts.shift();
      backlog.current = receipts.filter(unresolved);
      if (first) {
        settle(first);
        // A locally retained ID may have a completed durable receipt already.
        if (unresolved(first)) void recover();
      } else update(idle());
    } catch (error) {
      if (isCurrent()) update({ ...idle(), receipt: cached, phase: 'discovery-failed', error: `无法核实上次操作：${errorMessage(error)}` });
    }
  }
  function nextReceipt() {
    if (executing.current || unresolved(stateRef.current.receipt)) return;
    const next = backlog.current.shift();
    if (next) { settle(next); void recover(); }
  }
  function toggle(entry: ChangeEntry, kind: 'stage-files' | 'unstage-files') {
    const current = stateRef.current;
    if (!latest.current.available || current.phase !== 'idle' || backlog.current.length || executing.current || unresolved(current.receipt) || !entry.supported || (current.entryIds.length && current.kind !== kind)) return;
    previewAbort.current?.abort(); version.current += 1;
    const entryIds = current.entryIds.includes(entry.id) ? current.entryIds.filter(id => id !== entry.id) : [...current.entryIds, entry.id];
    update({ entryIds, kind: entryIds.length ? kind : undefined, phase: 'idle' });
  }
  async function preview(input?: OperationInput) {
    const active = context.current; const current = stateRef.current; const overview = latest.current.overview;
    if (!active || !overview || !latest.current.available || current.phase !== 'idle' || backlog.current.length || unresolved(current.receipt) || executing.current) return false;
    const request = input ?? (current.entryIds.length && (current.kind === 'stage-files' || current.kind === 'unstage-files') ? { kind: current.kind, entryIds: current.entryIds, fingerprint: overview.fingerprint } : undefined);
    if (!request) return false;
    const serial = ++version.current; const abort = new AbortController(); previewAbort.current = abort;
    update({ ...current, kind: request.kind, phase: 'previewing', error: undefined });
    try {
      const result = await operationApi({ schemaVersion: 1, requestId: crypto.randomUUID(), sessionId: active.sessionId, action: 'preview', ...request }, operationPreviewSchema, abort.signal);
      if (!accepts(active, serial)) return false;
      if (result.worktreeId !== active.repository.worktreeId || result.kind !== request.kind || ('entryIds' in request && (result.files.length !== request.entryIds.length || result.files.some(file => !request.entryIds.includes(file.id))))) throw new Error('预览与所选操作不匹配，请刷新后重新选择。');
      update({ entryIds: 'entryIds' in request ? request.entryIds : [], kind: request.kind, phase: 'idle', preview: result });
      return true;
    } catch (error) { if (accepts(active, serial)) update({ ...current, phase: 'idle', error: errorMessage(error) }); return false; }
  }
  function dismissPreview() {
    if (executing.current || stateRef.current.phase === 'discovering' || stateRef.current.phase === 'discovery-failed') return;
    previewAbort.current?.abort(); version.current += 1;
    update({ ...stateRef.current, phase: 'idle', preview: undefined, error: undefined });
  }
  async function execute(allowHooks = false) {
    const active = context.current; const current = stateRef.current; const preview = current.preview;
    if (!active || !preview || executing.current || current.phase !== 'idle' || backlog.current.length || unresolved(current.receipt) || !latest.current.available) return;
    const pending: OperationReceipt = { operationId: crypto.randomUUID(), previewId: preview.previewId, worktreeId: active.repository.worktreeId, kind: preview.kind, status: 'unknown', message: '尚未取得执行回执，请核实结果。', paths: preview.files.map(file => file.path), startedAt: new Date().toISOString() };
    // Store before sending: a reload or missing response must never create a new execution ID.
    try { persist(pending); } catch { update({ ...current, error: '无法保存操作回执，请允许此页面使用会话存储后再确认。' }); return; }
    const serial = ++version.current; executing.current = true;
    update({ ...current, phase: 'executing', receipt: pending, error: undefined }); latest.current.beforeExecute();
    try {
      const receipt = await operationApi({ schemaVersion: 1, requestId: crypto.randomUUID(), sessionId: active.sessionId, action: 'execute', previewId: preview.previewId, operationId: pending.operationId, allowHooks }, operationReceiptSchema);
      if (!accepts(active, serial)) return;
      if (receipt.worktreeId !== active.repository.worktreeId || receipt.operationId !== pending.operationId || receipt.previewId !== preview.previewId) throw new Error('操作回执与当前仓库或操作不匹配。');
      settle(receipt);
    } catch (error) {
      if (accepts(active, serial)) {
        if (error instanceof ApiError && ['STALE_RESULT', 'REPOSITORY_BUSY', 'INVALID_REQUEST'].includes(error.detail.code)) {
          settle({ ...pending, status: 'failed', message: `${errorMessage(error)} 请重新选择并预览。`, finishedAt: new Date().toISOString() });
        } else update({ ...idle(), receipt: pending, error: `未能确认操作结果：${errorMessage(error)}` });
      }
    } finally {
      if (accepts(active, serial)) { executing.current = false; latest.current.afterExecute(stateRef.current.receipt); }
    }
  }
  function forgetReceipt() {
    const receipt = stateRef.current.receipt;
    if (executing.current || receipt?.status === 'running') return;
    if (receipt) clearStored(receipt.worktreeId);
    const next = backlog.current.shift();
    if (next) { settle(next); void recover(); } else update(idle());
  }
  return { state, executing, blocked: !options.available || state.phase !== 'idle' || Boolean(state.remainingCount) || unresolved(state.receipt), activate, invalidate, toggle, preview, dismissPreview, execute, recover, discover, nextReceipt, forgetReceipt };
}
export type Operations = ReturnType<typeof useOperations>;
