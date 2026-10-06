import { afterAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { queryKey, requestSchema } from '@git-view/contracts';
import { createRepositoryQueries } from '../../packages/core/src/index.js';
import { createGitAdapter } from '../../packages/git-cli/src/index.js';
import { runGit } from '../../packages/git-cli/src/runner.js';
import { cleanupFixtures, commit, fingerprint, fixtureGit as git, repository, temporaryDirectory, write } from '../fixtures/git.js';

afterAll(cleanupFixtures);

describe('read-only repository navigation', () => {
  it('lists local, remote-tracking and annotated tag refs; filtering preserves HEAD, index and repository bytes', async () => {
    const root = repository();
    write(root, 'file', 'base\n');
    const base = commit(root, 'base');
    git(root, ['switch', '-c', 'feature']);
    write(root, 'file', 'feature\n');
    const feature = commit(root, 'feature only');
    git(root, ['switch', 'main']);
    write(root, 'file', 'main\n');
    const main = commit(root, 'main only');
    git(root, ['update-ref', 'refs/remotes/origin/feature', feature]);
    git(root, ['tag', '-a', 'release', '-m', 'annotated release', feature]);
    write(root, 'file', 'staged\n');
    git(root, ['add', '--', 'file']);
    write(root, 'file', 'working\n');
    const before = fingerprint(root);
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(root);
    const navigation = await adapter.listNavigation(identity);
    expect(navigation.refs).toContainEqual({ name: 'refs/heads/main', oid: main, kind: 'local', current: true });
    expect(navigation.refs).toContainEqual({ name: 'refs/remotes/origin/feature', oid: feature, kind: 'remote' });
    expect(navigation.refs).toContainEqual({ name: 'refs/tags/release', oid: feature, kind: 'tag' });
    for (const ref of ['refs/heads/feature', 'refs/remotes/origin/feature', 'refs/tags/release']) {
      const history = await adapter.listHistory(identity, { scope: 'ref', ref });
      expect(history.ref).toBe(ref);
      expect(history.tipOid).toBe(feature);
      expect(history.commits.map(commit => commit.oid)).toEqual([feature, base]);
      expect(history.commits.some(commit => commit.oid === main)).toBe(false);
    }
    expect(fingerprint(root)).toBe(before);
  });

  it('parses NUL-delimited linked worktree paths and lock reasons, then resolves separate HEAD/index identities', async () => {
    const root = repository();
    write(root, 'file', 'main\n');
    const main = commit(root);
    const linked = path.join(temporaryDirectory(), process.platform === 'win32' ? '中文 空格 linked' : '中文 空格\nlinked');
    git(root, ['worktree', 'add', '-b', 'other', linked]);
    git(root, ['worktree', 'lock', '--reason', '保留\n工作区', linked]);
    write(linked, 'file', 'other staged\n');
    git(linked, ['add', '--', 'file']);
    const before = fingerprint(root);
    const linkedBefore = fingerprint(linked);
    const adapter = createGitAdapter();
    const first = await adapter.resolveRepository(root);
    const navigation = await adapter.listNavigation(first);
    expect(navigation.worktrees).toContainEqual({ path: await realpath(linked), branch: 'refs/heads/other', headOid: main, locked: '保留\n工作区' });
    const second = await adapter.resolveRepository(navigation.worktrees.find(tree => tree.branch === 'refs/heads/other')!.path);
    expect(second.repositoryId).toBe(first.repositoryId);
    expect(second.worktreeId).not.toBe(first.worktreeId);
    expect((await adapter.readOverview(first)).changes.staged).toEqual([]);
    expect((await adapter.readOverview(second)).changes.staged.map(entry => entry.path)).toEqual(['file']);
    expect(fingerprint(root)).toBe(before);
    expect(fingerprint(linked)).toBe(linkedBefore);
  });

  it('pins pagination to the original tip and rejects cursor reuse with another filter or worktree', async () => {
    const root = repository();
    write(root, 'file', 'base\n');
    const base = commit(root);
    git(root, ['branch', 'other', base]);
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
    let tip = base;
    for (let index = 0; index < 6; index++) tip = git(root, ['commit-tree', tree, '-p', tip, '-m', `page ${index}`]);
    git(root, ['update-ref', 'refs/heads/main', tip]);
    const adapter = createGitAdapter({ limits: { historyPageSize: 2 } });
    const identity = await adapter.resolveRepository(root);
    const first = await adapter.listHistory(identity, { scope: 'ref', ref: 'refs/heads/main' });
    expect(first.commits).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const nextTip = git(root, ['commit-tree', tree, '-p', tip, '-m', 'moved after page']);
    git(root, ['update-ref', 'refs/heads/main', nextTip]);
    const second = await adapter.listHistory(identity, { scope: 'ref', ref: 'refs/heads/main', cursor: first.nextCursor });
    expect(second.tipOid).toBe(tip);
    expect(second.commits).toHaveLength(2);
    expect(second.commits.some(commit => commit.oid === nextTip)).toBe(false);
    await expect(adapter.listHistory(identity, { scope: 'ref', ref: 'refs/heads/other', cursor: first.nextCursor })).rejects.toMatchObject({ code: 'STALE_RESULT' });
    await expect(adapter.listHistory(identity, { scope: 'all', cursor: first.nextCursor })).rejects.toMatchObject({ code: 'STALE_RESULT' });
    const linked = path.join(temporaryDirectory(), 'linked');
    git(root, ['worktree', 'add', linked, 'other']);
    await expect(adapter.listHistory(await adapter.resolveRepository(linked), { scope: 'ref', ref: 'refs/heads/main', cursor: first.nextCursor })).rejects.toMatchObject({ code: 'STALE_RESULT' });
    const queries = createRepositoryQueries(adapter);
    const session = await queries.open(root);
    const request = { schemaVersion: 1 as const, requestId: 'first', action: 'history' as const, scope: 'ref' as const, ref: 'refs/heads/main', sessionId: session.sessionId, generation: 0 };
    const response = await queries.execute(request);
    const cursor = response.ok && 'nextCursor' in response.data ? response.data.nextCursor : undefined;
    expect(cursor).toBeTruthy();
    const wrongFilter = await queries.execute({ ...request, requestId: 'wrong-filter', ref: 'refs/heads/other', cursor });
    expect(!wrongFilter.ok && wrongFilter.error.code).toBe('STALE_RESULT');
    queries.close();
  });

  it('makes refs part of query identity and rejects absent or extraneous history filters', () => {
    const request = { schemaVersion: 1 as const, requestId: 'r', action: 'history' as const, scope: 'ref' as const, ref: 'refs/heads/main', sessionId: 's', generation: 0 };
    expect(queryKey(request, 'w')).not.toBe(queryKey({ ...request, ref: 'refs/heads/other' }, 'w'));
    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(requestSchema.safeParse({ ...request, ref: undefined }).success).toBe(false);
    expect(requestSchema.safeParse({ ...request, scope: 'all' }).success).toBe(false);
    expect(requestSchema.safeParse({ ...request, ref: '--all' }).success).toBe(false);
  });

  it('supports unborn and detached navigation, and the runner rejects mutating worktree commands', async () => {
    const root = repository();
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(root);
    const unborn = await adapter.listNavigation(identity);
    expect(unborn.refs).toEqual([]);
    expect(unborn.worktrees[0]).toMatchObject({ path: identity.worktreeRoot, branch: 'refs/heads/main' });
    expect(unborn.worktrees[0]?.headOid).toBeUndefined();
    write(root, 'file', 'base\n');
    const oid = commit(root);
    git(root, ['checkout', '--detach', oid]);
    const detached = await adapter.listNavigation(identity);
    expect(detached.refs.every(ref => !ref.current)).toBe(true);
    expect(detached.worktrees[0]).toMatchObject({ headOid: oid, detached: true });
    expect(() => runGit(root, ['worktree', 'add', '/tmp/unapproved'])).toThrow();
  });
});
