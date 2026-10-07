import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createGitAdapter } from '../../packages/git-cli/src/index.js';
import { createGitWriteAdapter, indexWriteEvidenceSchema, type IndexWriteEvidence, type PreparedIndexOperation } from '../../packages/git-write/src/index.js';
import { cleanupFixtures, commit, fingerprint, fixtureGit as git, repository, temporaryDirectory, write, GIT_OPERATION_TEST_TIMEOUT } from '../fixtures/git.js';

afterAll(cleanupFixtures);
const reader = createGitAdapter();
const writer = createGitWriteAdapter();
async function prepare(root: string, kind: PreparedIndexOperation['kind'], names?: string[]) {
  const identity = await reader.resolveRepository(root);
  const overview = await reader.readOverview(identity);
  const entries = kind === 'stage-files' ? [...overview.changes.unstaged, ...overview.changes.untracked] : overview.changes.staged;
  return writer.prepare(identity, kind, names ? entries.filter((entry) => names.includes(Buffer.from(entry.rawPath, 'base64').toString())) : entries, overview.fingerprint);
}
async function execute(prepared: PreparedIndexOperation) {
  let evidence: IndexWriteEvidence | undefined;
  await writer.execute(prepared, async (value) => { evidence = indexWriteEvidenceSchema.parse(JSON.parse(JSON.stringify(value))); });
  expect(evidence).toBeDefined();
  expect(await writer.verify(prepared.repository, evidence!)).toBe(true);
  return evidence!;
}
const index = (root: string) => readFileSync(path.join(root, '.git/index'));
const worktree = (root: string) => Object.fromEntries(readdirSync(root).filter((name) => name !== '.git').map((name) => [name, readFileSync(path.join(root, name))]));

