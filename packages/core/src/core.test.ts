import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { QueryError, type GitAdapter, type Navigation, type RawOverview, type RepositoryIdentity, type RevisionComparison } from '@git-view/contracts';
import { createRepositoryQueries, explain } from './index';

const repository: RepositoryIdentity = { repositoryId: 'repo', worktreeId: 'tree', worktreeRoot: '/tmp/example', gitDir: '/tmp/example/.git', commonGitDir: '/tmp/example/.git' };
const raw: RawOverview = { repository, head: { kind: 'branch', branch: 'main', oid: 'opaque-id' }, changes: { staged: [{ id: 'stage', rawPath: 'YQ==', path: 'a', kind: 'M', comparison: 'head-index', supported: true }], unstaged: [{ id: 'work', rawPath: 'YQ==', path: 'a', kind: 'M', comparison: 'index-worktree', supported: true }], untracked: [], conflicts: [] }, operation: [], complete: true, warnings: [], fingerprint: 'first' };
function fake(read: GitAdapter['readOverview']): GitAdapter {
  const unavailable = async (): Promise<never> => { throw new Error('unused adapter method'); };
  return { resolveRepository: async () => repository, readOverview: read, listNavigation: unavailable, readChange: unavailable, listHistory: unavailable, readCommit: unavailable, readCommitChange: unavailable, compareRevisions: unavailable, listComparisonCommits: unavailable, readComparisonChange: unavailable };
}
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe('deterministic evidence rules', () => {
  it('explains two comparisons and predicts only the staged candidate', () => {
    const answers = explain(raw, 'observation');
    expect(answers).toEqual(explain(raw, 'observation'));
    expect(answers[1].answer).toContain('同时出现在两组');
    expect(answers[2].evidence.map(item => item.entryId)).toEqual(['stage']);
    expect(answers[2].answer).toContain('完整树快照');
    expect(answers.every(answer => answer.observationId === 'observation')).toBe(true);
  });
  it.each([
    { ...raw, complete: false },
    { ...raw, operation: ['merge'] },
    { ...raw, changes: { ...raw.changes, conflicts: raw.changes.unstaged } },
  ])('blocks prediction for incomplete or transitional observations', overview => {
    expect(explain(overview, 'id')[2].answer).toContain('不能可靠预测');
    expect(explain(overview, 'id')[2].evidence[0].target).toBe('status');
  });
});

