import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type RepositorySession, type RepositoryOperationInput } from '@git-view/contracts';
import { createGitAdapter } from '../../packages/git-cli/src/index';
import { createOperations } from '../../packages/operations/src/index';
import { createRepositoryWriter } from '../../packages/git-write/src/repository';
import { cleanupFixtures, commit, fixtureGit as git, repository, temporaryDirectory, write, fingerprint, GIT_OPERATION_TEST_TIMEOUT } from '../fixtures/git';

afterAll(cleanupFixtures);
async function setup(unborn = false, timeoutMs?: number) {
  const root = repository();
  git(root, ['config', 'user.name', 'Operation Test']); git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']); git(root, ['config', 'core.hooksPath', '.git/hooks']);
  write(root, 'file.txt', 'V1\n');
  if (!unborn) commit(root);
  write(root, 'file.txt', 'V2\n'); git(root, ['add', '--', 'file.txt']); write(root, 'file.txt', 'V3\n');
  const read = createGitAdapter(); const session: RepositorySession = { sessionId: randomUUID(), generation: 0, repository: await read.resolveRepository(root) };
  const directory = temporaryDirectory();
  const writer = createRepositoryWriter({ timeoutMs });
  const operations = await createOperations({ directory, read, repositoryWriter: writer });
  async function preview(input: Omit<Extract<RepositoryOperationInput, { kind: 'commit' }>, 'fingerprint'> | Omit<Exclude<RepositoryOperationInput, { kind: 'commit' }>, 'fingerprint'>) {
    const overview = await read.readOverview(session.repository);
    return operations.preview(session, { ...input, fingerprint: overview.fingerprint });
  }
  return { root, read, session, directory, writer, operations, preview };
}
function hook(root: string, name: string, body: string) { const file = path.join(root, '.git/hooks', name); writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); chmodSync(file, 0o755); }
async function execute(f: Awaited<ReturnType<typeof setup>>, input: Parameters<typeof f.preview>[0]) {
  const preview = await f.preview(input); return f.operations.execute(f.session, preview.previewId, randomUUID(), true);
}