describe.skipIf(process.platform === 'win32')('isolated whole-file index writes (POSIX)', { timeout: GIT_OPERATION_TEST_TIMEOUT }, () => {
  it('previews read-only; replaces partial V2 with complete V3 and preserves unrelated index/worktree bytes', async () => {
    const root = repository();
    write(root, 'file', 'V1\n'); write(root, 'other', 'original\n'); commit(root);
    write(root, 'file', 'V2\n'); write(root, 'other', 'staged-other\n'); git(root, ['add', '--', 'file', 'other']);
    write(root, 'file', 'V3\n'); write(root, 'other', 'unstaged-other\n');
    const before = fingerprint(root), files = worktree(root), originalOther = git(root, ['rev-parse', ':other']);
    const prepared = await prepare(root, 'stage-files', ['file']);
    expect(fingerprint(root)).toBe(before);
    expect(JSON.parse(JSON.stringify(prepared))).toEqual(prepared);
    const evidence = await execute(prepared);
    expect(git(root, ['show', ':file'])).toBe('V3');
    expect(git(root, ['rev-parse', ':other'])).toBe(originalOther);
    expect(worktree(root)).toEqual(files);
    expect(await writer.verify({ ...prepared.repository, worktreeId: 'wrong' }, evidence)).toBe(false);
    const unstage = await prepare(root, 'unstage-files', ['file']);
    await execute(unstage);
    expect(git(root, ['show', ':file'])).toBe('V1');
    expect(worktree(root)).toEqual(files);
    expect(await writer.verify(prepared.repository, evidence)).toBe(false);
  });

  it('stages and unstages unborn files including Chinese, newline and option-like names', async () => {
    const root = repository();
    const names = ['中文 空格', '-leading-option', 'line\nbreak', 'tab\tname'];
    for (const name of names) write(root, name, `contents ${name}\n`);
    const files = worktree(root);
    await execute(await prepare(root, 'stage-files'));
    for (const name of names) expect(git(root, ['show', `:${name}`])).toBe(`contents ${name}`);
    await execute(await prepare(root, 'unstage-files'));
    expect(git(root, ['ls-files'])).toBe('');
    expect(worktree(root)).toEqual(files);
  });

  it('stages deletions and restores HEAD for renamed paths without moving worktree files', async () => {
    const root = repository();
    write(root, 'old', 'long rename content\n'); write(root, 'deleted', 'deleted\n'); commit(root);
    git(root, ['mv', '--', 'old', 'renamed']);
    const prepared = await prepare(root, 'unstage-files', ['renamed']);
    expect(prepared.paths).toEqual(['old', 'renamed']);
    const files = worktree(root);
    await execute(prepared);
    expect(git(root, ['show', ':old'])).toBe('long rename content');
    expect(git(root, ['ls-files'])).not.toContain('renamed');
    expect(worktree(root)).toEqual(files);
    rmSync(path.join(root, 'deleted'));
    await execute(await prepare(root, 'stage-files', ['deleted']));
    expect(git(root, ['ls-files'])).not.toContain('deleted');
    expect(existsSync(path.join(root, 'deleted'))).toBe(false);
    await execute(await prepare(root, 'unstage-files', ['deleted']));
    expect(git(root, ['show', ':deleted'])).toBe('deleted');
    expect(existsSync(path.join(root, 'deleted'))).toBe(false);
  });

  it('stages symlink text only and respects core.filemode=false', async () => {
    const root = repository(), outside = temporaryDirectory();
    write(root, 'file', 'base\n'); write(outside, 'secret', 'never read\n'); commit(root);
    git(root, ['config', 'core.filemode', 'false']);
    chmodSync(path.join(root, 'file'), 0o755); write(root, 'file', 'changed\n');
    write(root, 'new-executable', 'new\n'); chmodSync(path.join(root, 'new-executable'), 0o755);
    symlinkSync(path.join(outside, 'secret'), path.join(root, 'link'));
    await execute(await prepare(root, 'stage-files'));
    expect(git(root, ['ls-files', '--stage', '--', 'file'])).toMatch(/^100644 /);
    expect(git(root, ['ls-files', '--stage', '--', 'new-executable'])).toMatch(/^100644 /);
    expect(git(root, ['show', ':link'])).toBe(path.join(outside, 'secret'));
  });

  it('matches Git owner-execute semantics for 0645, 0654 and 0744 permissions', async () => {
    const root = repository(), reference = repository();
    const modes = [['other-execute', 0o645], ['group-execute', 0o654], ['owner-execute', 0o744]] as const;
    for (const directory of [root, reference]) {
      for (const [name] of modes) write(directory, name, 'before\n');
      commit(directory); git(directory, ['config', 'core.filemode', 'true']);
      for (const [name, mode] of modes) { write(directory, name, 'after\n'); chmodSync(path.join(directory, name), mode); }
    }
    git(reference, ['add', '--', ...modes.map(([name]) => name)]);
    const expected = git(reference, ['ls-files', '--stage']);
    expect(expected).toMatch(/100644 [^\n]+group-execute/);
    expect(expected).toMatch(/100644 [^\n]+other-execute/);
    expect(expected).toMatch(/100755 [^\n]+owner-execute/);
    const before = worktree(root);
    await execute(await prepare(root, 'stage-files'));
    expect(git(root, ['ls-files', '--stage'])).toBe(expected);
    expect(worktree(root)).toEqual(before);
  });

  it('unstages only a detected copy target and preserves the modified staged source', async () => {
    const root = repository();
    const original = Array.from({ length: 100 }, (_, i) => `original source line ${i}\n`).join('');
    write(root, 'source', original); commit(root);
    git(root, ['config', 'status.renames', 'copies']);
    write(root, 'copied', original); write(root, 'source', `${original}staged source change\n`);
    git(root, ['add', '--', 'source', 'copied']);
    const identity = await reader.resolveRepository(root), overview = await reader.readOverview(identity);
    const copied = overview.changes.staged.find((entry) => entry.path === 'copied');
    expect(copied).toMatchObject({ kind: 'C', oldPath: 'source' });
    const sourceBefore = git(root, ['ls-files', '--stage', '--', 'source']), filesBefore = worktree(root);
    const prepared = await writer.prepare(identity, 'unstage-files', [copied!], overview.fingerprint);
    expect(prepared.paths).toEqual(['copied']);
    await execute(prepared);
    expect(git(root, ['ls-files', '--stage', '--', 'source'])).toBe(sourceBefore);
    expect(git(root, ['ls-files', '--', 'copied'])).toBe('');
    expect(worktree(root)).toEqual(filesBefore);
  });

  it('fails safely when selected content, HEAD or config changes after preview', async () => {
    for (const change of ['content', 'head', 'config'] as const) {
      const root = repository(); write(root, 'file', 'base\n'); commit(root); write(root, 'file', 'changed\n');
      const prepared = await prepare(root, 'stage-files');
      if (change === 'content') write(root, 'file', 'newer\n');
      if (change === 'head') git(root, ['symbolic-ref', 'HEAD', 'refs/heads/different']);
      if (change === 'config') git(root, ['config', 'core.filemode', 'false']);
      const before = index(root); let callback = false;
      await expect(writer.execute(prepared, async () => { callback = true; })).rejects.toMatchObject({ code: 'STALE_RESULT' });
      expect(callback).toBe(false); expect(index(root)).toEqual(before); expect(existsSync(path.join(root, '.git/index.lock'))).toBe(false);
    }
  });

  it('does not remove a competing lock or install when callback changes selected content', async () => {
    const root = repository(); write(root, 'file', 'base\n'); commit(root); write(root, 'file', 'changed\n');
    const prepared = await prepare(root, 'stage-files'), before = index(root), lockPath = path.join(root, '.git/index.lock');
    writeFileSync(lockPath, 'someone else');
    await expect(writer.execute(prepared, async () => {})).rejects.toMatchObject({ code: 'REPOSITORY_BUSY' });
    expect(readFileSync(lockPath, 'utf8')).toBe('someone else'); rmSync(lockPath);
    await expect(writer.execute(prepared, async () => { write(root, 'file', 'concurrent\n'); })).rejects.toMatchObject({ code: 'STALE_RESULT' });
    expect(index(root)).toEqual(before); expect(existsSync(lockPath)).toBe(false);
  });

  it('preserves a replaced lock and concurrent index change without restoring an old index', async () => {
    const root = repository(); write(root, 'file', 'base\n'); commit(root); write(root, 'file', 'changed\n');
    const prepared = await prepare(root, 'stage-files'), before = index(root), lockPath = path.join(root, '.git/index.lock');
    await expect(writer.execute(prepared, async () => {
      renameSync(lockPath, path.join(root, '.git/our-displaced-lock'));
      writeFileSync(lockPath, 'new owner');
    })).rejects.toMatchObject({ code: 'REPOSITORY_BUSY' });
    expect(readFileSync(lockPath, 'utf8')).toBe('new owner'); expect(index(root)).toEqual(before);
    rmSync(lockPath); rmSync(path.join(root, '.git/our-displaced-lock'));
    const marker = Buffer.from('concurrent external index contents');
    await expect(writer.execute(prepared, async () => { writeFileSync(path.join(root, '.git/index'), marker); })).rejects.toBeDefined();
    expect(index(root)).toEqual(marker);
  });

  it('refuses external filters, supports built-in conversion and never executes hook probes', async () => {
    const root = repository(); write(root, 'file', 'base\n'); commit(root); write(root, 'file', 'changed\n');
    const identity = await reader.resolveRepository(root), overview = await reader.readOverview(identity);
    const marker = path.join(root, 'filter-ran');
    git(root, ['config', 'filter.danger.clean', `touch '${marker}'`]);
    write(root, '.gitattributes', 'file filter=danger\n');
    await expect(writer.prepare(identity, 'stage-files', overview.changes.unstaged, overview.fingerprint)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILTER' });
    expect(existsSync(marker)).toBe(false);
    git(root, ['config', '--unset', 'filter.danger.clean']);
    write(root, '.gitattributes', 'file text\n');
    await execute(await prepare(root, 'stage-files', ['file']));
    rmSync(path.join(root, '.gitattributes'));
    write(root, 'file', 'changed again\n');
    const hookMarker = path.join(root, 'hook-ran');
    write(root, '.git/hooks/post-index-change', `#!/bin/sh\ntouch '${hookMarker}'\n`); chmodSync(path.join(root, '.git/hooks/post-index-change'), 0o755);
    await execute(await prepare(root, 'stage-files', ['file']));
    expect(existsSync(hookMarker)).toBe(false);
  });

  it('rejects special index flags, split index, sparse settings and ongoing operations', async () => {
    for (const situation of ['assume', 'intent', 'split', 'sparse', 'merge'] as const) {
      const root = repository(); write(root, 'file', 'base\n'); commit(root); write(root, 'file', 'changed\n'); write(root, 'new', 'new\n');
      const identity = await reader.resolveRepository(root), overview = await reader.readOverview(identity);
      if (situation === 'assume') git(root, ['update-index', '--assume-unchanged', '--', 'file']);
      if (situation === 'intent') git(root, ['add', '--intent-to-add', '--', 'new']);
      if (situation === 'split') git(root, ['update-index', '--split-index']);
      if (situation === 'sparse') git(root, ['config', 'core.sparseCheckout', 'true']);
      if (situation === 'merge') write(root, '.git/MERGE_HEAD', git(root, ['rev-parse', 'HEAD']));
      const before = fingerprint(root);
      await expect(writer.prepare(identity, 'stage-files', overview.changes.unstaged, overview.fingerprint)).rejects.toMatchObject({ code: 'UNSUPPORTED_REPOSITORY' });
      expect(fingerprint(root)).toBe(before);
    }
  });

  it('allows unused configured filters and restores HEAD despite built-in converting attrs', async () => {
    const root = repository(); write(root, 'file', 'base\n'); commit(root); write(root, 'file', 'changed\n');
    git(root, ['config', 'filter.unused.process', 'never-run-unused-filter']);
    await execute(await prepare(root, 'stage-files', ['file']));
    write(root, '.gitattributes', 'file text eol=lf ident\n');
    const before = worktree(root);
    await execute(await prepare(root, 'unstage-files', ['file']));
    expect(git(root, ['show', ':file'])).toBe('base'); expect(worktree(root)).toEqual(before);
  });

  it('bounds file hashing while supporting built-in line-ending conversion', async () => {
    const root = repository(); write(root, 'file', 'base\n'); commit(root); write(root, 'file', 'changed\n');
    git(root, ['config', 'core.autocrlf', 'input']);
    await execute(await prepare(root, 'stage-files'));
    expect(git(root, ['show', ':file'])).toBe('changed');
    git(root, ['config', 'core.autocrlf', 'false']);
    truncateSync(path.join(root, 'file'), 64 * 1024 * 1024 + 1);
    const before = index(root);
    await expect(prepare(root, 'stage-files')).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    expect(index(root)).toEqual(before);
  });

  it('verifies receipts when selected attribute files change cached attributes', async () => {
    const root = repository(); write(root, 'file', 'base\n'); commit(root);
    write(root, '.gitattributes', '* -text\n'); write(root, 'file', 'changed\n');
    await execute(await prepare(root, 'stage-files'));
    expect(git(root, ['show', ':file'])).toBe('changed');
    await execute(await prepare(root, 'unstage-files'));
    expect(git(root, ['show', ':file'])).toBe('base');
  });

  it('uses a linked worktree index and supports sha256 unborn deletion records', async () => {
    const main = repository(); write(main, 'file', 'main\n'); commit(main);
    const linked = path.join(temporaryDirectory(), 'linked'); git(main, ['worktree', 'add', '-b', 'other', linked]);
    write(linked, 'file', 'linked\n');
    const mainIndex = index(main);
    await execute(await prepare(linked, 'stage-files'));
    expect(git(linked, ['show', ':file'])).toBe('linked'); expect(index(main)).toEqual(mainIndex);
    const sha256 = temporaryDirectory(); git(sha256, ['init', '-b', 'main', '--object-format=sha256']); write(sha256, 'file', 'sha256\n');
    await execute(await prepare(sha256, 'stage-files'));
    expect(git(sha256, ['rev-parse', ':file'])).toHaveLength(64);
    await execute(await prepare(sha256, 'unstage-files'));
    expect(git(sha256, ['ls-files'])).toBe('');
  });

  it('ignores inherited GIT selectors/config injection and rejects stale selections', async () => {
    const root = repository(), other = repository(); write(root, 'file', 'base\n'); commit(root); write(root, 'file', 'changed\n');
    const previous = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE, count: process.env.GIT_CONFIG_COUNT };
    const otherBefore = fingerprint(other);
    try {
      process.env.GIT_DIR = path.join(other, '.git'); process.env.GIT_INDEX_FILE = path.join(other, 'index'); process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath'; process.env.GIT_CONFIG_VALUE_0 = '/unexpected-hooks';
      await execute(await prepare(root, 'stage-files'));
      expect(fingerprint(other)).toBe(otherBefore);
    } finally {
      for (const [key, value] of [['GIT_DIR', previous.dir], ['GIT_INDEX_FILE', previous.index], ['GIT_CONFIG_COUNT', previous.count]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      delete process.env.GIT_CONFIG_KEY_0; delete process.env.GIT_CONFIG_VALUE_0;
    }
    const identity = await reader.resolveRepository(root), overview = await reader.readOverview(identity);
    await expect(writer.prepare(identity, 'stage-files', overview.changes.staged, overview.fingerprint)).rejects.toMatchObject({ code: 'STALE_RESULT' });
  });
});
