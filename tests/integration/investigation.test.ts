import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { fileHistoryPageSchema, recordPageSchema, requestSchema, stashDetailSchema } from '@git-view/contracts';
import { createGitAdapter } from '../../packages/git-cli/src/index';
import { createRepositoryQueries } from '../../packages/core/src/index';
import { cleanupFixtures, commit, fingerprint, fixtureGit, repository, temporaryDirectory, write } from '../fixtures/git';

const head = { kind: 'head' as const };
afterEach(cleanupFixtures);
function renamed() {
  const root = repository(); const old = '旧名字 [x].txt'; const file = '新名字 [x].txt';
  write(root, old, 'first\nsecond\n'); const initial = commit(root, 'initial [literal]');
  write(root, old, 'first\nedited\n'); const edit = commit(root, 'edit alpha');
  fixtureGit(root, ['mv', old, file]); const rename = commit(root, 'rename alpha');
  write(root, file, 'first\nedited\nthird\n'); const final = commit(root, 'add ALPHA line');
  for (let n = 0; n < 3; n++) { write(root, 'other.txt', `${n}\n`); commit(root, `unrelated ${n}`); }
  return { root, old, file, initial, edit, rename, final };
}
function stashed() {
  const root = repository(); write(root, 'file.txt', 'base\n'); const base = commit(root, 'stash base');
  write(root, 'file.txt', 'index\n'); fixtureGit(root, ['add', '--', 'file.txt']); write(root, 'file.txt', 'working\n'); write(root, 'new.txt', 'untracked\n');
  fixtureGit(root, ['stash', 'push', '-u', '-m', 'saved work']);
  return { root, base, oid: fixtureGit(root, ['rev-parse', 'refs/stash']) };
}
describe('immutable history investigation', () => {
  it('searches literal subjects, authors, IDs and paths with fixed tips across pages', async () => {
    const { root, file, initial } = renamed(); const adapter = createGitAdapter({ limits: { historyPageSize: 2 } }); const repo = await adapter.resolveRepository(root); const before = fingerprint(root);
    const options = { scope: 'head' as const, field: 'subject' as const, term: 'alpha' };
    const first = await adapter.searchCommits(repo, options); expect(first.commits.map(c => c.subject)).toEqual(['add ALPHA line', 'rename alpha']); expect(first.nextCursor).toBeTruthy();
    expect((await adapter.searchCommits(repo, { scope: 'all', field: 'subject', term: '[literal]' })).commits.map(c => c.oid)).toEqual([initial]);
    expect((await adapter.searchCommits(repo, { scope: 'head', field: 'author', term: 'FIXTURE@EXAMPLE' })).commits).toHaveLength(2);
    expect((await adapter.searchCommits(repo, { scope: 'all', field: 'oid', term: initial.slice(0, 9) })).commits[0]?.oid).toBe(initial);
    expect((await adapter.searchCommits(repo, { scope: 'head', field: 'path', term: file })).commits.map(c => c.subject)).toEqual(['add ALPHA line', 'rename alpha']);
    expect(fingerprint(root)).toBe(before);
    write(root, 'new.txt', 'new\n'); commit(root, 'late alpha');
    const second = await adapter.searchCommits(repo, { ...options, cursor: first.nextCursor }); expect(second.snapshotId).toBe(first.snapshotId); expect(second.commits.map(c => c.subject)).toEqual(['edit alpha']); expect(second.nextCursor).toBeUndefined();
    await expect(adapter.searchCommits(repo, { ...options, term: 'late', cursor: first.nextCursor })).rejects.toMatchObject({ code: 'STALE_RESULT' });
  });
  it('follows ordinary renames and keeps real parent bases, paths and both sides of line origins', async () => {
    const { root, old, file, initial, edit, rename, final } = renamed(); const adapter = createGitAdapter({ limits: { historyPageSize: 2 } }); const repo = await adapter.resolveRepository(root);
    write(root, file, 'UNCOMMITTED\n'); write(root, '.mailmap', 'Fake <fake@invalid> Fixture <fixture@example.invalid>\n'); const before = fingerprint(root);
    const options = { endpoint: head, path: file }; const first = await adapter.listFileHistory(repo, options); const second = await adapter.listFileHistory(repo, { ...options, cursor: first.nextCursor });
    expect(first.firstParent).toBe(true); expect([...first.entries, ...second.entries].map(e => e.commit.oid)).toEqual([final, rename, edit, initial]);
    expect(second.entries[0]?.change.path).toBe(old); expect(first.entries[0]?.base).toBe(rename);
    const renameEntry = first.entries[1]!; expect(renameEntry.change.oldPath).toBe(old); expect(renameEntry.change.kind).toContain('R');
    const diff = await adapter.readFileHistoryChange(repo, first.snapshotId, first.entries[0]!.entryId); expect(diff.text).toContain('+third'); expect(diff.text).not.toContain('UNCOMMITTED');
    const after = await adapter.blameFileHistory(repo, first.snapshotId, first.entries[0]!.entryId, 'after'); expect(after.oid).toBe(final); expect(after.lines.map(line => [line.line, line.oid, line.text])).toEqual([[1, initial, 'first'], [2, edit, 'edited'], [3, final, 'third']]); expect(after.lines.every(line => line.author === 'Fixture')).toBe(true);
    const oldSide = await adapter.blameFileHistory(repo, first.snapshotId, renameEntry.entryId, 'before'); expect(oldSide.path).toBe(old); expect(oldSide.oid).toBe(edit); expect(oldSide.lines[0]?.path).toBe(old);
    const newSide = await adapter.blameFileHistory(repo, first.snapshotId, renameEntry.entryId, 'after'); expect(newSide.path).toBe(file); expect(newSide.lines.map(line => line.oid)).toEqual(oldSide.lines.map(line => line.oid));
    expect(fingerprint(root)).toBe(before);
  });
  it('states the first-parent merge scope and compares a merge against its actual first parent', async () => {
    const root = repository(); write(root, 'file.txt', 'base\n'); const base = commit(root); fixtureGit(root, ['branch', 'topic']); write(root, 'main.txt', 'main\n'); const main = commit(root, 'main');
    fixtureGit(root, ['switch', 'topic']); write(root, 'file.txt', 'topic\n'); const topic = commit(root, 'topic file'); fixtureGit(root, ['switch', 'main']); fixtureGit(root, ['merge', '--no-ff', 'topic', '-m', 'merge topic']); const merge = fixtureGit(root, ['rev-parse', 'HEAD']);
    const adapter = createGitAdapter(); const repo = await adapter.resolveRepository(root); const before = fingerprint(root); const history = await adapter.listFileHistory(repo, { endpoint: head, path: 'file.txt' });
    expect(history.warnings.join()).toContain('第一父链'); expect(history.entries.map(e => e.commit.oid)).toEqual([merge, base]); expect(history.entries[0]!.base).toBe(main); expect(history.entries[0]!.commit.parents).toEqual([main, topic]);
    expect((await adapter.readFileHistoryChange(repo, history.snapshotId, history.entries[0]!.entryId)).text).toContain('+topic'); expect(fingerprint(root)).toBe(before);
  });
  it('separates stash working, index and untracked trees without applying anything', async () => {
    const { root, base, oid } = stashed(); const adapter = createGitAdapter(); const repo = await adapter.resolveRepository(root); const before = fingerprint(root);
    const records = await adapter.listRecords(repo, { kind: 'stash' }); expect(records.entries).toHaveLength(1); expect(records.entries[0]).toMatchObject({ newOid: oid, selector: 'stash@{0}', availability: 'commit' });
    const detail = await adapter.readStash(repo, records.snapshotId, records.entries[0]!.recordId); expect(detail.parts.map(part => part.kind)).toEqual(['worktree', 'index', 'untracked']); expect(detail.parts[0]!.base).toBe(base);
    for (const [part, contents] of [['worktree', '+working'], ['index', '+index'], ['untracked', '+untracked']] as const) { const tree = detail.parts.find(item => item.kind === part)!; const diff = await adapter.readStashChange(repo, detail, part, tree.changes[0]!); expect(diff.text).toContain(contents); }
    expect(detail.parts[2]!.base).toBeNull(); expect(fingerprint(root)).toBe(before);
  });
  it('preserves raw reflog old/new IDs and missing objects, and freezes pages across new records', async () => {
    const { root } = renamed(); const adapter = createGitAdapter({ limits: { historyPageSize: 2 } }); const repo = await adapter.resolveRepository(root); const before = fingerprint(root);
    const options = { kind: 'reflog' as const, ref: 'HEAD' as const }; const first = await adapter.listRecords(repo, options); expect(first.entries).toHaveLength(2); expect(first.entries[0]!.oldOid).toBe(first.entries[1]!.newOid); expect(first.warnings.join()).toContain('命令审计'); expect(fingerprint(root)).toBe(before);
    write(root, 'extra.txt', 'extra\n'); commit(root, 'appended'); const next = await adapter.listRecords(repo, { ...options, cursor: first.nextCursor }); expect(next.snapshotId).toBe(first.snapshotId); expect(next.entries[0]!.selector).toBe('HEAD@{2}'); expect(next.entries[0]!.newOid).not.toBe(first.entries[0]!.newOid);
    const moved = await adapter.listRecords(repo, options); expect(moved.entries[1]!.recordId).toBe(first.entries[0]!.recordId); expect(moved.entries[1]!.selector).toBe('HEAD@{1}');
    const missing = first.entries[0]!.newOid; rmSync(join(root, '.git/objects', missing.slice(0, 2), missing.slice(2))); const afterDelete = fingerprint(root);
    const refreshed = await adapter.listRecords(repo, options); expect(refreshed.entries[1]!.newOid).toBe(missing); expect(refreshed.entries[1]!.availability).toBe('unavailable'); expect(fingerprint(root)).toBe(afterDelete);
  });
  it('uses the linked worktree HEAD log and rejects observation/cursor transfer', async () => {
    const { root } = renamed(); const linked = join(temporaryDirectory(), 'linked'); fixtureGit(root, ['worktree', 'add', '-b', 'linked', linked]); write(linked, 'linked.txt', 'linked\n'); const tip = commit(linked, 'linked only');
    const adapter = createGitAdapter({ limits: { historyPageSize: 1 } }); const repo = await adapter.resolveRepository(root); const tree = await adapter.resolveRepository(linked); const before = fingerprint(root); const linkedBefore = fingerprint(linked);
    const mainLog = await adapter.listRecords(repo, { kind: 'reflog' }); const linkedLog = await adapter.listRecords(tree, { kind: 'reflog' }); expect(linkedLog.entries[0]!.newOid).toBe(tip); expect(mainLog.entries[0]!.newOid).not.toBe(tip);
    await expect(adapter.listRecords(tree, { kind: 'reflog', cursor: mainLog.nextCursor })).rejects.toMatchObject({ code: 'STALE_RESULT' }); expect(fingerprint(root)).toBe(before); expect(fingerprint(linked)).toBe(linkedBefore);
  });
  it('qualifies shallow, limited and absent observations instead of fabricating complete results', async () => {
    const { root, file } = renamed(); const small = createGitAdapter({ limits: { investigationCommitLimit: 2 } }); const repo = await small.resolveRepository(root);
    const limited = await small.searchCommits(repo, { scope: 'all', field: 'subject', term: 'alpha' }); expect(limited.complete).toBe(false); expect(limited.warnings.join()).toContain('2');
    expect((await small.listFileHistory(repo, { endpoint: head, path: file })).complete).toBe(false);
    const clone = join(temporaryDirectory(), 'shallow'); fixtureGit(root, ['clone', '--depth=2', pathToFileURL(root).href, clone]); const adapter = createGitAdapter(); const shallow = await adapter.resolveRepository(clone);
    expect((await adapter.searchCommits(shallow, { scope: 'head', field: 'subject', term: 'unrelated' })).complete).toBe(false);
    const page = await adapter.listRecords(repo, { kind: 'stash' }); expect(page.entries).toEqual([]); expect(page.warnings.join()).toContain('没有');
    const empty = repository(); expect((await adapter.searchCommits(await adapter.resolveRepository(empty), { scope: 'all', field: 'subject', term: 'missing' })).commits).toEqual([]);
  });
  it('never runs worktree filters or textconv, and rejects missing blobs, binary blame and output limits', async () => {
    const root = repository(); const file = 'protected.txt'; write(root, file, 'base\n'); write(root, '.gitattributes', `${file} filter=probe diff=probe\n`); commit(root, 'protected base'); write(root, file, 'changed\n'); commit(root, 'protected change');
    const adapter = createGitAdapter(); const repo = await adapter.resolveRepository(root);
    fixtureGit(root, ['config', 'filter.probe.clean', 'exit 75']); fixtureGit(root, ['config', 'filter.probe.process', 'exit 75']); fixtureGit(root, ['config', 'diff.probe.textconv', 'exit 75']); fixtureGit(root, ['config', 'diff.external', 'exit 75']);
    const before = fingerprint(root); const history = await adapter.listFileHistory(repo, { endpoint: head, path: file }); await adapter.blameFileHistory(repo, history.snapshotId, history.entries[0]!.entryId, 'after'); await adapter.readFileHistoryChange(repo, history.snapshotId, history.entries[0]!.entryId); expect(fingerprint(root)).toBe(before);
    const blob = fixtureGit(root, ['rev-parse', `${history.entries[0]!.commit.oid}:${file}`]); rmSync(join(root, '.git/objects', blob.slice(0, 2), blob.slice(2)));
    await expect(adapter.blameFileHistory(repo, history.snapshotId, history.entries[0]!.entryId, 'after')).rejects.toMatchObject({ code: 'OBJECT_UNAVAILABLE' });
    await expect(adapter.readFileHistoryChange(repo, history.snapshotId, history.entries[0]!.entryId)).rejects.toMatchObject({ code: 'OBJECT_UNAVAILABLE' });
    const binary = repository(); write(binary, 'binary', Buffer.from([1, 0, 2])); commit(binary); const binaryRepo = await adapter.resolveRepository(binary); const binaryHistory = await adapter.listFileHistory(binaryRepo, { endpoint: head, path: 'binary' });
    await expect(adapter.blameFileHistory(binaryRepo, binaryHistory.snapshotId, binaryHistory.entries[0]!.entryId, 'after')).rejects.toMatchObject({ code: 'UNSUPPORTED_PATH' });
    await expect(createGitAdapter({ limits: { maxOutputBytes: 10 } }).listRecords(binaryRepo, { kind: 'reflog' })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    await expect(adapter.searchCommits(binaryRepo, { scope: 'all', field: 'subject', term: 'fixture' }, AbortSignal.abort())).rejects.toMatchObject({ code: 'CANCELLED' });
  });
  // Windows cannot create control-character, wildcard or trailing-space names.
  // Keep its legal special-name case on every platform, plus the POSIX case.
  it.each(['- 空格 中文 🌱 [x].txt', ...(process.platform === 'win32' ? [] : [' 空格\t换行\n中文 🌱 [*].txt '])])('keeps literal path %j and reads the surviving side of deletions', async file => {
    const root = repository(); fixtureGit(root, ['config', 'core.quotePath', 'false']); write(root, file, 'first\n'); const initial = commit(root, 'literal file'); write(root, file, 'second\n'); const edited = commit(root, 'edit literal file'); fixtureGit(root, ['rm', '--', file]); const deleted = commit(root, 'delete literal file');
    const adapter = createGitAdapter(); const repo = await adapter.resolveRepository(root); const before = fingerprint(root);
    const history = await adapter.listFileHistory(repo, { endpoint: head, path: file }); expect(history.entries.map(item => item.commit.oid)).toEqual([deleted, edited, initial]);
    const removed = history.entries[0]!; expect(removed.change.kind).toBe('D'); expect((await adapter.readFileHistoryChange(repo, history.snapshotId, removed.entryId)).text).toContain('-second');
    const blame = await adapter.blameFileHistory(repo, history.snapshotId, removed.entryId, 'before'); expect(blame.lines[0]).toMatchObject({ oid: edited, text: 'second', originalLine: 1, path: removed.change.path });
    await expect(adapter.blameFileHistory(repo, history.snapshotId, removed.entryId, 'after')).rejects.toMatchObject({ code: 'OBJECT_UNAVAILABLE' }); expect(fingerprint(root)).toBe(before);
  });
  it('opens the original commit selected by search and line origin despite replacement refs', async () => {
    const root = repository(); write(root, 'file.txt', 'original\n'); const original = commit(root, 'original subject'); write(root, 'file.txt', 'replacement\n'); const replacement = commit(root, 'replacement subject'); fixtureGit(root, ['replace', original, replacement]);
    const adapter = createGitAdapter(); const repo = await adapter.resolveRepository(root); const before = fingerprint(root);
    const search = await adapter.searchCommits(repo, { scope: 'head', field: 'oid', term: original }); expect(search.commits[0]?.subject).toBe('original subject');
    const detail = await adapter.readCommit(repo, search.commits[0]!.oid); expect(detail.commit.subject).toBe('original subject'); expect((await adapter.readCommitChange(repo, original, detail.changes[0]!)).text).toContain('+original'); expect(fingerprint(root)).toBe(before);
  });
  it('authorizes stash parts only after current-session details and rejects forged or expired entries', async () => {
    const { root } = stashed(); const queries = createRepositoryQueries(createGitAdapter()); const session = await queries.open(root); const base = { schemaVersion: 1 as const, sessionId: session.sessionId, generation: 0, requestId: randomUUID() };
    const response = await queries.execute({ ...base, action: 'records', kind: 'stash' }); const page = recordPageSchema.parse(response.ok && response.data); const recordId = page.entries[0]!.recordId;
    const request = { ...base, action: 'stash-detail' as const, snapshotId: page.snapshotId, recordId }; const result = await queries.execute(request); const detail = stashDetailSchema.parse(result.ok && result.data);
    const change = { ...base, action: 'stash-change' as const, snapshotId: page.snapshotId, recordId, part: 'untracked' as const, entryId: detail.parts.find(part => part.kind === 'untracked')!.changes[0]!.id };
    expect((await queries.execute(change)).ok).toBe(true); expect((await queries.execute({ ...change, entryId: 'forged' })).ok).toBe(false);
    const other = await queries.open(root); expect((await queries.execute({ ...request, sessionId: other.sessionId })).ok).toBe(false);
    await queries.execute({ ...base, generation: 1, action: 'records', kind: 'stash' }); const expired = await queries.execute({ ...change, generation: 1 }); expect(!expired.ok && expired.error.code).toBe('STALE_RESULT'); queries.close();
  });
  it('binds core details and cursors to the current session, generation, filters and write lifecycle', async () => {
    const { root, file } = renamed(); const queries = createRepositoryQueries(createGitAdapter({ limits: { historyPageSize: 1 } })); const session = await queries.open(root); const base = { schemaVersion: 1 as const, requestId: randomUUID(), sessionId: session.sessionId, generation: 0 };
    const request = { ...base, action: 'file-history' as const, endpoint: head, path: file }; const response = await queries.execute(request); const history = fileHistoryPageSchema.parse(response.ok && response.data);
    const diff = { ...base, action: 'file-history-change' as const, snapshotId: history.snapshotId, entryId: history.entries[0]!.entryId }; expect((await queries.execute(diff)).ok).toBe(true);
    expect((await queries.execute({ ...diff, entryId: 'forged' })).ok).toBe(false); const other = await queries.open(root); expect((await queries.execute({ ...diff, sessionId: other.sessionId })).ok).toBe(false);
    expect((await queries.execute({ ...request, path: 'different.txt', cursor: history.nextCursor })).ok).toBe(false); expect((await queries.execute({ ...diff, generation: 1 })).ok).toBe(false);
    const refreshed = await queries.execute({ ...request, generation: 1 }); const newHistory = fileHistoryPageSchema.parse(refreshed.ok && refreshed.data); const release = queries.suspendRepository(session.repository.commonGitDir); release(); expect((await queries.execute({ ...diff, generation: 1, snapshotId: newHistory.snapshotId })).ok).toBe(false); queries.close();
  });
  it('validates paths, IDs and query identity at the transport boundary', () => {
    const base = { schemaVersion: 1, sessionId: 'session', generation: 0, requestId: 'test' };
    for (const bad of [ { ...base, action: 'file-history', endpoint: head, path: '../outside' }, { ...base, action: 'file-history', endpoint: head, path: '/outside' }, { ...base, action: 'search', scope: 'head', field: 'oid', term: 'HEAD~1' }, { ...base, action: 'records', kind: 'stash', ref: 'HEAD' }, { ...base, action: 'blame', snapshotId: randomUUID(), entryId: 'test', side: 'working' }, { ...base, action: 'records', kind: 'reflog', command: 'drop' } ]) expect(requestSchema.safeParse(bad).success).toBe(false);
    expect(requestSchema.safeParse({ ...base, action: 'search', scope: 'all', field: 'path', term: ' [name].txt ' }).success).toBe(true);
  });
});
