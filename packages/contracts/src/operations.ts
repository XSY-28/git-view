import { z } from 'zod';
import { appErrorSchema, changeSchema, diffSchema } from './models';

/** Deliberately separate from the read-only CLI/query protocol. */
export const operationKindSchema = z.enum(['stage-files', 'unstage-files']);
export type OperationKind = z.infer<typeof operationKindSchema>;
export const OPERATION_LIMITS = { previewLifetimeMs: 60_000, selectedFiles: 200 } as const;
const id = z.string().uuid();
const base = { schemaVersion: z.literal(1), requestId: z.string().min(1).max(100), sessionId: z.string().min(1).max(200) };
export const operationRequestSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('preview'), kind: operationKindSchema, entryIds: z.array(z.string().min(1).max(512)).min(1).max(OPERATION_LIMITS.selectedFiles), fingerprint: z.string().min(1).max(512) }).strict(),
  z.object({ ...base, action: z.literal('execute'), previewId: id, operationId: id }).strict(),
  z.object({ ...base, action: z.literal('receipt'), operationId: id }).strict(),
  z.object({ ...base, action: z.literal('pending') }).strict(),
]);
export type OperationRequest = z.infer<typeof operationRequestSchema>;
export const operationPreviewSchema = z.object({
  previewId: id, worktreeId: z.string(), kind: operationKindSchema,
  createdAt: z.string(), expiresAt: z.string(), files: z.array(changeSchema),
  diffs: z.array(diffSchema), warnings: z.array(z.string()),
});
export type OperationPreview = z.infer<typeof operationPreviewSchema>;
export const operationReceiptSchema = z.object({
  operationId: id, previewId: id, worktreeId: z.string(), kind: operationKindSchema,
  status: z.enum(['running', 'succeeded', 'failed', 'unknown']), message: z.string(), paths: z.array(z.string()),
  startedAt: z.string(), finishedAt: z.string().optional(),
});
export type OperationReceipt = z.infer<typeof operationReceiptSchema>;
export const pendingOperationsSchema = z.object({ receipts: z.array(operationReceiptSchema) });
export const operationResponseSchema = z.discriminatedUnion('ok', [
  z.object({ schemaVersion: z.literal(1), ok: z.literal(true), data: z.union([operationPreviewSchema, operationReceiptSchema, pendingOperationsSchema]) }),
  z.object({ schemaVersion: z.literal(1), ok: z.literal(false), error: appErrorSchema, requestId: z.string(), finishedAt: z.string() }),
]);
