import { afterAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RepositorySession } from '@git-view/contracts';
import { createOperations, type Operations } from '../../packages/operations/src/index.js';
import { createGitWriteAdapter } from '../../packages/git-write/src/index.js';
import { createGitAdapter } from '../../packages/git-cli/src/index.js';
import { cleanupFixtures, commit, fixtureGit as git, repository, temporaryDirectory, write } from '../fixtures/git.js';

afterAll(cleanupFixtures);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const receiptPath = (directory: string, id: string) => path.join(directory, 'operations', `${hash(id)}.json`);
const restorePendingMarker = (directory: string, id: string) => writeFileSync(path.join(directory, 'operations', 'pending', `${hash(id)}.json`), JSON.stringify({ schemaVersion: 1, operationId: id }), { mode: 0o600 });
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function setup(options: { writer?: ReturnType<typeof createGitWriteAdapter>; now?: () => number } = {}) {
  const root = repository();
  write(root, 'chosen.txt', 'V1\n'); write(root, 'other.txt', 'untouched\n'); commit(root);
  write(root, 'chosen.txt', 'V2\n');
  const read = createGitAdapter();
  const session: RepositorySession = { sessionId: randomUUID(), generation: 0, repository: await read.resolveRepository(root) };
  const directory = temporaryDirectory();
  const operations = await createOperations({ directory, read, ...options });
  return { root, read, session, directory, operations };
}
async function preview(operations: Operations, read: ReturnType<typeof createGitAdapter>, session: RepositorySession, kind: 'stage-files' | 'unstage-files' = 'stage-files') {
  const overview = await read.readOverview(session.repository);
  const group = kind === 'stage-files' ? [...overview.changes.unstaged, ...overview.changes.untracked] : overview.changes.staged;
  return operations.preview(session, { kind, entryIds: [group.find(entry => entry.path === 'chosen.txt')!.id], fingerprint: overview.fingerprint });
}