describe.skipIf(process.platform === 'win32')('ordinary commits and local branches', { timeout: GIT_OPERATION_TEST_TIMEOUT }, () => {
  it.each([false, true])('commits exactly index V2, retains V3, with correct parents (unborn=%s)', async unborn => {
    const f = await setup(unborn); const previous = unborn ? null : git(f.root, ['rev-parse', 'HEAD']);
    const before = fingerprint(f.root); const shown = await f.preview({ kind: 'commit', message: 'ordinary commit\n\nDetails' });
    expect(fingerprint(f.root)).toBe(before); expect(shown.files.map(entry => entry.path)).toEqual(['file.txt']);
    expect(shown.requiresHookConsent).toBe(true);
    await expect(f.operations.execute(f.session, shown.previewId, randomUUID())).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const id = randomUUID(); const receipt = await f.operations.execute(f.session, shown.previewId, id, true);
    expect(receipt, JSON.stringify(receipt)).toMatchObject({ status: 'succeeded', result: { previewMatched: true, parents: previous ? [previous] : [], remaining: { staged: 0, unstaged: 1 } } });
    expect(git(f.root, ['show', 'HEAD:file.txt'])).toBe('V2'); expect(readFileSync(path.join(f.root, 'file.txt'), 'utf8')).toBe('V3\n');
    const oid = git(f.root, ['rev-parse', 'HEAD']); expect(receipt.result?.createdOid).toBe(oid);
    expect(await f.operations.execute(f.session, shown.previewId, id, true)).toEqual(receipt);
    expect(git(f.root, ['rev-parse', 'HEAD'])).toBe(oid);
  });
  it('reports actual tree when pre-commit changes staged content', async () => {
    const f = await setup(); hook(f.root, 'pre-commit', "printf 'hook version\\n' > file.txt\ngit add -- file.txt");
    const result = await execute(f, { kind: 'commit', message: 'hook commit' });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'succeeded', result: { previewMatched: false, changedPaths: ['file.txt'] } });
    expect(git(f.root, ['show', 'HEAD:file.txt'])).toBe('hook version'); expect(result.message).toContain('实际内容与预览不同');
  });
  it('reports pre-commit and signing failures, retaining index and not retrying', async () => {
    const f = await setup(); const head = git(f.root, ['rev-parse', 'HEAD']);
    hook(f.root, 'pre-commit', 'echo refused >&2\nexit 1');
    const first = await execute(f, { kind: 'commit', message: 'rejected hook' });
    expect(first.status).toBe('failed'); expect(first.result?.diagnostic).toContain('refused');
    hook(f.root, 'pre-commit', 'exit 0'); git(f.root, ['config', 'commit.gpgsign', 'true']); git(f.root, ['config', 'gpg.program', '/does-not-exist/git-view-test-gpg']);
    const second = await execute(f, { kind: 'commit', message: 'rejected signing' });
    expect(second.status).toBe('failed'); expect(second.result?.diagnostic).toBeTruthy();
    expect(git(f.root, ['rev-parse', 'HEAD'])).toBe(head); expect(git(f.root, ['show', ':file.txt'])).toBe('V2');
  });
  it('refuses an identity configuration that cannot create a commit without modifying it', async () => {
    const f = await setup(); git(f.root, ['config', 'user.name', '']); git(f.root, ['config', 'user.email', '']);
    const config = readFileSync(path.join(f.root, '.git/config'));
    const result = await execute(f, { kind: 'commit', message: 'missing identity' });
    expect(result.status).toBe('failed'); expect(readFileSync(path.join(f.root, '.git/config'))).toEqual(config);
  });
  it('refuses stale index and HEAD, empty messages, empty staged contents and operation state', async () => {
    const f = await setup(); const shown = await f.preview({ kind: 'commit', message: 'stale' });
    git(f.root, ['add', '--', 'file.txt']);
    expect((await f.operations.execute(f.session, shown.previewId, randomUUID(), true)).status).toBe('failed');
    await expect(f.preview({ kind: 'commit', message: '   ' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    git(f.root, ['reset', '--', 'file.txt']);
    await expect(f.preview({ kind: 'commit', message: 'empty' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    write(f.root, '.git/MERGE_HEAD', git(f.root, ['rev-parse', 'HEAD']) + '\n');
    await expect(f.preview({ kind: 'commit', message: 'merge' })).rejects.toMatchObject({ code: 'UNSUPPORTED_REPOSITORY' });
  });
  it('creates from fixed HEAD without switching, does not overwrite, and rejects invalid names', async () => {
    const f = await setup(); const head = git(f.root, ['rev-parse', 'HEAD']); const index = readFileSync(path.join(f.root, '.git/index'));
    const created = await execute(f, { kind: 'create-branch', branch: 'topic/example' });
    expect(created, JSON.stringify(created)).toMatchObject({ status: 'succeeded', result: { targetBranch: 'topic/example', createdOid: head, branch: 'main' } });
    expect(git(f.root, ['symbolic-ref', '--short', 'HEAD'])).toBe('main'); expect(readFileSync(path.join(f.root, '.git/index'))).toEqual(index);
    await expect(f.preview({ kind: 'create-branch', branch: 'topic/example' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    for (const branch of ['-oops', 'bad..name', '@{-1}', 'HEAD']) await expect(f.preview({ kind: 'create-branch', branch })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('requires a clean worktree, then switches existing local branch and reports hook failure after the switch', async () => {
    const f = await setup(); git(f.root, ['branch', 'topic']);
    await expect(f.preview({ kind: 'switch-branch', branch: 'topic' })).rejects.toMatchObject({ code: 'REPOSITORY_BUSY' });
    git(f.root, ['reset', '--hard', 'HEAD']);
    hook(f.root, 'post-checkout', 'echo hook-after-switch-failed >&2\nexit 7');
    const result = await execute(f, { kind: 'switch-branch', branch: 'topic' });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'succeeded', result: { branch: 'topic' } });
    expect(result.message).toContain('后续 hook'); expect(result.result?.diagnostic).toContain('hook-after-switch-failed');
    expect(git(f.root, ['symbolic-ref', '--short', 'HEAD'])).toBe('topic');
  });
  it('refuses target movement, occupied worktrees and target-only smudge filters without executing them', async () => {
    const f = await setup(); git(f.root, ['reset', '--hard', 'HEAD']); git(f.root, ['branch', 'topic']);
    const shown = await f.preview({ kind: 'switch-branch', branch: 'topic' });
    const other = git(f.root, ['commit-tree', 'HEAD^{tree}', '-m', 'other tip']); git(f.root, ['update-ref', 'refs/heads/topic', other]);
    expect((await f.operations.execute(f.session, shown.previewId, randomUUID(), true)).status).toBe('failed');
    const linked = path.join(temporaryDirectory(), 'linked'); git(f.root, ['worktree', 'add', linked, 'topic']);
    await expect(f.preview({ kind: 'switch-branch', branch: 'topic' })).rejects.toMatchObject({ code: 'REPOSITORY_BUSY' });
    git(f.root, ['worktree', 'remove', linked]);
    git(f.root, ['switch', 'topic']); write(f.root, '.gitattributes', '*.txt filter=probe\n'); commit(f.root, 'target attributes'); git(f.root, ['switch', 'main']);
    git(f.root, ['config', 'filter.probe.smudge', 'touch FILTER-RAN; cat']);
    await expect(f.preview({ kind: 'switch-branch', branch: 'topic' })).rejects.toMatchObject({ code: 'UNSUPPORTED_FILTER' });
    expect(existsSync(path.join(f.root, 'FILTER-RAN'))).toBe(false); expect(git(f.root, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
  });
  it('preserves ignored files that would otherwise be overwritten by switching', async () => {
    const f = await setup(); git(f.root, ['reset', '--hard', 'HEAD']);
    git(f.root, ['switch', '-c', 'topic']); write(f.root, 'ignored.txt', 'target\n'); commit(f.root);
    git(f.root, ['switch', 'main']); write(f.root, '.git/info/exclude', 'ignored.txt\n'); write(f.root, 'ignored.txt', 'local ignored\n');
    const result = await execute(f, { kind: 'switch-branch', branch: 'topic' });
    expect(result.status).toBe('failed'); expect(readFileSync(path.join(f.root, 'ignored.txt'), 'utf8')).toBe('local ignored\n');
  });
  it('recovers a committed OID from durable intent and reflog after the final result is lost', async () => {
    const f = await setup(); git(f.root, ['config', 'core.logAllRefUpdates', 'false']);
    const real = f.writer; let executions = 0;
    const writer = { ...real, execute: async (...args: Parameters<typeof real.execute>) => {
      executions++;
      return real.execute(args[0], args[1], async evidence => {
        if (evidence.outcome) throw new Error('lost result before final persistence');
        await args[2](evidence);
      });
    } };
    const operations = await createOperations({ directory: f.directory, read: f.read, repositoryWriter: writer });
    const overview = await f.read.readOverview(f.session.repository);
    const preview = await operations.preview(f.session, { kind: 'commit', message: 'recover exactly once', fingerprint: overview.fingerprint });
    const id = randomUUID(); const first = await operations.execute(f.session, preview.previewId, id, true);
    expect(first.status).toBe('succeeded'); expect(first.result?.createdOid).toBe(git(f.root, ['rev-parse', 'HEAD']));
    const file = path.join(f.directory, 'operations', createHash('sha256').update(id).digest('hex') + '.json');
    const record = JSON.parse(readFileSync(file, 'utf8')); record.receipt.status = 'running'; delete record.receipt.finishedAt; writeFileSync(file, JSON.stringify(record));
    const reopened = await createOperations({ directory: f.directory, read: f.read, repositoryWriter: writer });
    expect((await reopened.receipt({ ...f.session, sessionId: randomUUID() }, id)).result?.createdOid).toBe(first.result?.createdOid);
    expect((await reopened.execute(f.session, preview.previewId, id, true)).status).toBe('succeeded'); expect(executions).toBe(1);
  });
  it('times out a hook, keeps the commit unknown rather than retrying, and terminates its process group', async () => {
    const f = await setup(false, 100);
    const original = f.writer.execute; let executions = 0;
    f.writer.execute = async (...args) => { executions++; return original(...args); };
    hook(f.root, 'pre-commit', 'sleep 1; touch LATE-HOOK-WRITE');
    const shown = await f.preview({ kind: 'commit', message: 'timeout' }); const id = randomUUID();
    const result = await f.operations.execute(f.session, shown.previewId, id, true);
    expect(result.status).toBe('unknown'); expect(result.result?.diagnostic).toContain('超时');
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(existsSync(path.join(f.root, 'LATE-HOOK-WRITE'))).toBe(false);
    expect(await f.operations.execute(f.session, shown.previewId, id, true)).toMatchObject({ status: 'unknown', operationId: id });
    expect(executions).toBe(1);
  });
  it('a common-directory app lock blocks branch writes from a second linked worktree', async () => {
    const f = await setup(); git(f.root, ['config', 'core.hooksPath', path.join(f.root, '.git/hooks')]);
    const linked = path.join(temporaryDirectory(), 'linked'); git(f.root, ['worktree', 'add', '-b', 'linked', linked, 'HEAD']);
    const secondSession: RepositorySession = { sessionId: randomUUID(), generation: 0, repository: await f.read.resolveRepository(linked) };
    const second = await createOperations({ directory: f.directory, read: f.read });
    const snapshot = await f.read.readOverview(secondSession.repository);
    const preview = await second.preview(secondSession, { kind: 'create-branch', branch: 'new-branch', fingerprint: snapshot.fingerprint });
    const lock = path.join(f.directory, 'operations', 'common-' + createHash('sha256').update(f.session.repository.commonGitDir).digest('hex') + '.lock');
    writeFileSync(lock, JSON.stringify({ schemaVersion: 1, token: randomUUID(), ownerId: randomUUID(), pid: process.pid }), { mode: 0o600 });
    await expect(second.execute(secondSession, preview.previewId, randomUUID(), true)).rejects.toMatchObject({ code: 'REPOSITORY_BUSY' });
    expect(git(f.root, ['branch', '--list', 'new-branch'])).toBe('');
  });

});
