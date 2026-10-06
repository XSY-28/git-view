import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createGitAdapter } from '../../packages/git-cli/src/index';
import { createRepositoryQueries } from '../../packages/core/src/index';
import { requestSchema, revisionComparisonSchema, comparisonCommitsSchema } from '@git-view/contracts';
import { cleanupFixtures, commit, fingerprint, fixtureGit, repository, temporaryDirectory, write } from '../fixtures/git';

afterEach(cleanupFixtures);
const head = { kind: 'head' } as const;
const ref = (name: string) => ({ kind: 'ref' as const, name: `refs/heads/${name}` });
const oid = (value: string) => ({ kind: 'commit' as const, oid: value });
function fork() {
  const root = repository(); write(root, 'shared.txt', 'base\n'); const base = commit(root, 'base');
  fixtureGit(root, ['branch', 'topic']); write(root, 'main.txt', 'main only\n'); const a = commit(root, 'main only');
  fixtureGit(root, ['switch', 'topic']); write(root, 'topic.txt', 'topic only\n'); const b = commit(root, 'topic only');
  return { root, base, a, b };
}

describe('fixed revision comparisons in real Git repositories', () => {
  it('separates both trees from merge-base→B, counts both histories, and never reads dirty index/worktree content', async () => {
    const { root, base, a, b } = fork();
    write(root, 'topic.txt', 'staged poison\n'); fixtureGit(root, ['add', 'topic.txt']); write(root, 'topic.txt', 'worktree poison\n');
    const before = fingerprint(root); const adapter = createGitAdapter(); const repo = await adapter.resolveRepository(root);
    const result = revisionComparisonSchema.parse(await adapter.compareRevisions(repo, { a: ref('main'), b: head }));
    expect(result.a.oid).toBe(a); expect(result.b.oid).toBe(b);
    expect(result.mergeBases).toEqual({ status: 'unique', oids: [base] });
    expect(result.exclusive).toEqual({ a: 1, b: 1, complete: true });
    expect(result.endpoints.changes.map(e => [e.path, e.kind])).toEqual([['main.txt', 'D'], ['topic.txt', 'A']]);
    expect(result.fromMergeBase?.changes.map(e => e.path)).toEqual(['topic.txt']);
    for (const side of ['a', 'b'] as const) {
      const page = comparisonCommitsSchema.parse(await adapter.listComparisonCommits(repo, result, { side }));
      expect(page.commits.map(e => e.oid)).toEqual([side === 'a' ? a : b]);
    }
    const diff = await adapter.readComparisonChange(repo, result, 'endpoints', result.endpoints.changes[1]!);
    expect(diff.text).toContain('+topic only'); expect(diff.text).not.toContain('poison'); expect(diff.base).toBe(a); expect(diff.target).toBe(b);
    const swapped = await adapter.compareRevisions(repo, { a: head, b: ref('main') });
    expect(swapped.endpoints.changes.map(e => [e.path, e.kind])).toEqual([['main.txt', 'A'], ['topic.txt', 'D']]);
    expect(fingerprint(root)).toBe(before);
  });
  it('supports root commits, identical endpoints, peeled tags and rename paths without revision expressions', async () => {
    const oldName = process.platform === 'win32' ? '-文件 old.txt' : '-文件\nold.txt';
    const newName = process.platform === 'win32' ? '-文件 new.txt' : '-文件\nnew.txt';
    const root = repository(); write(root, oldName, 'one\ntwo\nthree\n'); const base = commit(root, 'root');
    fixtureGit(root, ['tag', '-a', 'v1', '-m', 'annotated']); fixtureGit(root, ['mv', '--', oldName, newName]); const next = commit(root, 'rename');
    const before = fingerprint(root); const adapter = createGitAdapter(); const repo = await adapter.resolveRepository(root);
    const result = await adapter.compareRevisions(repo, { a: { kind: 'ref', name: 'refs/tags/v1' }, b: oid(next.slice(0, 12)) });
    expect(result.a.oid).toBe(base); expect(result.endpoints.changes).toHaveLength(1); expect(result.endpoints.changes[0]?.kind).toBe('R');
    const diff = await adapter.readComparisonChange(repo, result, 'endpoints', result.endpoints.changes[0]!); expect(diff.entry.oldPath).toBe(oldName.replace('\n', '\\x0a'));
    expect(diff.text).toContain('rename from'); expect(diff.text).not.toContain('-one'); expect(diff.text).not.toContain('+one');
    const same = await adapter.compareRevisions(repo, { a: oid(base), b: oid(base) });
    expect(same.endpoints.changes).toEqual([]); expect(same.exclusive).toEqual({ a: 0, b: 0, complete: true });
    await expect(adapter.compareRevisions(repo, { a: oid('HEAD~1'), b: head })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(adapter.compareRevisions(repo, { a: ref('main~1'), b: head })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(adapter.compareRevisions(repo, { a: oid('a'.repeat(40)), b: head })).rejects.toMatchObject({ code: 'OBJECT_UNAVAILABLE' });
    expect(fingerprint(root)).toBe(before);
    const unborn = await adapter.resolveRepository(repository());
    await expect(adapter.compareRevisions(unborn, { a: head, b: head })).rejects.toMatchObject({ code: 'OBJECT_UNAVAILABLE' });
  });
  it('resolves commit prefixes as objects even if a branch has exactly that name', async () => {
    const { root, a, b } = fork(); const prefix = b.slice(0, 12); fixtureGit(root, ['branch', prefix, a]);
    const adapter = createGitAdapter(); const repo = await adapter.resolveRepository(root);
    const result = await adapter.compareRevisions(repo, { a: ref(prefix), b: oid(prefix.toUpperCase()) });
    expect(result.a.oid).toBe(a); expect(result.b.oid).toBe(b);
    const blob = fixtureGit(root, ['rev-parse', 'HEAD:topic.txt']);
    await expect(adapter.compareRevisions(repo, { a: oid(blob), b: head })).rejects.toMatchObject({ code: 'OBJECT_UNAVAILABLE' });
  });
  it('recognizes a merged branch and keeps the tree delta direction explicit', async () => {
    const { root, b } = fork(); fixtureGit(root, ['switch', 'main']); fixtureGit(root, ['merge', '--no-ff', 'topic', '-m', 'merge topic']);
    const adapter = createGitAdapter(); const repo = await adapter.resolveRepository(root);
    const result = await adapter.compareRevisions(repo, { a: head, b: ref('topic') });
    expect(result.mergeBases.oids).toEqual([b]); expect(result.exclusive).toEqual({ a: 2, b: 0, complete: true });
    expect(result.fromMergeBase?.changes).toEqual([]); expect(result.endpoints.changes.map(e => [e.path, e.kind])).toEqual([['main.txt', 'D']]);
  });
  it('reports unrelated and crisscross histories without picking a fictional common ancestor', async () => {
    const { root, base, a, b } = fork(); const tree = fixtureGit(root, ['rev-parse', `${base}^{tree}`]);
    const independent = fixtureGit(root, ['commit-tree', tree, '-m', 'unrelated root']);
    const x = fixtureGit(root, ['commit-tree', tree, '-p', a, '-p', b, '-m', 'merge x']);
    const y = fixtureGit(root, ['commit-tree', tree, '-p', b, '-p', a, '-m', 'merge y']);
    const adapter = createGitAdapter(); const repo = await adapter.resolveRepository(root); const before = fingerprint(root);
    const unrelated = await adapter.compareRevisions(repo, { a: oid(a), b: oid(independent) });
    expect(unrelated.mergeBases.status).toBe('none'); expect(unrelated.fromMergeBase).toBeUndefined(); expect(unrelated.endpoints.changes).toHaveLength(1);
    const multi = await adapter.compareRevisions(repo, { a: oid(x), b: oid(y) });
    expect(multi.mergeBases.status).toBe('multiple'); expect(multi.mergeBases.oids.sort()).toEqual([a, b].sort()); expect(multi.fromMergeBase).toBeUndefined();
    expect(fingerprint(root)).toBe(before);
  });
  it('pins pagination across branch moves and binds cursors to comparison, side and worktree', async () => {
    const { root, a } = fork(); const commits: string[] = [];
    for (let n = 0; n < 5; n++) { write(root, 'topic.txt', `topic ${n}\n`); commits.unshift(commit(root, `topic ${n}`)); }
    const adapter = createGitAdapter({ limits: { historyPageSize: 2 } }); const repo = await adapter.resolveRepository(root);
    const result = await adapter.compareRevisions(repo, { a: oid(a), b: head });
    const first = await adapter.listComparisonCommits(repo, result, { side: 'b' }); expect(first.commits.map(c => c.oid)).toEqual(commits.slice(0, 2));
    fixtureGit(root, ['reset', '--hard', a]); const before = fingerprint(root);
    const second = await adapter.listComparisonCommits(repo, result, { side: 'b', cursor: first.nextCursor }); expect(second.commits.map(c => c.oid)).toEqual(commits.slice(2, 4));
    const changed = await adapter.compareRevisions(repo, { a: oid(a), b: head });
    await expect(adapter.listComparisonCommits(repo, changed, { side: 'b', cursor: first.nextCursor })).rejects.toMatchObject({ code: 'STALE_RESULT' });
    await expect(adapter.listComparisonCommits(repo, result, { side: 'a', cursor: first.nextCursor })).rejects.toMatchObject({ code: 'STALE_RESULT' });
    expect(fingerprint(root)).toBe(before);
    const linked = join(temporaryDirectory(), 'linked'); fixtureGit(root, ['worktree', 'add', '--detach', linked, result.b.oid]);
    await expect(adapter.listComparisonCommits(await adapter.resolveRepository(linked), result, { side: 'b', cursor: first.nextCursor })).rejects.toMatchObject({ code: 'STALE_RESULT' });
    const after = fingerprint(root); await adapter.readComparisonChange(repo, result, 'endpoints', result.endpoints.changes[0]!); expect(fingerprint(root)).toBe(after);
  });
  it('qualifies shallow counts, preserves endpoint trees and rejects pages after a deepen', async () => {
    const source = repository(); write(source, 'file.txt', 'one\n'); commit(source); write(source, 'file.txt', 'two\n'); commit(source);
    write(source, 'file.txt', 'three\n'); const tip = commit(source);
    const root = join(temporaryDirectory(), 'shallow'); fixtureGit(source, ['clone', '--depth=2', pathToFileURL(source).href, root]);
    const parent = fixtureGit(root, ['rev-parse', 'HEAD~1']); const adapter = createGitAdapter(); const repo = await adapter.resolveRepository(root); const before = fingerprint(root);
    const result = await adapter.compareRevisions(repo, { a: oid(parent), b: oid(tip) });
    expect(result.mergeBases.status).toBe('incomplete'); expect(result.fromMergeBase).toBeUndefined(); expect(result.exclusive.complete).toBe(false);
    expect(result.endpoints.changes.map(e => e.path)).toEqual(['file.txt']);
    const page = await adapter.listComparisonCommits(repo, result, { side: 'a' }); expect(page.complete).toBe(false);
    expect(fingerprint(root)).toBe(before); fixtureGit(root, ['fetch', '--unshallow']);
    await expect(adapter.listComparisonCommits(repo, result, { side: 'b' })).rejects.toMatchObject({ code: 'STALE_RESULT' });
  });
  it('does not run filters, external diffs, textconv, replacement objects or fall back to a working file for missing blobs', async () => {
    const { root, a, b } = fork();
    write(root, '.gitattributes', 'topic.txt filter=probe diff=probe\n');
    const probe = join(root, 'SHOULD_NOT_EXIST'); const command = `touch '${probe}'; cat`;
    fixtureGit(root, ['config', 'filter.probe.clean', command]); fixtureGit(root, ['config', 'diff.probe.textconv', command]); fixtureGit(root, ['config', 'diff.external', command]);
    fixtureGit(root, ['replace', b, a]);
    const adapter = createGitAdapter(); const repo = await adapter.resolveRepository(root); const before = fingerprint(root);
    const result = await adapter.compareRevisions(repo, { a: oid(a), b: oid(b) }); expect(result.exclusive.b).toBe(1); expect(result.warnings.join()).toContain('refs/replace');
    const entry = result.endpoints.changes.find(e => e.path === 'topic.txt')!;
    expect((await adapter.readComparisonChange(repo, result, 'endpoints', entry)).text).toContain('+topic only'); expect(fingerprint(root)).toBe(before);
    const blob = fixtureGit(root, ['--no-replace-objects', 'rev-parse', `${b}:topic.txt`]); rmSync(join(root, '.git/objects', blob.slice(0, 2), blob.slice(2)));
    await expect(adapter.readComparisonChange(repo, result, 'endpoints', entry)).rejects.toMatchObject({ code: 'OBJECT_UNAVAILABLE' });
  });
  it('rejects cancellation, transport revision injection and oversized observations without returning partial results', async () => {
    const { root } = fork(); const adapter = createGitAdapter({ limits: { maxOutputBytes: 12 } });
    const repo = await createGitAdapter().resolveRepository(root);
    await expect(adapter.compareRevisions(repo, { a: head, b: ref('main') })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    await expect(createGitAdapter().compareRevisions(repo, { a: head, b: head }, AbortSignal.abort())).rejects.toMatchObject({ code: 'CANCELLED' });
    const input = { schemaVersion: 1, requestId: 'test', action: 'compare', sessionId: 'session', generation: 0, a: head, b: ref('topic') };
    expect(requestSchema.safeParse(input).success).toBe(true);
    for (const bad of [ { ...input, b: oid('HEAD~2') }, { ...input, command: 'git reset' }, { ...input, b: { kind: 'ref', name: '-h' } }, { ...input, b: { kind: 'commit', oid: 'a'.repeat(40), path: 'secret' } } ]) expect(requestSchema.safeParse(bad).success).toBe(false);
  });
  it('core resolves file membership and invalidates comparison IDs on refresh, writes and other sessions', async () => {
    const { root } = fork(); const queries = createRepositoryQueries(createGitAdapter()); const session = await queries.open(root);
    const request = { schemaVersion: 1 as const, requestId: randomUUID(), sessionId: session.sessionId, generation: 0 };
    const response = await queries.execute({ ...request, action: 'compare', a: ref('main'), b: head }); expect(response.ok).toBe(true);
    const result = revisionComparisonSchema.parse(response.ok && response.data);
    const pageRequest = { ...request, action: 'comparison-commits' as const, comparisonId: result.comparisonId, side: 'a' as const };
    expect((await queries.execute(pageRequest)).ok).toBe(true);
    const other = await queries.open(root); expect((await queries.execute({ ...pageRequest, sessionId: other.sessionId })).ok).toBe(false);
    expect((await queries.execute({ ...request, action: 'comparison-change', comparisonId: result.comparisonId, mode: 'merge-base', entryId: result.endpoints.changes[0]!.id })).ok).toBe(false);
    expect((await queries.execute({ ...pageRequest, generation: 1 })).ok).toBe(false);
    const refreshed = await queries.execute({ ...request, generation: 1, action: 'compare', a: head, b: ref('main') });
    const fresh = revisionComparisonSchema.parse(refreshed.ok && refreshed.data);
    const release = queries.suspendRepository(session.repository.commonGitDir); release();
    expect((await queries.execute({ ...pageRequest, generation: 1, comparisonId: fresh.comparisonId })).ok).toBe(false); queries.close();
  });
});
