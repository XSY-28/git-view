import { z } from 'zod';
import { appErrorSchema, changeSchema, diffSchema } from './models';

/** Deliberately separate from the read-only CLI/query protocol. */
export const indexOperationKindSchema = z.enum(['stage-files', 'unstage-files']);
export const operationKindSchema = z.enum(['stage-files', 'unstage-files', 'commit', 'create-branch', 'switch-branch']);
export type OperationKind = z.infer<typeof operationKindSchema>;
export const OPERATION_LIMITS = { previewLifetimeMs: 60_000, selectedFiles: 200, messageLength: 16_384, executionTimeoutMs: 120_000 } as const;
const id = z.string().uuid();
const fingerprint = z.string().min(1).max(512);
const branch = z.string().min(1).max(512).refine(value => !value.includes('\0'));
const indexInput = z.object({ kind: indexOperationKindSchema, entryIds: z.array(z.string().min(1).max(512)).min(1).max(OPERATION_LIMITS.selectedFiles), fingerprint }).strict();
const commitInput = z.object({ kind: z.literal('commit'), message: z.string().min(1).max(OPERATION_LIMITS.messageLength).refine(value => Boolean(value.trim()) && !value.includes('\0')), fingerprint }).strict();
const createInput = z.object({ kind: z.literal('create-branch'), branch, fingerprint }).strict();
const switchInput = z.object({ kind: z.literal('switch-branch'), branch, fingerprint }).strict();
export const operationInputSchema = z.discriminatedUnion('kind', [indexInput, commitInput, createInput, switchInput]);
export type OperationInput = z.infer<typeof operationInputSchema>;
export type RepositoryOperationInput = Exclude<OperationInput, { kind: 'stage-files' | 'unstage-files' }>;
const base = { schemaVersion: z.literal(1), requestId: z.string().min(1).max(100), sessionId: z.string().min(1).max(200) };
const previewBase = { ...base, action: z.literal('preview') };
export const operationRequestSchema = z.union([
  indexInput.extend(previewBase), commitInput.extend(previewBase), createInput.extend(previewBase), switchInput.extend(previewBase),
  z.object({ ...base, action: z.literal('execute'), previewId: id, operationId: id, allowHooks: z.boolean().optional() }).strict(),
  z.object({ ...base, action: z.literal('receipt'), operationId: id }).strict(),
  z.object({ ...base, action: z.literal('pending') }).strict(),
]);
export type OperationRequest = z.infer<typeof operationRequestSchema>;
export const operationPreviewSchema = z.object({
  previewId: id, worktreeId: z.string(), kind: operationKindSchema,
  createdAt: z.string(), expiresAt: z.string(), files: z.array(changeSchema),
  diffs: z.array(diffSchema), warnings: z.array(z.string()),
  context: z.object({ headOid: z.string().nullable(), branch: z.string().nullable(), targetOid: z.string().optional(), targetBranch: z.string().optional(), message: z.string().optional() }).optional(),
  requiresHookConsent: z.boolean().optional(),
});
export type OperationPreview = z.infer<typeof operationPreviewSchema>;
export const operationResultSchema = z.object({
  headOid: z.string().nullable(), branch: z.string().nullable(),
  createdOid: z.string().optional(), targetBranch: z.string().optional(), treeOid: z.string().optional(), parents: z.array(z.string()).optional(),
  previewMatched: z.boolean().optional(), changedPaths: z.array(z.string()).optional(),
  remaining: z.object({ staged: z.number(), unstaged: z.number(), untracked: z.number(), conflicts: z.number() }).optional(),
  diagnostic: z.string().optional(),
});
export const operationReceiptSchema = z.object({
  operationId: id, previewId: id, worktreeId: z.string(), kind: operationKindSchema,
  status: z.enum(['running', 'succeeded', 'failed', 'unknown']), message: z.string(), paths: z.array(z.string()),
  startedAt: z.string(), finishedAt: z.string().optional(), result: operationResultSchema.optional(),
});
export type OperationReceipt = z.infer<typeof operationReceiptSchema>;
export type OperationResult = z.infer<typeof operationResultSchema>;
export const pendingOperationsSchema = z.object({ receipts: z.array(operationReceiptSchema) });
export const operationResponseSchema = z.discriminatedUnion('ok', [
  z.object({ schemaVersion: z.literal(1), ok: z.literal(true), data: z.union([operationPreviewSchema, operationReceiptSchema, pendingOperationsSchema]) }),
  z.object({ schemaVersion: z.literal(1), ok: z.literal(false), error: appErrorSchema, requestId: z.string(), finishedAt: z.string() }),
]);
