import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createGitAdapter } from '../../packages/git-cli/src/index.js';
import { runGit } from '../../packages/git-cli/src/runner.js';
import { parseStatus } from '../../packages/git-cli/src/parse.js';
import { cleanupFixtures, commit, fingerprint, fixtureGit as git, repository, temporaryDirectory, write } from '../fixtures/git.js';

afterAll(cleanupFixtures);
const unixIt = process.platform === 'win32' ? it.skip : it;

describe('real read-only Git adapter', () => {
  it('shows V1→V2 and V2→V3 independently and preserves every repository byte', async () => {
    const root = repository();
    write(root, 'app.txt', 'V1\n');
    commit(root);
    write(root, 'app.txt', 'V2\n');
    git(root, ['add', '--', 'app.txt']);
    write(root, 'app.txt', 'V3\n');
    const before = fingerprint(root);
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(root);
    const overview = await adapter.readOverview(identity);
    expect(overview.complete).toBe(true);
    expect(overview.changes.staged.map((entry) => entry.path)).toEqual(['app.txt']);
    expect(overview.changes.unstaged.map((entry) => entry.path)).toEqual(['app.txt']);
    const staged = await adapter.readChange(identity, overview.changes.staged[0]!, overview.fingerprint);
    const unstaged = await adapter.readChange(identity, overview.changes.unstaged[0]!, overview.fingerprint);
    expect(staged.text).toContain('-V1\n+V2');
    expect(unstaged.text).toContain('-V2\n+V3');
    const history = await adapter.listHistory(identity, { scope: 'all' });
    const detail = await adapter.readCommit(identity, history.commits[0]!.oid);
    expect(detail.base).toBeNull();
    expect((await adapter.readCommitChange(identity, detail.commit.oid, detail.changes[0]!)).text).toContain('+V1');
    expect(fingerprint(root)).toBe(before);
  });

  it('handles unborn and ignored files, with symlink preview where available', async () => {
    const root = repository();
    const outside = temporaryDirectory();
    write(outside, 'secret.txt', 'SECRET_TARGET_CONTENT');
    write(root, '.gitignore', 'ignored.txt\n');
    write(root, 'ignored.txt', 'hidden');
    write(root, 'new.txt', 'hello\n');
    if (process.platform !== 'win32') symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link'));
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(root);
    const overview = await adapter.readOverview(identity);
    expect(overview.head).toEqual({ kind: 'unborn', branch: 'main' });
    expect(overview.changes.untracked.map((entry) => entry.path)).not.toContain('ignored.txt');
    if (process.platform !== 'win32') {
      const preview = await adapter.readChange(identity, overview.changes.untracked.find((entry) => entry.path === 'link')!, overview.fingerprint);
      expect(preview.text).toBe(path.join(outside, 'secret.txt'));
      expect(preview.text).not.toContain('SECRET_TARGET_CONTENT');
      expect(preview.format).toBe('text');
    }
    expect((await adapter.listHistory(identity, { scope: 'all' })).commits).toEqual([]);
  });

  it('keeps paths containing UTF-8, spaces, tabs, newline and leading dash intact; parses renames', async () => {
    const root = repository();
    const names = ['中文 空格.txt', '-option.txt', ...(process.platform === 'win32' ? [] : ['line\nbreak.txt', 'tab\there.txt'])];
    for (const name of names) write(root, name, 'before\n');
    commit(root);
    for (const name of names) write(root, name, 'after\n');
    git(root, ['mv', '--', '中文 空格.txt', '重命名.txt']);
    git(root, ['add', '--', '重命名.txt']);
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(root);
    const overview = await adapter.readOverview(identity);
    for (const item of overview.changes.unstaged) {
      const diff = await adapter.readChange(identity, item, overview.fingerprint);
      expect(diff.text).toContain('+after');
    }
    if (process.platform !== 'win32') expect(overview.changes.unstaged.map((entry) => entry.path)).toContain('line\\x0abreak.txt');
    // A separate unchanged file ensures Git can actually identify the rename.
    write(root, 'rename-source', 'long unchanged rename content\n');
    commit(root);
    git(root, ['mv', '--', 'rename-source', 'renamed']);
    const renamed = await adapter.readOverview(identity);
    expect(renamed.changes.staged.find((entry) => entry.path === 'renamed')?.oldPath).toBe('rename-source');
  });

  it('resolves worktree identity from a subdirectory and keeps HEAD/index separate', async () => {
    const root = repository();
    write(root, 'file', 'main\n');
    commit(root);
    const holder = temporaryDirectory();
    const linked = path.join(holder, 'linked');
    git(root, ['worktree', 'add', '-b', 'other', linked]);
    write(linked, 'file', 'other\n');
    git(linked, ['add', '--', 'file']);
    mkdirSync(path.join(linked, 'subdir'));
    const adapter = createGitAdapter();
    const first = await adapter.resolveRepository(root);
    const second = await adapter.resolveRepository(path.join(linked, 'subdir'));
    expect(second.repositoryId).toBe(first.repositoryId);
    expect(second.worktreeId).not.toBe(first.worktreeId);
    expect(second.worktreeRoot).toContain('/linked');
    expect((await adapter.readOverview(first)).changes.staged).toHaveLength(0);
    expect((await adapter.readOverview(second)).changes.staged).toHaveLength(1);
  });

  it('shows gitlinks without traversing submodules and refuses non-UTF-8 path details', async () => {
    const root = repository();
    write(root, 'file', 'base\n');
    const oid = commit(root);
    mkdirSync(path.join(root, 'nested'));
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${oid},nested`]);
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(root);
    const overview = await adapter.readOverview(identity);
    const nested = overview.changes.staged.find((entry) => entry.path === 'nested');
    expect(nested).toBeDefined();
    const diff = await adapter.readChange(identity, nested!, overview.fingerprint);
    expect(diff.text).toContain(`Subproject commit ${oid}`);
    expect(diff.reason).toContain('gitlink');
    // This macOS filesystem rejects invalid UTF-8 names (EPERM), so that path's
    // byte-parser boundary is tested directly; real special paths are tested above.
    const unsupported = parseStatus(Buffer.from([63, 32, 0xff, 0xfe, 0])).untracked[0];
    expect(unsupported?.path).toBe('\\xff\\xfe');
    await expect(adapter.readChange(identity, unsupported!, overview.fingerprint)).rejects.toMatchObject({ code: 'UNSUPPORTED_PATH' });
  });

  it('reports detached HEAD, conflicts and a merge operation without normalizing away uncertainty', async () => {
    const root = repository();
    write(root, 'file', 'base\n');
    commit(root);
    git(root, ['switch', '-c', 'other']);
    write(root, 'file', 'other\n');
    commit(root);
    git(root, ['switch', 'main']);
    write(root, 'file', 'main\n');
    const main = commit(root);
    git(root, ['checkout', '--detach', main]);
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(root);
    expect((await adapter.readOverview(identity)).head.kind).toBe('detached');
    git(root, ['switch', 'main']);
    expect(() => git(root, ['merge', 'other'])).toThrow();
    const conflicted = await adapter.readOverview(identity);
    expect(conflicted.operation).toContain('merge');
    expect(conflicted.changes.conflicts.map((entry) => entry.path)).toEqual(['file']);
  });

  unixIt('does not execute filter, fsmonitor, textconv or external diff probes; safely retains staged data', async () => {
    const root = repository();
    write(root, 'file', 'one\n');
    write(root, '.gitattributes', 'file diff=probe filter=probe\n');
    commit(root);
    write(root, 'file', 'two\n');
    git(root, ['add', '--', 'file']);
    write(root, 'file', 'three\n');
    const sentinel = path.join(temporaryDirectory(), 'PROBE_RAN');
    const probe = `touch '${sentinel}'; cat`;
    for (const key of ['filter.probe.clean', 'filter.probe.process', 'diff.probe.textconv', 'diff.external', 'core.fsmonitor']) git(root, ['config', key, probe]);
    const before = fingerprint(root);
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(root);
    const overview = await adapter.readOverview(identity);
    expect(overview.complete).toBe(false);
    expect(overview.warnings.join()).toContain('UNSUPPORTED_FILTER');
    expect(overview.changes.staged.map((entry) => entry.path)).toEqual(['file']);
    expect(overview.changes.unstaged).toEqual([]);
    const diff = await adapter.readChange(identity, overview.changes.staged[0]!, overview.fingerprint);
    expect(diff.text).toContain('-one\n+two');
    const history = await adapter.listHistory(identity, { scope: 'all' });
    await adapter.readCommit(identity, history.commits[0]!.oid);
    expect(existsSync(sentinel)).toBe(false);
    expect(fingerprint(root)).toBe(before);
  });

  it('degrades binary, oversized and invalid UTF-8 previews and rejects stale evidence', async () => {
    const root = repository();
    write(root, 'binary', Buffer.from([1, 0, 2]));
    write(root, 'large', 'a'.repeat(1024 * 1024 + 1));
    write(root, 'encoding', Buffer.from([0xff, 0xfe]));
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(root);
    const overview = await adapter.readOverview(identity);
    for (const entry of overview.changes.untracked) expect((await adapter.readChange(identity, entry, overview.fingerprint)).format).toBe('unavailable');
    write(root, 'binary', 'changed');
    await expect(adapter.readChange(identity, overview.changes.untracked[0]!, overview.fingerprint)).rejects.toMatchObject({ code: 'STALE_RESULT' });
  });

  unixIt('disables fsmonitor in a full status scan and ignores inherited repository redirects', async () => {
    const root = repository();
    write(root, 'file', 'base\n');
    commit(root);
    write(root, 'file', 'modified\n');
    const other = repository();
    const sentinel = path.join(temporaryDirectory(), 'FSMONITOR_RAN');
    git(root, ['config', 'core.fsmonitor', `touch '${sentinel}'`]);
    const oldGitDir = process.env.GIT_DIR;
    const oldIndexFile = process.env.GIT_INDEX_FILE;
    try {
      process.env.GIT_DIR = path.join(other, '.git');
      process.env.GIT_INDEX_FILE = path.join(other, '.git/index');
      const adapter = createGitAdapter();
      const identity = await adapter.resolveRepository(root);
      const overview = await adapter.readOverview(identity);
      expect(overview.complete).toBe(true);
      expect(overview.changes.unstaged.map((entry) => entry.path)).toEqual(['file']);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      if (oldGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = oldGitDir;
      if (oldIndexFile === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = oldIndexFile;
    }
  });

  it('distinguishes removed repositories and file permission failures from clean results', async () => {
    const root = repository();
    write(root, 'private', 'untracked content');
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(root);
    if (process.platform !== 'win32') {
      chmodSync(path.join(root, 'private'), 0);
      try {
        const overview = await adapter.readOverview(identity);
        await expect(adapter.readChange(identity, overview.changes.untracked[0]!, overview.fingerprint)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      } finally { chmodSync(path.join(root, 'private'), 0o600); }
    }
    rmSync(root, { recursive: true });
    await expect(adapter.readOverview(identity)).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });
  });

  it('uses first parent for merges and pins pagination to the original reference tips', async () => {
    const root = repository();
    write(root, 'base', 'base\n');
    commit(root);
    git(root, ['switch', '-c', 'side']);
    write(root, 'side', 'side\n');
    const side = commit(root);
    git(root, ['switch', 'main']);
    write(root, 'main', 'main\n');
    const main = commit(root);
    git(root, ['merge', '--no-ff', 'side', '-m', 'merge']);
    const merge = git(root, ['rev-parse', 'HEAD']);
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(root);
    const detail = await adapter.readCommit(identity, merge);
    expect(detail.commit.parents).toEqual([main, side]);
    expect(detail.base).toBe(main);
    expect(detail.changes.map((entry) => entry.path)).toEqual(['side']);
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
    let parent = merge;
    for (let i = 0; i < 203; i++) parent = git(root, ['commit-tree', tree, '-p', parent, '-m', `page ${i}`]);
    git(root, ['update-ref', 'refs/heads/main', parent]);
    const first = await adapter.listHistory(identity, { scope: 'all' });
    expect(first.commits).toHaveLength(200);
    expect(first.nextCursor).toBeTruthy();
    const newTip = git(root, ['commit-tree', tree, '-p', parent, '-m', 'new after page']);
    git(root, ['update-ref', 'refs/heads/main', newTip]);
    const second = await adapter.listHistory(identity, { scope: 'all', cursor: first.nextCursor });
    expect(second.commits).toHaveLength(7);
    expect(second.headOid).toBe(parent);
    expect([...first.commits, ...second.commits].some((node) => node.oid === newTip)).toBe(false);
    expect((await adapter.listHistory(identity, { scope: 'head' })).headOid).toBe(newTip);
  }, 30_000);

  it('shows actual shallow parent boundaries and rejects unsupported bare/promisor repos', async () => {
    const root = repository();
    write(root, 'file', 'first\n');
    const first = commit(root);
    write(root, 'file', 'second\n');
    const second = commit(root);
    write(root, '.git/shallow', `${second}\n`);
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(root);
    const history = await adapter.listHistory(identity, { scope: 'all' });
    expect(history.shallow).toBe(true);
    expect(history.commits[0]?.boundary).toBe(true);
    expect(history.commits[0]?.parents).toEqual([first]);
    await expect(adapter.readCommit(identity, second)).rejects.toMatchObject({ code: 'OBJECT_UNAVAILABLE' });
    git(root, ['config', 'remote.origin.promisor', 'true']);
    await expect(adapter.resolveRepository(root)).rejects.toMatchObject({ code: 'UNSUPPORTED_REPOSITORY' });
    const bare = temporaryDirectory();
    git(bare, ['init', '--bare']);
    await expect(adapter.resolveRepository(bare)).rejects.toMatchObject({ code: 'UNSUPPORTED_REPOSITORY' });
  });

  it('reports a missing local blob instead of inventing an empty commit diff', async () => {
    const root = repository();
    write(root, 'file', 'blob that will be missing\n');
    const oid = commit(root);
    const blob = git(root, ['rev-parse', 'HEAD:file']);
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(root);
    const detail = await adapter.readCommit(identity, oid);
    rmSync(path.join(root, '.git/objects', blob.slice(0, 2), blob.slice(2)));
    await expect(adapter.readCommitChange(identity, oid, detail.changes[0]!)).rejects.toMatchObject({ code: 'OBJECT_UNAVAILABLE' });
  });

  it('returns structured cancellation and output limits', async () => {
    const root = repository();
    await expect(runGit(root, ['status'], { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
    write(root, 'long-path-to-exceed-output', 'value');
    await expect(runGit(root, ['status', '--porcelain=v2', '-z'], { maxOutputBytes: 4 })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
  });

  unixIt('returns structured timeout, mid-read cancellation and missing Git errors from a POSIX shim', async () => {
    const root = repository();
    const fakeBin = temporaryDirectory();
    writeFileSync(path.join(fakeBin, 'git'), '#!/bin/sh\nexec /bin/sleep 5\n', { mode: 0o755 });
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = fakeBin;
      await expect(runGit(root, ['status'], { timeoutMs: 30 })).rejects.toMatchObject({ code: 'TIMEOUT' });
      const controller = new AbortController();
      const cancelling = runGit(root, ['status'], { signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      await expect(cancelling).rejects.toMatchObject({ code: 'CANCELLED' });
      process.env.PATH = path.join(fakeBin, 'missing');
      await expect(runGit(root, ['status'])).rejects.toMatchObject({ code: 'GIT_NOT_FOUND' });
    } finally { process.env.PATH = originalPath; }
  });
});
