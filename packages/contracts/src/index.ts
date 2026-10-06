import { z } from 'zod';
import { navigationSchema, historyScopeSchema, historyRefSchema, historyOrderSchema, resolveHistoryOrder, type Navigation, type HistoryOptions } from './navigation';
export * from './navigation';

export const SCHEMA_VERSION = 1 as const;
export const errorCodeSchema = z.enum(['GIT_NOT_FOUND', 'INVALID_REPOSITORY', 'UNSUPPORTED_REPOSITORY', 'UNSUPPORTED_PATH', 'UNSUPPORTED_FILTER', 'PERMISSION_DENIED', 'REPOSITORY_BUSY', 'OBJECT_UNAVAILABLE', 'OUTPUT_LIMIT', 'TIMEOUT', 'CANCELLED', 'STALE_RESULT', 'INTERNAL_ERROR', 'INVALID_REQUEST', 'UNAUTHORIZED', 'VERSION_MISMATCH', 'PICKER_UNAVAILABLE', 'PICKER_BUSY']);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export const appErrorSchema = z.object({ code: errorCodeSchema, message: z.string(), retryable: z.boolean().default(false) });
export type AppError = z.infer<typeof appErrorSchema>;
export class QueryError extends Error {
  constructor(public code: ErrorCode, message: string, public retryable = false) { super(message); this.name = 'QueryError'; }
}
export function toAppError(error: unknown): AppError {
  if (error instanceof QueryError) return { code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof Error && error.name === 'AbortError') return { code: 'CANCELLED', message: '读取已取消。', retryable: true };
  return { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : '读取失败。', retryable: true };
}

export const repositorySchema = z.object({ repositoryId: z.string(), worktreeId: z.string(), worktreeRoot: z.string(), gitDir: z.string(), commonGitDir: z.string() });
export type RepositoryIdentity = z.infer<typeof repositorySchema>;
export const headSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('branch'), branch: z.string(), oid: z.string() }),
  z.object({ kind: z.literal('detached'), oid: z.string() }),
  z.object({ kind: z.literal('unborn'), branch: z.string() }),
]);
export type HeadState = z.infer<typeof headSchema>;
export const comparisonSchema = z.enum(['head-index', 'index-worktree', 'untracked-preview', 'commit-parent']);
export type Comparison = z.infer<typeof comparisonSchema>;
export const changeSchema = z.object({
  id: z.string(), path: z.string(), rawPath: z.string(), oldPath: z.string().optional(), rawOldPath: z.string().optional(),
  kind: z.string(), comparison: comparisonSchema, supported: z.boolean().default(true),
});
export type ChangeEntry = z.infer<typeof changeSchema>;
export const changesSchema = z.object({ staged: z.array(changeSchema), unstaged: z.array(changeSchema), untracked: z.array(changeSchema), conflicts: z.array(changeSchema) });
export const rawOverviewSchema = z.object({ repository: repositorySchema, head: headSchema, operation: z.array(z.string()), changes: changesSchema, complete: z.boolean(), warnings: z.array(z.string()), fingerprint: z.string() });
export type RawOverview = z.infer<typeof rawOverviewSchema>;
export const stampSchema = z.object({ sessionId: z.string(), generation: z.number().int(), queryKey: z.string(), requestId: z.string(), observationId: z.string(), startedAt: z.string(), finishedAt: z.string() });
export type ReadStamp = z.infer<typeof stampSchema>;
export const evidenceSchema = z.object({ label: z.string(), target: z.enum(['head', 'change', 'history', 'status']), entryId: z.string().optional(), comparison: comparisonSchema.optional() });
export const explanationSchema = z.object({ questionId: z.enum(['location', 'changes', 'next-commit']), question: z.string(), ruleVersion: z.literal(1), answer: z.string(), conditions: z.array(z.string()), evidence: z.array(evidenceSchema), observationId: z.string() });
export type Explanation = z.infer<typeof explanationSchema>;
export const overviewSchema = rawOverviewSchema.extend({ stamp: stampSchema, explanations: z.array(explanationSchema) });
export type Overview = z.infer<typeof overviewSchema>;
export const diffSchema = z.object({
  entry: changeSchema, comparison: comparisonSchema, text: z.string(), format: z.enum(['diff', 'text', 'unavailable']),
  complete: z.boolean(), reason: z.string().optional(), base: z.string(), target: z.string(),
});
export type Diff = z.infer<typeof diffSchema>;
export const commitSchema = z.object({ oid: z.string(), parents: z.array(z.string()), author: z.string(), authoredAt: z.string(), subject: z.string(), refs: z.array(z.string()), boundary: z.boolean().default(false) });
export type CommitNode = z.infer<typeof commitSchema>;
export const historySchema = z.object({ commits: z.array(commitSchema), nextCursor: z.string().optional(), scope: historyScopeSchema, ref: historyRefSchema.optional(), order: historyOrderSchema.optional(), tipOid: z.string().optional(), shallow: z.boolean(), headOid: z.string().optional() });
export type History = z.infer<typeof historySchema>;
export const commitDetailSchema = z.object({ commit: commitSchema, base: z.string().nullable(), comparisonLabel: z.string(), changes: z.array(changeSchema) });
export type CommitDetail = z.infer<typeof commitDetailSchema>;
export const sessionSchema = z.object({ sessionId: z.string(), generation: z.number().int(), repository: repositorySchema });
export type RepositorySession = z.infer<typeof sessionSchema>;
export const recentSchema = z.object({ path: z.string(), worktreeId: z.string(), openedAt: z.string() });
export type RecentRepository = z.infer<typeof recentSchema>;
export const folderChoiceSchema = z.discriminatedUnion('cancelled', [
  z.object({ cancelled: z.literal(true) }),
  z.object({ cancelled: z.literal(false), path: z.string().min(1).max(32768) }),
]);
export type FolderChoice = z.infer<typeof folderChoiceSchema>;