describe('repository observation coordinator', () => {
  it.each(['success', 'failure'])('late comparison %s cannot be cached after a newer refresh', async outcome => {
    const old = deferred<RevisionComparison>(); const adapter = fake(async () => raw); let calls = 0;
    const comparison = (): RevisionComparison => ({ comparisonId: randomUUID(), worktreeId: repository.worktreeId, observedAt: new Date().toISOString(), historyKey: 'history', a: { selector: { kind: 'head' }, label: 'HEAD', oid: 'a'.repeat(40) }, b: { selector: { kind: 'head' }, label: 'HEAD', oid: 'b'.repeat(40) }, mergeBases: { status: 'none', oids: [] }, exclusive: { a: 1, b: 1, complete: true }, endpoints: { base: 'a'.repeat(40), target: 'b'.repeat(40), changes: [] }, warnings: [] });
    const prior = comparison(); const latest = comparison();
    adapter.compareRevisions = async () => ++calls === 1 ? old.promise : latest;
    adapter.listComparisonCommits = async (_repo, value, options) => ({ comparisonId: value.comparisonId, side: options.side, commits: [], complete: true });
    const queries = createRepositoryQueries(adapter); const session = await queries.open('/fixture');
    const request = { schemaVersion: 1 as const, action: 'compare' as const, a: { kind: 'head' as const }, b: { kind: 'head' as const }, sessionId: session.sessionId, generation: 0, requestId: 'old' };
    const pending = queries.execute(request); expect((await queries.execute({ ...request, generation: 1, requestId: 'new' })).ok).toBe(true);
    if (outcome === 'success') old.resolve(prior); else old.reject(new QueryError('TIMEOUT', 'obsolete failure'));
    expect((await pending).ok).toBe(false);
    const page = { schemaVersion: 1 as const, action: 'comparison-commits' as const, sessionId: session.sessionId, generation: 1, requestId: 'page', side: 'a' as const };
    const obsolete = await queries.execute({ ...page, comparisonId: prior.comparisonId }); expect(!obsolete.ok && obsolete.error.code).toBe('STALE_RESULT');
    expect((await queries.execute({ ...page, comparisonId: latest.comparisonId })).ok).toBe(true); queries.close();
  });
  it('writes invalidate all sessions of a worktree, reject late reads, and resume only after every writer releases', async () => {
    const old = deferred<RawOverview>(); let reads = 0;
    const queries = createRepositoryQueries(fake(async () => ++reads === 1 ? old.promise : { ...raw, fingerprint: 'after-write' }));
    const a = await queries.open('/a'); const b = await queries.open('/b');
    const request = { schemaVersion: 1 as const, action: 'overview' as const, sessionId: a.sessionId, generation: 1, requestId: 'before' };
    const pending = queries.execute(request);
    const resumeA = queries.suspendWorktree(a.repository.worktreeId);
    const resumeB = queries.suspendWorktree(b.repository.worktreeId);
    old.resolve(raw);
    expect((await pending).ok).toBe(false);
    resumeA(); resumeA();
    const blocked = await queries.execute({ ...request, sessionId: b.sessionId, requestId: 'during' });
    expect(!blocked.ok && blocked.error.code).toBe('REPOSITORY_BUSY');
    resumeB();
    const result = await queries.execute({ ...request, requestId: 'after', generation: 2 });
    expect(result.ok && 'fingerprint' in result.data && result.data.fingerprint).toBe('after-write');
    queries.close();
  });
  it('shared-reference writes block linked worktrees, including sessions opened during the write', async () => {
    const adapter = fake(async repository => ({ ...raw, repository }));
    adapter.resolveRepository = async root => ({ ...repository, worktreeId: root, worktreeRoot: root, gitDir: `${root}/.git` });
    const queries = createRepositoryQueries(adapter);
    const a = await queries.open('/a');
    const resume = queries.suspendRepository(a.repository.commonGitDir);
    const b = await queries.open('/b');
    const request = { schemaVersion: 1 as const, action: 'overview' as const, sessionId: b.sessionId, generation: 0, requestId: 'linked' };
    const blocked = await queries.execute(request);
    expect(!blocked.ok && blocked.error.code).toBe('REPOSITORY_BUSY');
    resume(); expect((await queries.execute(request)).ok).toBe(true); queries.close();
  });
  it.each(['success', 'failure'])('old navigation %s cannot replace a newer generation', async result => {
    const old = deferred<Navigation>();
    const adapter = fake(async () => raw);
    let calls = 0;
    adapter.listNavigation = async () => ++calls === 1 ? old.promise : { refs: [{ name: 'refs/heads/new', oid: 'new', kind: 'local' }], worktrees: [] };
    const queries = createRepositoryQueries(adapter);
    const session = await queries.open('/tmp/example');
    const request = { schemaVersion: 1 as const, action: 'navigation' as const, sessionId: session.sessionId, generation: 1, requestId: 'old-navigation' };
    const pending = queries.execute(request);
    const current = await queries.execute({ ...request, generation: 2, requestId: 'new-navigation' });
    expect(current.ok && 'refs' in current.data && current.data.refs[0]?.name).toBe('refs/heads/new');
    if (result === 'success') old.resolve({ refs: [], worktrees: [] });
    else old.reject(new QueryError('TIMEOUT', 'old navigation timeout'));
    const obsolete = await pending;
    expect(obsolete.ok).toBe(false);
    expect(obsolete.stamp?.generation).toBe(1);
    expect(queries.getSession(session.sessionId).generation).toBe(2);
    queries.close();
  });
  it.each(['success', 'failure'])('old %s cannot replace the new observation', async result => {
    const old = deferred<RawOverview>();
    let calls = 0;
    const queries = createRepositoryQueries(fake(async () => ++calls === 1 ? old.promise : { ...raw, fingerprint: 'new' }));
    const session = await queries.open('/tmp/example');
    const request = { schemaVersion: 1 as const, action: 'overview' as const, sessionId: session.sessionId, generation: 1, requestId: 'old' };
    const pending = queries.execute(request);
    const current = await queries.execute({ ...request, generation: 2, requestId: 'new' });
    expect(current.ok && 'fingerprint' in current.data && current.data.fingerprint).toBe('new');
    if (result === 'success') old.resolve(raw); else old.reject(new QueryError('TIMEOUT', 'old timeout'));
    const oldResult = await pending;
    expect(oldResult.ok).toBe(false);
    expect(oldResult.stamp?.generation).toBe(1);
    expect(queries.getSession(session.sessionId).generation).toBe(2);
    const obsolete = await queries.execute(request);
    expect(!obsolete.ok && obsolete.error.code).toBe('STALE_RESULT');
    queries.close();
  });
  it('keeps independent sessions and caps total reads for the same worktree', async () => {
    let active = 0; let maximum = 0;
    const blockers: ReturnType<typeof deferred<RawOverview>>[] = [];
    const queries = createRepositoryQueries(fake(async () => {
      active++; maximum = Math.max(active, maximum);
      const blocker = deferred<RawOverview>(); blockers.push(blocker);
      try { return await blocker.promise; } finally { active--; }
    }));
    const sessions = await Promise.all([queries.open('/a'), queries.open('/b'), queries.open('/c')]);
    expect(new Set(sessions.map(session => session.sessionId)).size).toBe(3);
    const requests = sessions.map((session, index) => queries.execute({ schemaVersion: 1, action: 'overview', generation: 0, requestId: String(index), sessionId: session.sessionId }));
    expect(blockers).toHaveLength(2);
    blockers[0].resolve(raw);
    await requests[0];
    expect(blockers).toHaveLength(3);
    blockers[1].resolve(raw); blockers[2].resolve(raw);
    await Promise.all(requests);
    expect(maximum).toBe(2);
    queries.close();
  });
  it('resolution errors carry no invented repository observation', async () => {
    const adapter = fake(async () => raw);
    adapter.resolveRepository = async () => { throw new QueryError('INVALID_REPOSITORY', 'not a repo'); };
    const result = await createRepositoryQueries(adapter).execute({ schemaVersion: 1, action: 'open', requestId: 'open', path: '/tmp/absent' });
    expect(!result.ok && result.error.code).toBe('INVALID_REPOSITORY');
    expect(result.stamp).toBeUndefined();
  });
  it('invalidates history cursors when a new generation starts', async () => {
    const adapter = fake(async () => raw);
    adapter.listHistory = async () => ({ commits: [], scope: 'all', shallow: false, nextCursor: 'fixed-tips-page-2' });
    const queries = createRepositoryQueries(adapter);
    const session = await queries.open('/tmp/example');
    const request = { schemaVersion: 1 as const, action: 'history' as const, scope: 'all' as const, sessionId: session.sessionId, generation: 0, requestId: 'history' };
    expect((await queries.execute(request)).ok).toBe(true);
    expect((await queries.execute({ ...request, requestId: 'page-2', cursor: 'fixed-tips-page-2' })).ok).toBe(true);
    const oldCursor = await queries.execute({ ...request, requestId: 'old-page', generation: 1, cursor: 'fixed-tips-page-2' });
    expect(!oldCursor.ok && oldCursor.error.code).toBe('STALE_RESULT');
    queries.close();
  });
});
