import { z } from 'zod';
import { changeSchema, commitSchema } from './models';
import { historyRefSchema } from './navigation';

export const COMPARISON_LIMITS = Object.freeze({ snapshotsPerSession: 16, snapshotBytes: 1024 * 1024 });
export const revisionEndpointSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('head') }).strict(),
  z.object({ kind: z.literal('ref'), name: historyRefSchema }).strict(),
  z.object({ kind: z.literal('commit'), oid: z.string().regex(/^[a-f0-9]{4,64}$/i) }).strict(),
]);
export type RevisionEndpoint = z.infer<typeof revisionEndpointSchema>;
export const comparisonModeSchema = z.enum(['endpoints', 'merge-base']);
export type ComparisonMode = z.infer<typeof comparisonModeSchema>;
export const comparisonSideSchema = z.enum(['a', 'b']);
export type ComparisonSide = z.infer<typeof comparisonSideSchema>;
export const comparisonOptionsSchema = z.object({ a: revisionEndpointSchema, b: revisionEndpointSchema }).strict();
export type ComparisonOptions = z.infer<typeof comparisonOptionsSchema>;
const resolvedEndpoint = z.object({ selector: revisionEndpointSchema, label: z.string(), oid: z.string() });
const treeComparison = z.object({ base: z.string(), target: z.string(), changes: z.array(changeSchema) });
export const revisionComparisonSchema = z.object({
  comparisonId: z.string().uuid(), worktreeId: z.string(), observedAt: z.string(), historyKey: z.string(),
  a: resolvedEndpoint, b: resolvedEndpoint,
  mergeBases: z.object({ status: z.enum(['unique', 'multiple', 'none', 'incomplete']), oids: z.array(z.string()), reason: z.string().optional() }),
  exclusive: z.object({ a: z.number().int().nonnegative(), b: z.number().int().nonnegative(), complete: z.boolean() }),
  endpoints: treeComparison, fromMergeBase: treeComparison.optional(), warnings: z.array(z.string()),
});
export type RevisionComparison = z.infer<typeof revisionComparisonSchema>;
export const comparisonCommitsSchema = z.object({
  comparisonId: z.string().uuid(), side: comparisonSideSchema, commits: z.array(commitSchema), nextCursor: z.string().optional(), complete: z.boolean(),
});
export type ComparisonCommits = z.infer<typeof comparisonCommitsSchema>;
export interface ComparisonPageOptions { side: ComparisonSide; cursor?: string }
