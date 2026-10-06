import { z } from 'zod';

export const navigationRefSchema = z.object({
  name: z.string(), oid: z.string(), kind: z.enum(['local', 'remote', 'tag']), current: z.boolean().optional(),
});
export type NavigationRef = z.infer<typeof navigationRefSchema>;
export const worktreeSchema = z.object({
  path: z.string(), headOid: z.string().optional(), branch: z.string().optional(),
  bare: z.boolean().optional(), detached: z.boolean().optional(), locked: z.string().optional(), prunable: z.string().optional(),
});
export const navigationSchema = z.object({ refs: z.array(navigationRefSchema), worktrees: z.array(worktreeSchema) });
export type Navigation = z.infer<typeof navigationSchema>;

export const historyScopeSchema = z.enum(['all', 'head', 'ref']);
export type HistoryScope = z.infer<typeof historyScopeSchema>;
export const historyOrderSchema = z.enum(['date', 'topo']);
export type HistoryOrder = z.infer<typeof historyOrderSchema>;
// Full reference names are data, never revision expressions or command options.
export const historyRefSchema = z.string().min(1).max(1024).regex(/^refs\/(heads|remotes|tags)\/.+/);
export interface HistoryOptions { scope: HistoryScope; ref?: string; cursor?: string; order?: HistoryOrder }
export const resolveHistoryOrder = (options: Pick<HistoryOptions, 'scope' | 'order'>): HistoryOrder => options.order ?? (options.scope === 'all' ? 'date' : 'topo');
export const historyFilterKey = (options: HistoryOptions): string => JSON.stringify([options.scope, options.ref ?? null, resolveHistoryOrder(options)]);
