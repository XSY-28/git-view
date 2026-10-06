import { afterEach, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRepositoryQueries } from '@git-view/core';
import { createGitAdapter } from '@git-view/git-cli';
import { operationPreviewSchema, operationReceiptSchema, operationResponseSchema, operationRequestSchema } from '@git-view/contracts';
import { startLocalServer } from '../../apps/local/src/server';
import { runStdio } from '../../apps/local/src/stdio';
import { cleanupFixtures, commit, fixtureGit, repository, temporaryDirectory, write } from '../fixtures/git';

const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); await cleanupFixtures(); });
async function setup() {
  const root = repository(); write(root, 'selected.txt', 'V1\n'); commit(root);
  write(root, 'selected.txt', 'V2\n'); fixtureGit(root, ['add', '--', 'selected.txt']);
  write(root, 'selected.txt', 'V3\n'); write(root, 'leave.txt', 'untouched\n');
  const read = createGitAdapter(); const queries = createRepositoryQueries(read);
  const session = await queries.open(root);
  const server = await startLocalServer({ queries, directory: temporaryDirectory(), persist: false }); closers.push(server.close);
  const post = (route: string, body: unknown, headers: Record<string, string>) => fetch(`${server.origin}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const cli = { Authorization: `Bearer ${server.record.cliToken}` };
  const ticket = await (await post('/api', { schemaVersion: 1, requestId: 'ticket', action: 'ticket', sessionId: session.sessionId }, cli)).json() as { data: { ticket: string } };
  const auth = await post('/auth', { schemaVersion: 1, ticket: ticket.data.ticket }, { Origin: server.origin });
  const browser = { Origin: server.origin, Cookie: auth.headers.get('set-cookie')!.split(';')[0]! };
  const overview = await read.readOverview(session.repository);
  const preview = { schemaVersion: 1, requestId: 'preview', sessionId: session.sessionId, action: 'preview', kind: 'stage-files', entryIds: [overview.changes.unstaged[0]!.id], fingerprint: overview.fingerprint };
  return { root, read, queries, session, server, post, cli, browser, preview };
}
it.skipIf(process.platform === 'win32')('only the authorized page can preview and execute an index write; the CLI and read endpoint stay read-only', async () => {
  const f = await setup(); const before = readFileSync(join(f.root, '.git/index'));
  const unauthorizedHeaders: Record<string, string>[] = [{}, f.cli, { Origin: 'https://example.invalid', Cookie: f.browser.Cookie }];
  for (const headers of unauthorizedHeaders) {
    expect((await f.post('/api/operations', f.preview, headers)).status).toBe(403);
  }
  expect((await f.post('/api', f.preview, f.browser)).status).toBe(400);
  expect((await f.post('/api/operations', { ...f.preview, sessionId: 'other-session' }, f.browser)).status).toBe(403);
  expect((await f.post('/api/operations', { ...f.preview, paths: ['leave.txt'] }, f.browser)).status).toBe(400);
  expect(readFileSync(join(f.root, '.git/index'))).toEqual(before);
  const previewResponse = operationResponseSchema.parse(await (await f.post('/api/operations', f.preview, f.browser)).json());
  expect(previewResponse.ok).toBe(true); if (!previewResponse.ok) throw new Error(previewResponse.error.message);
  const preview = operationPreviewSchema.parse(previewResponse.data);
  const operationId = randomUUID();
  const execute = { schemaVersion: 1, requestId: 'execute', sessionId: f.session.sessionId, action: 'execute', previewId: preview.previewId, operationId };
  const result = operationResponseSchema.parse(await (await f.post('/api/operations', execute, f.browser)).json());
  expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.message);
  expect(operationReceiptSchema.parse(result.data).status).toBe('succeeded');
  expect(fixtureGit(f.root, ['show', ':selected.txt'])).toBe('V3');
  expect(fixtureGit(f.root, ['ls-files', '--', 'leave.txt'])).toBe('');
  expect(readFileSync(join(f.root, 'selected.txt'), 'utf8')).toBe('V3\n');
  const repeat = operationResponseSchema.parse(await (await f.post('/api/operations', execute, f.browser)).json());
  expect(repeat).toEqual(result);
  const other = await f.queries.open(repository());
  // Even an authorized page for a different repository cannot recover this receipt.
  const anotherTicket = await (await f.post('/api', { schemaVersion: 1, requestId: 'another', action: 'ticket', sessionId: other.sessionId }, f.cli)).json() as { data: { ticket: string } };
  await f.post('/auth', { schemaVersion: 1, ticket: anotherTicket.data.ticket }, f.browser);
  const wrong = operationResponseSchema.parse(await (await f.post('/api/operations', { ...execute, action: 'receipt', previewId: undefined, sessionId: other.sessionId }, f.browser)).json());
  expect(wrong.ok).toBe(false);
});
it('the write protocol rejects path overrides, arbitrary commands, empty and excessive selections', () => {
  const base = { schemaVersion: 1, requestId: 'x', sessionId: 'session' };
  expect(operationRequestSchema.safeParse({ ...base, action: 'execute', previewId: randomUUID(), operationId: randomUUID(), paths: ['anything'] }).success).toBe(false);
  expect(operationRequestSchema.safeParse({ ...base, action: 'exec', command: 'git add .' }).success).toBe(false);
  for (const entryIds of [[], Array.from({ length: 201 }, (_, i) => `${i}`)]) expect(operationRequestSchema.safeParse({ ...base, action: 'preview', kind: 'stage-files', entryIds, fingerprint: 'snapshot' }).success).toBe(false);
  for (const operation of [{ kind: 'commit', message: 'ordinary commit' }, { kind: 'create-branch', branch: 'topic/new' }, { kind: 'switch-branch', branch: 'main' }]) {
    const request = { ...base, action: 'preview', fingerprint: 'snapshot', ...operation };
    expect(operationRequestSchema.safeParse(request).success).toBe(true);
    for (const override of [{ args: ['--force'] }, { amend: true }, { paths: ['file'] }, { allowHooks: true }]) expect(operationRequestSchema.safeParse({ ...request, ...override }).success).toBe(false);
  }
});
it.skipIf(process.platform === 'win32')('ordinary stdio stays read-only and only the desktop capability enables the separate write envelope', async () => {
  const root = repository(); write(root, 'file', 'new\n');
  for (const allowWrites of [false, true]) {
    const input = new PassThrough(); const output = new PassThrough(); const messages: unknown[] = []; let pending = '';
    output.on('data', chunk => { pending += chunk.toString(); let index: number; while ((index = pending.indexOf('\n')) >= 0) { messages.push(JSON.parse(pending.slice(0, index))); pending = pending.slice(index + 1); } });
    const read = createGitAdapter(); const queries = createRepositoryQueries(read); const session = await queries.open(root);
    const channel = await runStdio(queries, temporaryDirectory(), input, output, { allowWrites }); closers.push(() => { channel.close(); input.destroy(); output.destroy(); });
    const overview = await read.readOverview(session.repository);
    input.write(`${JSON.stringify({ id: 'write', operation: 'write', request: { schemaVersion: 1, requestId: 'write', sessionId: session.sessionId, action: 'preview', kind: 'stage-files', entryIds: [overview.changes.untracked[0]!.id], fingerprint: overview.fingerprint } })}\n`);
    await expect.poll(() => messages.length, { timeout: 10_000 }).toBe(1);
    const result = operationResponseSchema.parse((messages[0] as { response: unknown }).response);
    expect(result.ok).toBe(allowWrites);
    if (!result.ok) expect(result.error.code).toBe('UNAUTHORIZED');
  }
  expect(fixtureGit(root, ['ls-files'])).toBe('');
});
