import { z } from 'zod';
import { navigationSchema, historyScopeSchema, historyRefSchema, historyOrderSchema, resolveHistoryOrder, type Navigation, type HistoryOptions } from './navigation';
export * from './navigation';

import { appErrorSchema, overviewSchema, sessionSchema, diffSchema, historySchema, commitDetailSchema, folderChoiceSchema, recentSchema, stampSchema, type RepositoryIdentity, type RepositorySession, type RawOverview, type ChangeEntry, type Diff, type History, type CommitDetail } from './models';
export * from './models';
export * from './operations';
export * from './preferences';
export * from './comparison';
import { comparisonOptionsSchema, comparisonModeSchema, comparisonSideSchema, revisionComparisonSchema, comparisonCommitsSchema, type ComparisonOptions, type ComparisonPageOptions, type RevisionComparison, type ComparisonCommits, type ComparisonMode } from './comparison';
import { languageSchema, preferencesSchema } from './preferences';

// Transport inputs are validated at the HTTP boundary; arbitrary Git commands are never accepted.
const baseRequest = { schemaVersion: z.literal(1), requestId: z.string().min(1).max(100) };
const sessionRequest = { ...baseRequest, sessionId: z.string().min(1), generation: z.number().int().nonnegative() };
export const requestSchema = z.discriminatedUnion('action', [
  z.object({ ...baseRequest, action: z.literal('open'), path: z.string().min(1).max(32768) }),
  z.object({ ...baseRequest, action: z.literal('pick-folder') }).strict(),
  z.object({ ...baseRequest, action: z.literal('recents') }),
  z.object({ ...baseRequest, action: z.literal('preferences') }).strict(),
  z.object({ ...baseRequest, action: z.literal('set-language'), language: languageSchema }).strict(),
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
  z.object({ ...sessionRequest, action: z.literal('compare'), ...comparisonOptionsSchema.shape }).strict(),
  z.object({ ...sessionRequest, action: z.literal('comparison-commits'), comparisonId: z.string().uuid(), side: comparisonSideSchema, cursor: z.string().uuid().optional() }).strict(),
  z.object({ ...sessionRequest, action: z.literal('comparison-change'), comparisonId: z.string().uuid(), mode: comparisonModeSchema, entryId: z.string() }).strict(),
]);
export type ApiRequest = z.infer<typeof requestSchema>;
export function queryKey(request: ApiRequest, worktreeId: string): string {
  return JSON.stringify([worktreeId, request.action, 'entryId' in request ? request.entryId : null, 'oid' in request ? request.oid : null, 'scope' in request ? request.scope : null, 'ref' in request ? request.ref ?? null : null, 'cursor' in request ? request.cursor : null, request.action === 'history' ? resolveHistoryOrder(request) : null, ...('comparisonId' in request ? [request.comparisonId, 'side' in request ? request.side : null, 'mode' in request ? request.mode : null] : request.action === 'compare' ? [request.a, request.b] : [])]);
}
export const resultDataSchema = z.union([overviewSchema, sessionSchema, diffSchema, historySchema, navigationSchema, commitDetailSchema, revisionComparisonSchema, comparisonCommitsSchema, folderChoiceSchema, preferencesSchema, z.array(recentSchema), z.object({ ticket: z.string() }), z.object({ alive: z.boolean() })]);
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
  compareRevisions(repository: RepositoryIdentity, options: ComparisonOptions, signal?: AbortSignal): Promise<RevisionComparison>;
  listComparisonCommits(repository: RepositoryIdentity, comparison: RevisionComparison, options: ComparisonPageOptions, signal?: AbortSignal): Promise<ComparisonCommits>;
  readComparisonChange(repository: RepositoryIdentity, comparison: RevisionComparison, mode: ComparisonMode, entry: ChangeEntry, signal?: AbortSignal): Promise<Diff>;
}
