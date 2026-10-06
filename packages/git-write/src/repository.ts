import path from 'node:path';
import { z } from 'zod';
import { QueryError, operationResultSchema, repositorySchema, type GitAdapter, type RepositoryIdentity, type RepositoryOperationInput, type OperationResult, type RawOverview } from '@git-view/contracts';
import { createGitAdapter } from '../../git-cli/src/index.js';
import { optional } from './index.js';
import { requireIndexWrites } from './platform.js';
import { runRepositoryCommand, type CommandResult } from './repository-runner.js';
import { repositoryState, validateBranch, resolveBranch, checkTargetAttributes, headRef, query, targetTree, entriesHash } from './repository-state.js';

const outcomeSchema = z.object({ status: z.enum(['succeeded', 'failed', 'unknown']), message: z.string(), result: operationResultSchema.optional() });
export type RepositoryOutcome = z.infer<typeof outcomeSchema>;
export const repositoryEvidenceSchema = z.object({
  schemaVersion: z.literal(1), kind: z.enum(['commit', 'create-branch', 'switch-branch']), repository: repositorySchema.strict(),
  marker: z.string().regex(/^git-view:[a-f0-9-]{36}$/), beforeHead: z.string().nullable(), beforeRef: z.string().nullable(),
  expectedEntriesHash: z.string(), targetOid: z.string().optional(), targetBranch: z.string().optional(),
  outcome: outcomeSchema.optional(),
}).strict();
export type RepositoryEvidence = z.infer<typeof repositoryEvidenceSchema>;
export type PreparedRepositoryOperation = {
  kind: RepositoryOperationInput['kind']; repository: RepositoryIdentity; paths: string[];
  input: RepositoryOperationInput; state: Awaited<ReturnType<typeof repositoryState>>; targetOid?: string;
};
const dirty = (overview: RawOverview) => Object.values(overview.changes).some(entries => entries.length);
const stale = () => new QueryError('STALE_RESULT', 'HEAD、暂存区、配置或目标分支已变化，请重新预览。', true);
function assertOverview(overview: RawOverview, input: RepositoryOperationInput) {
  if (overview.fingerprint !== input.fingerprint) throw stale();
  if (!overview.complete || overview.operation.length || overview.changes.conflicts.length) throw new QueryError('UNSUPPORTED_REPOSITORY', '请先处理冲突或进行中的 Git 操作，并取得完整仓库状态。');
  if (input.kind === 'commit' && !overview.changes.staged.length) throw new QueryError('INVALID_REQUEST', '暂存区没有可提交的变化。');
  if (input.kind === 'switch-branch' && dirty(overview)) throw new QueryError('REPOSITORY_BUSY', '工作区有未提交内容；请先处理暂存、未暂存和未跟踪文件，再切换分支。');
}
async function checkBranch(read: GitAdapter, repository: RepositoryIdentity, input: RepositoryOperationInput, state: Awaited<ReturnType<typeof repositoryState>>) {
  if (input.kind === 'commit') return undefined;
  await validateBranch(repository, input.branch);
  const oid = await resolveBranch(repository, input.branch);
  if (input.kind === 'create-branch') {
    if (!state.headOid) throw new QueryError('INVALID_REQUEST', '首次提交前没有可作为新分支起点的提交。');
    if (oid) throw new QueryError('INVALID_REQUEST', '该分支已经存在，不会覆盖。');
    return state.headOid;
  }
  if (!oid) throw new QueryError('INVALID_REQUEST', '只能切换到已存在的本地分支。');
  if (state.headRef === `refs/heads/${input.branch}`) throw new QueryError('INVALID_REQUEST', '已经位于此分支。');
  const navigation = await read.listNavigation(repository);
  if (navigation.worktrees.some(tree => tree.branch === `refs/heads/${input.branch}` && tree.path !== repository.worktreeRoot)) throw new QueryError('REPOSITORY_BUSY', '目标分支已被另一个 worktree 使用。');
  await checkTargetAttributes(repository, oid);
  return oid;
}
async function facts(read: GitAdapter, repository: RepositoryIdentity): Promise<OperationResult> {
  const overview = await read.readOverview(repository);
  return { headOid: overview.head.kind === 'unborn' ? null : overview.head.oid, branch: overview.head.kind === 'detached' ? null : overview.head.branch,
    remaining: { staged: overview.changes.staged.length, unstaged: overview.changes.unstaged.length, untracked: overview.changes.untracked.length, conflicts: overview.changes.conflicts.length } };
}
async function markedCommit(repository: RepositoryIdentity, evidence: RepositoryEvidence) {
  const log = await optional(path.join(repository.gitDir, 'logs', 'HEAD'));
  const records = (log?.toString('utf8') ?? '').split('\n').filter(line => line.includes(`\t${evidence.marker}:`) || line.endsWith(`\t${evidence.marker}`));
  if (records.length !== 1) return undefined;
  const [old, oid] = records[0]!.split(' ');
  if (old !== (evidence.beforeHead ?? '0'.repeat(oid!.length))) return undefined;
  const raw = (await query(repository, ['cat-file', '-p', oid!])).toString('utf8').split('\n\n')[0]!;
  const parents = [...raw.matchAll(/^parent ([a-f0-9]+)$/gm)].map(match => match[1]!);
  if (JSON.stringify(parents) !== JSON.stringify(evidence.beforeHead ? [evidence.beforeHead] : [])) return undefined;
  const treeOid = /^tree ([a-f0-9]+)$/m.exec(raw)?.[1];
  if (!treeOid) return undefined;
  const actualEntries = await targetTree(repository, oid!);
  return { createdOid: oid!, treeOid, parents, previewMatched: entriesHash(actualEntries) === evidence.expectedEntriesHash };
}