describe.skipIf(process.platform === 'win32')('durable file operation coordination (POSIX)', () => {
  it('stages V3 in full and unstages to V1 while preserving V3 and unselected files', async () => {
    const { root, read, session, operations, directory } = await setup();
    git(root, ['add', '--', 'chosen.txt']); write(root, 'chosen.txt', 'V3\n'); write(root, 'other.txt', 'not selected\n');
    const staged = await preview(operations, read, session);
    expect(staged.diffs[0]!.text).toContain('-V2\n+V3');
    expect(staged.warnings.join('')).toContain('整个文件');
    const operationId = randomUUID();
    const result = await operations.execute(session, staged.previewId, operationId);
    expect(result.status).toBe('succeeded');
    expect(git(root, ['show', ':chosen.txt'])).toBe('V3');
    expect(git(root, ['show', ':other.txt'])).toBe('untouched');
    expect(readFileSync(path.join(root, 'chosen.txt'), 'utf8')).toBe('V3\n');
    expect(lstatSync(receiptPath(directory, operationId)).mode & 0o777).toBe(0o600);
    expect(lstatSync(path.join(directory, 'operations')).mode & 0o777).toBe(0o700);
    const unstage = await preview(operations, read, session, 'unstage-files');
    expect((await operations.execute(session, unstage.previewId, randomUUID())).status).toBe('succeeded');
    expect(git(root, ['show', ':chosen.txt'])).toBe('V1');
    expect(readFileSync(path.join(root, 'chosen.txt'), 'utf8')).toBe('V3\n');
    expect(readFileSync(path.join(root, 'other.txt'), 'utf8')).toBe('not selected\n');
  });

  it('executes duplicate clicks exactly once and binds a preview to one operation', async () => {
    const real = createGitWriteAdapter(); let executions = 0;
    const writer = { ...real, execute: async (...args: Parameters<typeof real.execute>) => { executions++; return real.execute(...args); } };
    const { read, session, operations } = await setup({ writer });
    const shown = await preview(operations, read, session); const id = randomUUID();
    const [first, second] = await Promise.all([operations.execute(session, shown.previewId, id), operations.execute(session, shown.previewId, id)]);
    expect(first).toEqual(second); expect(first.status).toBe('succeeded'); expect(executions).toBe(1);
    await expect(operations.execute(session, shown.previewId, randomUUID())).rejects.toMatchObject({ code: 'STALE_RESULT' });
    await expect(operations.execute(session, randomUUID(), id)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('binds preview to exact session, generation, and repository', async () => {
    const { read, session, operations } = await setup(); const shown = await preview(operations, read, session);
    const other = await setup();
    await expect(operations.execute({ ...session, sessionId: randomUUID() }, shown.previewId, randomUUID())).rejects.toMatchObject({ code: 'STALE_RESULT' });
    await expect(operations.execute({ ...session, generation: 1 }, shown.previewId, randomUUID())).rejects.toMatchObject({ code: 'STALE_RESULT' });
    await expect(operations.execute(other.session, shown.previewId, randomUUID())).rejects.toMatchObject({ code: 'STALE_RESULT' });
    expect((await operations.execute(session, shown.previewId, randomUUID())).status).toBe('succeeded');
  });

  it('rejects stale, expired, duplicate, and wrong-group selections', async () => {
    let now = Date.now(); const context = await setup({ now: () => now }); const { root, read, session, operations } = context;
    const overview = await read.readOverview(session.repository); const entryId = overview.changes.unstaged[0]!.id;
    await expect(operations.preview(session, { kind: 'stage-files', entryIds: [entryId, entryId], fingerprint: overview.fingerprint })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(operations.preview(session, { kind: 'unstage-files', entryIds: [entryId], fingerprint: overview.fingerprint })).rejects.toMatchObject({ code: 'STALE_RESULT' });
    const shown = await preview(operations, read, session); now += 60_000;
    await expect(operations.execute(session, shown.previewId, randomUUID())).rejects.toMatchObject({ code: 'STALE_RESULT' });
    write(root, 'chosen.txt', 'V3\n');
    await expect(operations.preview(session, { kind: 'stage-files', entryIds: [entryId], fingerprint: overview.fingerprint })).rejects.toMatchObject({ code: 'STALE_RESULT' });
    expect(git(root, ['show', ':chosen.txt'])).toBe('V1');
  });

  it('persists a failed preflight without changing the index when files change after preview', async () => {
    const { root, read, session, operations } = await setup(); const shown = await preview(operations, read, session); const id = randomUUID();
    write(root, 'chosen.txt', 'changed after preview\n');
    const result = await operations.execute(session, shown.previewId, id);
    expect(result.status).toBe('failed'); expect(result.message).toContain('未更新暂存区');
    expect(await operations.receipt(session, id)).toEqual(result);
    expect(git(root, ['show', ':chosen.txt'])).toBe('V1');
  });

  it('warns for unavailable binary previews while still binding the exact bytes', async () => {
    const { root, read, session, operations } = await setup(); write(root, 'chosen.txt', Buffer.from([0, 1, 2, 3]));
    const shown = await preview(operations, read, session);
    expect(shown.diffs[0]!.format).toBe('unavailable'); expect(shown.warnings.join('')).toContain('仍将操作整个文件');
    expect((await operations.execute(session, shown.previewId, randomUUID())).status).toBe('succeeded');
    expect(git(root, ['diff', '--cached', '--numstat'])).toBe('-\t-\tchosen.txt');
  });

  it('recovers completed receipts across reopened sessions, refusing another repository', async () => {
    const { read, session, operations, directory } = await setup(); const shown = await preview(operations, read, session); const id = randomUUID();
    const result = await operations.execute(session, shown.previewId, id);
    const reopened = await createOperations({ directory, read }); const newSession = { ...session, sessionId: randomUUID() };
    expect(await reopened.receipt(newSession, id)).toEqual(result);
    expect(await reopened.execute(newSession, shown.previewId, id)).toEqual(result);
    await expect(reopened.receipt((await setup()).session, id)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const file = receiptPath(directory, id); const interrupted = JSON.parse(readFileSync(file, 'utf8'));
    interrupted.receipt.status = 'running'; delete interrupted.receipt.finishedAt; writeFileSync(file, JSON.stringify(interrupted));
    restorePendingMarker(directory, id);
    expect((await reopened.pending(newSession)).receipts).toMatchObject([{ operationId: id, status: 'succeeded' }]);
  });

  it('verifies success after the executor loses its final response instead of retrying', async () => {
    const real = createGitWriteAdapter(); let executions = 0;
    const writer = { ...real, execute: async (...args: Parameters<typeof real.execute>) => { executions++; await real.execute(...args); throw new Error('simulated lost response'); } };
    const { read, session, operations, directory } = await setup({ writer }); const shown = await preview(operations, read, session); const id = randomUUID();
    const result = await operations.execute(session, shown.previewId, id);
    expect(result.status).toBe('succeeded'); expect(result.message).toContain('响应异常');
    const reopened = await createOperations({ directory, read, writer });
    expect((await reopened.execute({ ...session, sessionId: randomUUID() }, shown.previewId, id)).status).toBe('succeeded'); expect(executions).toBe(1);
  });

  it('keeps interrupted install evidence unknown across restart and never runs it again', async () => {
    const real = createGitWriteAdapter(); let executions = 0;
    const writer = { ...real, execute: async (prepared: Parameters<typeof real.execute>[0], before: Parameters<typeof real.execute>[1]) => {
      executions++;
      await real.execute(prepared, async evidence => { await before(evidence); throw new Error('simulated interruption before index installation'); });
    } };
    const { root, read, session, operations, directory } = await setup({ writer }); const shown = await preview(operations, read, session); const id = randomUUID();
    expect((await operations.execute(session, shown.previewId, id)).status).toBe('unknown');
    // Model a process exit after evidence was durable but before the final receipt.
    const file = receiptPath(directory, id); const record = JSON.parse(readFileSync(file, 'utf8'));
    record.receipt.status = 'running'; delete record.receipt.finishedAt; writeFileSync(file, JSON.stringify(record));
    const reopened = await createOperations({ directory, read, writer });
    const recovered = await reopened.pending({ ...session, sessionId: randomUUID() });
    expect(recovered.receipts).toMatchObject([{ operationId: id, status: 'unknown' }]);
    expect((await reopened.receipt(session, id)).status).toBe('unknown');
    expect(await reopened.pending((await setup()).session)).toEqual({ receipts: [] });
    expect((await reopened.execute(session, shown.previewId, id)).status).toBe('unknown');
    expect(executions).toBe(1); expect(git(root, ['show', ':chosen.txt'])).toBe('V1');
  });

  it('reconciles an interrupted record without installation evidence as safely failed', async () => {
    const real = createGitWriteAdapter(); let executions = 0;
    const writer = { ...real, execute: async () => { executions++; throw new Error('preflight failure'); } };
    const { read, session, operations, directory } = await setup({ writer }); const shown = await preview(operations, read, session); const id = randomUUID();
    expect((await operations.execute(session, shown.previewId, id)).status).toBe('failed');
    const file = receiptPath(directory, id); const record = JSON.parse(readFileSync(file, 'utf8')); record.receipt.status = 'running'; delete record.receipt.finishedAt; writeFileSync(file, JSON.stringify(record));
    restorePendingMarker(directory, id);
    const reopened = await createOperations({ directory, read, writer });
    expect((await reopened.pending(session)).receipts).toMatchObject([{ operationId: id, status: 'failed' }]);
    expect((await reopened.receipt(session, id)).status).toBe('failed'); expect(executions).toBe(1);
    expect(await reopened.pending(session)).toEqual({ receipts: [] });
  });

  it('serializes two service instances and returns running during an accepted execution', async () => {
    const real = createGitWriteAdapter(); const entered = defer(); const continueWrite = defer(); let executions = 0;
    const writer = { ...real, execute: async (...args: Parameters<typeof real.execute>) => { executions++; entered.resolve(); await continueWrite.promise; return real.execute(...args); } };
    const { root, read, session, operations, directory } = await setup({ writer });
    const second = await createOperations({ directory, read }); const firstPreview = await preview(operations, read, session); const secondPreview = await preview(second, read, session);
    const id = randomUUID(); const first = operations.execute(session, firstPreview.previewId, id); await entered.promise;
    expect((await second.receipt(session, id)).status).toBe('running');
    const competing = second.execute(session, secondPreview.previewId, randomUUID());
    continueWrite.resolve();
    expect((await first).status).toBe('succeeded'); expect((await competing).status).toBe('failed');
    expect(executions).toBe(1); expect(git(root, ['show', ':chosen.txt'])).toBe('V2');
  });

  it('does not delete an existing persistent operation lock', async () => {
    const { read, session, operations, directory } = await setup(); const shown = await preview(operations, read, session);
    const file = path.join(directory, 'operations', `${hash(session.repository.gitDir)}.lock`);
    const content = JSON.stringify({ schemaVersion: 1, token: randomUUID(), ownerId: randomUUID(), pid: process.pid }); writeFileSync(file, content, { mode: 0o600 });
    await expect(operations.execute(session, shown.previewId, randomUUID())).rejects.toMatchObject({ code: 'REPOSITORY_BUSY' });
    expect(readFileSync(file, 'utf8')).toBe(content);
    unlinkSync(file);
    expect((await operations.execute(session, shown.previewId, randomUUID())).status).toBe('succeeded');
  });

  it('atomically reserves an operation ID across two different repositories', async () => {
    const first = await setup(); const second = await setup();
    const otherOperations = await createOperations({ directory: first.directory, read: second.read });
    const firstPreview = await preview(first.operations, first.read, first.session);
    const secondPreview = await preview(otherOperations, second.read, second.session);
    const id = randomUUID();
    const outcomes = await Promise.allSettled([
      first.operations.execute(first.session, firstPreview.previewId, id),
      otherOperations.execute(second.session, secondPreview.previewId, id),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(outcome => outcome.status === 'rejected')).toMatchObject({ reason: { code: 'INVALID_REQUEST' } });
    expect([git(first.root, ['show', ':chosen.txt']), git(second.root, ['show', ':chosen.txt'])].sort()).toEqual(['V1', 'V2']);
  });

  it('does not scan completed history but refuses an incomplete scan of outstanding operations', async () => {
    const { read, session, operations, directory } = await setup(); const shown = await preview(operations, read, session); const id = randomUUID();
    await operations.execute(session, shown.previewId, id);
    const record = JSON.parse(readFileSync(receiptPath(directory, id), 'utf8'));
    const ids = [id];
    for (let index = 0; index < 1000; index++) {
      const operationId = randomUUID();
      ids.push(operationId);
      writeFileSync(receiptPath(directory, operationId), JSON.stringify({ ...record, receipt: { ...record.receipt, operationId } }), { mode: 0o600 });
    }
    expect(await operations.pending(session)).toEqual({ receipts: [] });
    for (const operationId of ids) {
      writeFileSync(receiptPath(directory, operationId), JSON.stringify({ ...record, receipt: { ...record.receipt, operationId, status: 'unknown' } }), { mode: 0o600 });
      restorePendingMarker(directory, operationId);
    }
    await expect(operations.pending(session)).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
  });

  it('fails closed for corrupted, insecure, and symlinked receipt files', async () => {
    const { read, session, operations, directory } = await setup(); const shown = await preview(operations, read, session); const id = randomUUID();
    await operations.execute(session, shown.previewId, id);
    const file = receiptPath(directory, id); const original = readFileSync(file, 'utf8'); const record = JSON.parse(original); record.unrecognized = true; writeFileSync(file, JSON.stringify(record));
    restorePendingMarker(directory, id);
    await expect(operations.receipt(session, id)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    await expect(operations.pending(session)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    writeFileSync(file, original); chmodSync(file, 0o644);
    await expect(operations.receipt(session, id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    chmodSync(file, 0o600);
    if (process.platform !== 'win32') {
      const target = path.join(temporaryDirectory(), 'target'); writeFileSync(target, original, { mode: 0o600 }); unlinkSync(file); symlinkSync(target, file);
      await expect(operations.receipt(session, id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(readFileSync(target, 'utf8')).toBe(original);
    }
  });
});
