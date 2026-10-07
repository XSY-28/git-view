import { z } from 'zod';
import { changeSchema, commitSchema } from './models';
import { historyRefSchema, historyScopeSchema } from './navigation';
import { revisionEndpointSchema } from './comparison';

export const INVESTIGATION_LIMITS = Object.freeze({ snapshots: 16, cursors: 100, snapshotBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 });
export const repositoryPathSchema = z.string().min(1).max(32768).refine(value => !value.includes('\0') && !/^(?:[\/\\]|[a-z]:)/i.test(value) && !value.split('/').some(part => part === '.' || part === '..'), '需要仓库内的相对文件路径。');
export const searchFieldSchema = z.enum(['subject', 'author', 'oid', 'path']);
export const searchOptionsSchema = z.object({ scope: historyScopeSchema, ref: historyRefSchema.optional(), field: searchFieldSchema, term: z.string().min(1).max(2048), cursor: z.string().uuid().optional() }).strict().superRefine((value, context) => {
  if ((value.scope === 'ref') !== (value.ref !== undefined)) context.addIssue({ code: 'custom', path: ['ref'], message: '按引用筛选时必须提供完整引用名。' });
  if (value.field === 'oid' && !/^[a-f0-9]{4,64}$/i.test(value.term)) context.addIssue({ code: 'custom', path: ['term'], message: '提交 ID 至少包含四位十六进制字符。' });
  if (value.field === 'path' && !repositoryPathSchema.safeParse(value.term).success) context.addIssue({ code: 'custom', path: ['term'], message: '需要仓库内的相对文件路径。' });
});
export type SearchOptions = z.infer<typeof searchOptionsSchema>;
const pageIdentity = { snapshotId: z.string().uuid(), worktreeId: z.string(), observedAt: z.string(), historyKey: z.string(), complete: z.boolean(), warnings: z.array(z.string()), nextCursor: z.string().uuid().optional() };
export const searchPageSchema = z.object({ ...pageIdentity, scope: historyScopeSchema, ref: z.string().optional(), field: searchFieldSchema, term: z.string(), tips: z.array(z.string()), commits: z.array(commitSchema) });
export type SearchPage = z.infer<typeof searchPageSchema>;
export const fileHistoryOptionsSchema = z.object({ endpoint: revisionEndpointSchema, path: repositoryPathSchema, cursor: z.string().uuid().optional() }).strict();
export type FileHistoryOptions = z.infer<typeof fileHistoryOptionsSchema>;
export const fileHistoryEntrySchema = z.object({ entryId: z.string(), commit: commitSchema, change: changeSchema, base: z.string().nullable() });
export type FileHistoryEntry = z.infer<typeof fileHistoryEntrySchema>;
export const fileHistoryPageSchema = z.object({ ...pageIdentity, tipOid: z.string(), path: z.string(), firstParent: z.literal(true), entries: z.array(fileHistoryEntrySchema) });
export type FileHistoryPage = z.infer<typeof fileHistoryPageSchema>;
export const fileSideSchema = z.enum(['before', 'after']);
export type FileSide = z.infer<typeof fileSideSchema>;
export const blameLineSchema = z.object({ line: z.number().int().positive(), originalLine: z.number().int().positive(), oid: z.string(), author: z.string(), email: z.string(), authoredAt: z.string(), subject: z.string(), path: z.string(), text: z.string(), boundary: z.boolean() });
export const blameSchema = z.object({ snapshotId: z.string().uuid(), entryId: z.string(), side: fileSideSchema, oid: z.string(), path: z.string(), lines: z.array(blameLineSchema), complete: z.boolean(), warnings: z.array(z.string()) });
export type Blame = z.infer<typeof blameSchema>;
export const recordKindSchema = z.enum(['stash', 'reflog']);
export const recordOptionsSchema = z.object({ kind: recordKindSchema, ref: z.union([z.literal('HEAD'), historyRefSchema]).optional(), cursor: z.string().uuid().optional() }).strict().superRefine((value, context) => {
  if (value.kind === 'stash' && value.ref !== undefined) context.addIssue({ code: 'custom', path: ['ref'], message: 'stash 使用自己的引用记录。' });
});
export type RecordOptions = z.infer<typeof recordOptionsSchema>;
export const repositoryRecordSchema = z.object({ recordId: z.string(), selector: z.string(), oldOid: z.string(), newOid: z.string(), actor: z.string(), recordedAt: z.string(), message: z.string(), availability: z.enum(['commit', 'unavailable', 'other', 'deleted']) });
export type RepositoryRecord = z.infer<typeof repositoryRecordSchema>;
export const recordPageSchema = z.object({ ...pageIdentity, kind: recordKindSchema, ref: z.string(), entries: z.array(repositoryRecordSchema) });
export type RecordPage = z.infer<typeof recordPageSchema>;
export const stashPartSchema = z.enum(['worktree', 'index', 'untracked']);
export type StashPart = z.infer<typeof stashPartSchema>;
export const stashDetailSchema = z.object({ snapshotId: z.string().uuid(), recordId: z.string(), commit: commitSchema, parts: z.array(z.object({ kind: stashPartSchema, base: z.string().nullable(), target: z.string(), changes: z.array(changeSchema) })), warnings: z.array(z.string()) });
export type StashDetail = z.infer<typeof stashDetailSchema>;

export const investigationFilterKey = (options: SearchOptions | FileHistoryOptions | RecordOptions): string => {
  const { cursor: _cursor, ...fields } = options;
  return JSON.stringify(fields);
};