export function createRepositoryWriter(options: { timeoutMs?: number } = {}) {
  const read = createGitAdapter();
  async function reconcile(repository: RepositoryIdentity, evidence: RepositoryEvidence, command?: CommandResult): Promise<RepositoryOutcome> {
    requireIndexWrites();
    if (JSON.stringify(repository) !== JSON.stringify(evidence.repository)) throw new QueryError('INVALID_REQUEST', '操作证据不属于当前仓库。');
    if (evidence.outcome && evidence.outcome.status !== 'unknown') return structuredClone(evidence.outcome);
    let result: OperationResult;
    try { result = await facts(read, repository); }
    catch { result = { headOid: null, branch: null, diagnostic: '操作后的工作区状态暂时无法完整读取。' }; }
    if (!command && evidence.outcome?.result?.diagnostic) result.diagnostic = evidence.outcome.result.diagnostic;
    if (command?.diagnostic) result.diagnostic = [result.diagnostic, command.diagnostic].filter(Boolean).join('\n');
    if (evidence.kind === 'commit') {
      const commit = await markedCommit(repository, evidence);
      if (commit) {
        Object.assign(result, commit);
        try { result.changedPaths = (await read.readCommit(repository, commit.createdOid)).changes.map(entry => entry.path); } catch { /* The OID/tree remain authoritative when detail exceeds limits. */ }
        return { status: 'succeeded', message: commit.previewMatched ? '提交已创建。' : '提交已创建，但实际内容与预览不同；请核对 hooks 或并发 Git 操作带来的变化。', result };
      }
    } else {
      const oid = await resolveBranch(repository, evidence.targetBranch!);
      if (evidence.kind === 'create-branch') {
        const log = await optional(path.join(repository.commonGitDir, 'logs', 'refs', 'heads', evidence.targetBranch!));
        const marked = log?.toString('utf8').split('\n').some(line => line.endsWith(`\t${evidence.marker}`) && line.split(' ')[1] === evidence.targetOid);
        if (oid === evidence.targetOid && marked) return { status: 'succeeded', message: result.headOid === evidence.beforeHead && result.branch === evidence.beforeRef?.replace(/^refs\/heads\//, '') ? '分支已创建，当前分支保持不变。' : '分支已创建，但 HEAD 有额外变化；请核对 hooks 的影响。', result: { ...result, targetBranch: evidence.targetBranch, createdOid: oid! } };
      } else if (oid === evidence.targetOid && await headRef(repository) === `refs/heads/${evidence.targetBranch}` && result.headOid === evidence.targetOid) {
        return { status: 'succeeded', message: command && command.code !== 0 ? '分支已切换，但后续 hook 或命令报告失败；请检查诊断和剩余改动。' : command ? '分支已切换。' : '已核对当前 HEAD 位于目标分支；中断前的 hook 执行结果无法恢复。', result: { ...result, targetBranch: evidence.targetBranch } };
      }
    }
    const unchangedHead = result.headOid === evidence.beforeHead && await headRef(repository) === evidence.beforeRef;
    if (command && !command.interrupted && command.code !== 0 && unchangedHead) return { status: 'failed', message: 'Git 未完成已确认的操作。保留 Git/hooks 的实际改动，请检查诊断后重新预览。', result };
    return { status: 'unknown', message: '无法唯一核实上次操作结果；不会再次执行。请核对 HEAD、引用及 Git 诊断。', result };
  }
  return {
    async prepare(repository: RepositoryIdentity, input: RepositoryOperationInput, signal?: AbortSignal): Promise<PreparedRepositoryOperation> {
      requireIndexWrites();
      const state = await repositoryState(repository, signal);
      const overview = await read.readOverview(repository, signal); assertOverview(overview, input);
      const targetOid = await checkBranch(read, repository, input, state);
      if ((await repositoryState(repository, signal)).guard !== state.guard) throw stale();
      return { kind: input.kind, repository, input, state, targetOid, paths: input.kind === 'commit' ? overview.changes.staged.map(entry => entry.path) : [] };
    },
    async execute(prepared: PreparedRepositoryOperation, operationId: string, persist: (evidence: RepositoryEvidence) => Promise<void>): Promise<RepositoryOutcome> {
      requireIndexWrites();
      const { repository, input, state } = prepared;
      const validate = async () => {
        const current = await repositoryState(repository);
        if (current.guard !== state.guard) throw stale();
        assertOverview(await read.readOverview(repository), input);
        if (await checkBranch(read, repository, input, current) !== prepared.targetOid) throw stale();
      };
      await validate();
      const evidence: RepositoryEvidence = { schemaVersion: 1, kind: input.kind, repository, marker: `git-view:${operationId}`, beforeHead: state.headOid, beforeRef: state.headRef, expectedEntriesHash: state.indexEntriesHash,
        ...(input.kind === 'commit' ? {} : { targetBranch: input.branch, targetOid: prepared.targetOid }) };
      await persist(evidence);
      try { await validate(); }
      catch (error) {
        const outcome: RepositoryOutcome = { status: 'failed', message: `尚未启动 Git 写命令：${error instanceof Error ? error.message : '前提已变化'}` };
        await persist({ ...evidence, outcome }); return outcome;
      }
      const command = input.kind === 'commit' ? { kind: input.kind, message: input.message } : input.kind === 'create-branch' ? { kind: input.kind, branch: input.branch, oid: prepared.targetOid! } : { kind: input.kind, branch: input.branch };
      const execution = await runRepositoryCommand(repository, command, evidence.marker, options.timeoutMs);
      const outcome = await reconcile(repository, evidence, execution);
      await persist({ ...evidence, outcome });
      return outcome;
    },
    reconcile,
  };
}