// Transport inputs are validated at the HTTP boundary; arbitrary Git commands are never accepted.
const baseRequest = { schemaVersion: z.literal(1), requestId: z.string().min(1).max(100) };
const sessionRequest = { ...baseRequest, sessionId: z.string().min(1), generation: z.number().int().nonnegative() };
export const requestSchema = z.discriminatedUnion('action', [
  z.object({ ...baseRequest, action: z.literal('open'), path: z.string().min(1).max(32768) }),
  z.object({ ...baseRequest, action: z.literal('pick-folder') }).strict(),
  z.object({ ...baseRequest, action: z.literal('recents') }),
  z.object({ ...baseRequest, action: z.literal('heartbeat') }),
  z.object({ ...baseRequest, action: z.literal('shutdown') }),
  z.object({ ...baseRequest, action: z.literal('ticket'), sessionId: z.string() }),
  z.object({ ...sessionRequest, action: z.literal('overview') }),
  z.object({ ...sessionRequest, action: z.literal('navigation') }),
  z.object({ ...sessionRequest, action: z.literal('change'), entryId: z.string(), fingerprint: z.string() }),
  z.object({ ...sessionRequest, action: z.literal('history'), scope: historyScopeSchema, ref: historyRefSchema.optional(), order: historyOrderSchema.optional(), cursor: z.string().optional() }).superRefine((value, context) => {
    if ((value.scope === 'ref') !== (value.ref !== undefined)) context.addIssue({ code: 'custom', path: ['ref'], message: '按引用筛选时必须提供完整引用名；其他范围不能携带引用筛选。' });
  }),
  z.object({ ...sessionRequest, action: z.literal('commit'), oid: z.string() }),
  z.object({ ...sessionRequest, action: z.literal('commit-change'), oid: z.string(), entryId: z.string() }),
]);
export type ApiRequest = z.infer<typeof requestSchema>;
export function queryKey(request: ApiRequest, worktreeId: string): string {
  return JSON.stringify([worktreeId, request.action, 'entryId' in request ? request.entryId : null, 'oid' in request ? request.oid : null, 'scope' in request ? request.scope : null, 'ref' in request ? request.ref ?? null : null, 'cursor' in request ? request.cursor : null, request.action === 'history' ? resolveHistoryOrder(request) : null]);
}
export const resultDataSchema = z.union([overviewSchema, sessionSchema, diffSchema, historySchema, navigationSchema, commitDetailSchema, folderChoiceSchema, z.array(recentSchema), z.object({ ticket: z.string() }), z.object({ alive: z.boolean() })]);
export const responseSchema = z.discriminatedUnion('ok', [
  z.object({ schemaVersion: z.literal(1), ok: z.literal(true), data: resultDataSchema, stamp: stampSchema.optional() }),
  z.object({ schemaVersion: z.literal(1), ok: z.literal(false), error: appErrorSchema, stamp: stampSchema.optional(), requestId: z.string(), finishedAt: z.string() }),
]);
export type ApiResponse = z.infer<typeof responseSchema>;

export interface GitAdapter {
  resolveRepository(path: string, signal?: AbortSignal): Promise<RepositoryIdentity>;
  readOverview(repository: RepositoryIdentity, signal?: AbortSignal): Promise<RawOverview>;
  listNavigation(repository: RepositoryIdentity, signal?: AbortSignal): Promise<Navigation>;
  readChange(repository: RepositoryIdentity, entry: ChangeEntry, expectedFingerprint: string, signal?: AbortSignal): Promise<Diff>;
  listHistory(repository: RepositoryIdentity, options: HistoryOptions, signal?: AbortSignal): Promise<History>;
  readCommit(repository: RepositoryIdentity, oid: string, signal?: AbortSignal): Promise<CommitDetail>;
  readCommitChange(repository: RepositoryIdentity, oid: string, entry: ChangeEntry, signal?: AbortSignal): Promise<Diff>;
}
