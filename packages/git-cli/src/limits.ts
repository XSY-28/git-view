/** Shared read budgets. Adapter instances may lower these for a constrained host. */
export const DEFAULT_READ_LIMITS = Object.freeze({
  timeoutMs: 10_000,
  maxOutputBytes: 16 * 1024 * 1024,
  stderrPreviewChars: 2000,
  previewBytes: 1024 * 1024,
  previewLines: 10_000,
  historyPageSize: 200,
  historyCursorCount: 100,
  investigationCommitLimit: 20_000,
  metadataBatchSize: 64,
  consistencyRetries: 2,
});
export type ReadLimits = { [K in keyof typeof DEFAULT_READ_LIMITS]: number };
export function readLimits(overrides: Partial<ReadLimits> = {}): ReadLimits {
  const limits = { ...DEFAULT_READ_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (key === 'consistencyRetries' ? 0 : 1)) throw new RangeError(`Invalid Git read limit: ${key}`);
  }
  // A busy repository must not cause an unbounded or host-configured retry loop.
  if (limits.consistencyRetries > DEFAULT_READ_LIMITS.consistencyRetries) throw new RangeError('At most two consistency retries are supported.');
  return limits;
}
