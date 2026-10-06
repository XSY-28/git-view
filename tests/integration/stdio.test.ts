import { afterEach, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createRepositoryQueries } from '@git-view/core';
import { createGitAdapter } from '@git-view/git-cli';
import { runStdio } from '../../apps/local/src/stdio';
import { RepositoryWatchers } from '../../apps/local/src/watch';
import { repository, write, commit, cleanupFixtures, temporaryDirectory, fingerprint } from '../fixtures/git';

const services: {close():void}[] = [];
afterEach(async () => { services.splice(0).forEach(service => service.close()); await cleanupFixtures(); });
async function channel() {
  const input = new PassThrough(); const output = new PassThrough();
  const values = new Map<string, any>(); let buffer = '';
  output.on('data', chunk => {
    buffer += chunk.toString(); let split: number;
    while ((split = buffer.indexOf('\n')) >= 0) { const value = JSON.parse(buffer.slice(0, split)); buffer = buffer.slice(split + 1); values.set(value.id, value.response); }
  });
  services.push(await runStdio(createRepositoryQueries(createGitAdapter()), await temporaryDirectory(), input, output));
  const send = async (message: Record<string, unknown>) => {
    const id = randomUUID(); input.write(JSON.stringify({ id, ...message }) + '\n');
    // A real overview/navigation reads multiple Git subprocesses. The default
    // 1-second poll budget expires on Windows before a valid reply is produced.
    await expect.poll(() => values.has(id), { timeout: 15_000 }).toBe(true);
    return values.get(id);
  };
  return { send, input };
}
it('desktop stdio shares canonical open, navigation and overview without mutating the repository', async () => {
  const root = await repository(); await write(root, '你好.txt', 'first\n'); await commit(root, 'first'); await write(root, '你好.txt', 'second\n');
  const before = await fingerprint(root); const { send } = await channel();
  const request = (action: string, extra = {}) => ({ operation: 'request', request: { schemaVersion: 1, requestId: randomUUID(), action, ...extra } });
  const opened = await send(request('open', { path: root })); expect(opened.ok).toBe(true);
  const sessionId = opened.data.sessionId;
  const overview = await send(request('overview', { sessionId, generation: 1 }));
  expect(overview.data.changes.unstaged[0].path).toBe('你好.txt');
  const navigation = await send(request('navigation', { sessionId, generation: 1 }));
  expect(navigation.data.refs[0].name).toBe('refs/heads/main');
  expect((await send({operation:'session',sessionId})).data.sessionId).toBe(sessionId);
  expect((await send({operation:'watch',sessionId})).data.watching).toBe(true);
  expect((await send({operation:'request',request:{schemaVersion:1,requestId:'bad',action:'exec',command:'touch bad'}})).error.code).toBe('INVALID_REQUEST');
  expect(await fingerprint(root)).toBe(before);
});
it('filesystem events invalidate worktree observations and watcher cleanup releases handles', async () => {
  const root = await repository(); await write(root, 'a.txt', 'one\n'); await commit(root, 'one');
  const queries = createRepositoryQueries(createGitAdapter()); services.push(queries);
  const session = await queries.open(root); const watchers = new RepositoryWatchers(); services.push(watchers);
  const first = watchers.state(session.repository); expect(first.watching).toBe(true);
  await write(root, 'a.txt', 'two\n');
  await expect.poll(() => watchers.state(session.repository).revision, { timeout: 5000 }).toBeGreaterThan(first.revision);
  watchers.close();
});
it('stdin closure cancels an in-flight Git query', async () => {
  const input = new PassThrough(); const output = new PassThrough(); let aborted = false; let started = false;
  const service = await runStdio({
    open: async () => { throw new Error('unused'); }, getSession: () => { throw new Error('unused'); },
    execute: async (_request, signal) => { started = true; await new Promise<void>(resolve => signal!.addEventListener('abort', () => { aborted = true; resolve(); }, {once:true})); return {schemaVersion:1,ok:true,data:{alive:true}}; },
  }, await temporaryDirectory(), input, output); services.push(service);
  input.write(JSON.stringify({id:'pending',operation:'request',request:{schemaVersion:1,requestId:'query',action:'overview',sessionId:'session',generation:1}})+'\n');
  await expect.poll(() => started).toBe(true); input.end();
  await expect.poll(() => aborted).toBe(true);
});
