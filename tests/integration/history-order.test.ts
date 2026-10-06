import { afterAll, describe, expect, it } from 'vitest';
import { historyFilterKey, queryKey, requestSchema, type HistoryOptions } from '@git-view/contracts';
import { createRepositoryQueries } from '../../packages/core/src/index.js';
import { createGitAdapter } from '../../packages/git-cli/src/index.js';
import { cleanupFixtures, fingerprint, fixtureGit as git, repository } from '../fixtures/git.js';

afterAll(cleanupFixtures);

// Fixed commit times make the two traversals observably different. The newest
// independent todo tip has enough older ancestors to fill a topological page.
function independentHistory() {
  const root = repository();
  const tree = git(root, ['hash-object', '-t', 'tree', '-w', '--stdin'], '');
  function node(subject: string, day: number, parents: string[] = []) {
    const timestamp = 1700000000 + day * 86400;
    const text = [`tree ${tree}`, ...parents.map(parent => `parent ${parent}`), `author Fixture <fixture@example.invalid> ${timestamp} +0000`, `committer Fixture <fixture@example.invalid> ${timestamp} +0000`, '', subject, ''].join('\n');
    return git(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], text);
  }
  const base = node('base', 1);
  const feature = node('feature', 6, [base]);
  const main = node('main change', 7, [base]);
  const merge = node('merge feature', 9, [main, feature]);
  const todo: string[] = [];
  for (const day of [2, 3, 4, 5, 8, 10]) todo.push(node(`todo ${day}`, day, todo.length ? [todo.at(-1)!] : []));
  git(root, ['update-ref', 'refs/heads/main', merge]);
  git(root, ['update-ref', 'refs/remotes/origin/todo', todo.at(-1)!]);
  return { root, node, merge, main, feature, todo, all: [base, feature, main, merge, ...todo] };
}

describe('history order', () => {
  it('defaults all refs to date order, interleaves recent main history and retains every merge parent', async () => {
    const fixture = independentHistory();
    const before = fingerprint(fixture.root);
    const adapter = createGitAdapter({ limits: { historyPageSize: 3 } });
    const identity = await adapter.resolveRepository(fixture.root);
    const byDate = await adapter.listHistory(identity, { scope: 'all' });
    expect(byDate.order).toBe('date');
    expect(byDate.commits.map(commit => commit.oid)).toEqual([fixture.todo.at(-1), fixture.merge, fixture.todo.at(-2)]);
    expect(byDate.commits.find(commit => commit.oid === fixture.merge)?.parents).toEqual([fixture.main, fixture.feature]);
    const byTopology = await adapter.listHistory(identity, { scope: 'all', order: 'topo' });
    expect(byTopology.order).toBe('topo');
    expect(byTopology.commits.map(commit => commit.oid)).toEqual(fixture.todo.slice(-3).reverse());
    expect((await adapter.listHistory(identity, { scope: 'head' })).order).toBe('topo');
    expect((await adapter.listHistory(identity, { scope: 'ref', ref: 'refs/heads/main' })).order).toBe('topo');
    expect(fingerprint(fixture.root)).toBe(before);
  });

  it.each(['date', 'topo'] as const)('pins %s pagination to its original tips with no duplicate or missing commits', async (order) => {
    const fixture = independentHistory();
    const adapter = createGitAdapter({ limits: { historyPageSize: 3 } });
    const identity = await adapter.resolveRepository(fixture.root);
    let page = await adapter.listHistory(identity, { scope: 'all', order });
    const ids = page.commits.map(commit => commit.oid);
    const movedTip = fixture.node('new todo after first page', 11, [fixture.todo.at(-1)!]);
    git(fixture.root, ['update-ref', 'refs/remotes/origin/todo', movedTip]);
    while (page.nextCursor) {
      page = await adapter.listHistory(identity, { scope: 'all', order, cursor: page.nextCursor });
      expect(page.order).toBe(order);
      ids.push(...page.commits.map(commit => commit.oid));
    }
    expect(ids).toHaveLength(fixture.all.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(fixture.all));
    expect(ids).not.toContain(movedTip);
  });

  it('rejects cross-order cursors in both the adapter and repository query session', async () => {
    const fixture = independentHistory();
    const adapter = createGitAdapter({ limits: { historyPageSize: 3 } });
    const identity = await adapter.resolveRepository(fixture.root);
    const first = await adapter.listHistory(identity, { scope: 'all' });
    expect(first.nextCursor).toBeTruthy();
    await expect(adapter.listHistory(identity, { scope: 'all', order: 'topo', cursor: first.nextCursor })).rejects.toMatchObject({ code: 'STALE_RESULT' });
    expect((await adapter.listHistory(identity, { scope: 'all', order: 'date', cursor: first.nextCursor })).order).toBe('date');
    const queries = createRepositoryQueries(adapter);
    try {
      const session = await queries.open(fixture.root);
      const request = { schemaVersion: 1 as const, requestId: 'first', action: 'history' as const, scope: 'all' as const, order: 'topo' as const, sessionId: session.sessionId, generation: 0 };
      const result = await queries.execute(request);
      expect(result.ok && 'order' in result.data && result.data.order).toBe('topo');
      const cursor = result.ok && 'nextCursor' in result.data ? result.data.nextCursor : undefined;
      expect(cursor).toBeTruthy();
      const changed = await queries.execute({ ...request, requestId: 'changed', order: 'date', cursor });
      expect(!changed.ok && changed.error.code).toBe('STALE_RESULT');
      const continued = await queries.execute({ ...request, requestId: 'continued', cursor });
      expect(continued.ok).toBe(true);
    } finally { queries.close(); }
  });

  it('includes effective order in request/filter identities and validates order at the boundary', async () => {
    const request = { schemaVersion: 1 as const, requestId: 'r', action: 'history' as const, scope: 'all' as const, sessionId: 's', generation: 0 };
    expect(queryKey(request, 'w')).toBe(queryKey({ ...request, order: 'date' }, 'w'));
    expect(queryKey(request, 'w')).not.toBe(queryKey({ ...request, order: 'topo' }, 'w'));
    expect(historyFilterKey(request)).toBe(historyFilterKey({ ...request, order: 'date' }));
    expect(historyFilterKey(request)).not.toBe(historyFilterKey({ ...request, order: 'topo' }));
    expect(requestSchema.safeParse({ ...request, order: 'date' }).success).toBe(true);
    expect(requestSchema.safeParse({ ...request, order: 'topo' }).success).toBe(true);
    expect(requestSchema.safeParse({ ...request, order: '--no-merges' }).success).toBe(false);
    const fixture = independentHistory();
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(fixture.root);
    await expect(adapter.listHistory(identity, { scope: 'all', order: '--no-merges' } as unknown as HistoryOptions)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
