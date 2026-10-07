import { afterEach, expect, it } from 'vitest';
import { chmodSync, existsSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createGitAdapter } from '@git-view/git-cli';
import { RepositoryWatchers } from '../../apps/local/src/watch';
import { cleanupFixtures, commit, fingerprint, fixtureGit, repository, temporaryDirectory, write } from '../fixtures/git';

const watchers = new RepositoryWatchers();
afterEach(async () => { watchers.close(); await cleanupFixtures(); });

async function open(root: string) {
  const identity = await createGitAdapter().resolveRepository(root);
  const initial = await watchers.state(identity);
  expect(initial.watching).toBe(true);
  // Establish the native event stream before making negative assertions.
  let probe = 0;
  await expect.poll(async () => {
    write(root, 'watch-ready', String(probe++));
    return (await watchers.state(identity)).revision;
  }, { timeout: 5000 }).toBeGreaterThan(initial.revision);
  await delay(400);
  const ready = await watchers.state(identity);
  return { identity, revision: ready.revision };
}

it('keeps the revision stable during ignored writes and Git object metadata maintenance', async () => {
  const root = repository();
  write(root, '.gitignore', 'cache/\n');
  write(root, 'file.txt', 'base\n');
  commit(root);
  const { identity, revision } = await open(root);
  const objects = path.join(root, '.git/objects');
  const object = readdirSync(objects).filter(name => /^[0-9a-f]{2}$/.test(name))[0]!;
  const blob = path.join(objects, object, readdirSync(path.join(objects, object))[0]!);
  for (let iteration = 0; iteration < 4; iteration++) {
    // Mirrors the captured native events: unchanged object bytes/mtime, plus an
    // ignored cache directory's metadata and files changing in the background.
    chmodSync(blob, statSync(blob).mode);
    write(root, 'cache/run.txt', String(iteration));
    await delay(400);
    expect((await watchers.state(identity)).revision).toBe(revision);
  }
});

it('still invalidates same-size edits, tracked ignored paths and deletions', async () => {
  const root = repository();
  write(root, '.gitignore', 'cache/\n');
  write(root, 'cache/tracked.txt', 'one\n');
  fixtureGit(root, ['add', '--force', '--', 'cache/tracked.txt']);
  write(root, 'file.txt', 'one\n');
  commit(root);
  const { identity, revision } = await open(root);
  const previous = statSync(path.join(root, 'file.txt'));
  write(root, 'file.txt', 'two\n');
  utimesSync(path.join(root, 'file.txt'), previous.atime, previous.mtime);
  await expect.poll(async () => (await watchers.state(identity)).revision, { timeout: 5000 }).toBeGreaterThan(revision);
  const edited = (await watchers.state(identity)).revision;
  write(root, 'cache/tracked.txt', 'two\n');
  await expect.poll(async () => (await watchers.state(identity)).revision, { timeout: 5000 }).toBeGreaterThan(edited);
  const tracked = (await watchers.state(identity)).revision;
  rmSync(path.join(root, 'cache'), { recursive: true });
  await expect.poll(async () => (await watchers.state(identity)).revision, { timeout: 5000 }).toBeGreaterThan(tracked);
});

it('invalidates refs and reflog-only changes while retaining shared worktree monitoring', async () => {
  const root = repository();
  write(root, 'file.txt', 'base\n');
  const first = commit(root);
  write(root, 'file.txt', 'second\n');
  commit(root);
  const { identity, revision } = await open(root);
  fixtureGit(root, ['branch', 'side', first]);
  await expect.poll(async () => (await watchers.state(identity)).revision, { timeout: 5000 }).toBeGreaterThan(revision);
  const branch = (await watchers.state(identity)).revision;
  fixtureGit(root, ['reflog', 'expire', '--expire=all', '--all']);
  await expect.poll(async () => (await watchers.state(identity)).revision, { timeout: 5000 }).toBeGreaterThan(branch);
  const linked = path.join(root, 'cache-worktree');
  fixtureGit(root, ['worktree', 'add', '--detach', linked, first]);
  const linkedIdentity = await createGitAdapter().resolveRepository(linked);
  const before = await watchers.state(linkedIdentity);
  fixtureGit(root, ['branch', 'another', first]);
  await expect.poll(async () => (await watchers.state(linkedIdentity)).revision, { timeout: 5000 }).toBeGreaterThan(before.revision);
});

it('observes ignored Git policy files without executing configured filters', async () => {
  const root = repository();
  write(root, '.gitignore', 'policy/.gitattributes\n');
  write(root, 'policy/file.txt', 'base\n');
  commit(root);
  fixtureGit(root, ['config', 'filter.probe.clean', 'touch filter-ran']);
  const { identity, revision } = await open(root);
  write(root, 'policy/.gitattributes', '*.txt filter=probe\n');
  const before = fingerprint(root);
  await expect.poll(async () => (await watchers.state(identity)).revision, { timeout: 5000 }).toBeGreaterThan(revision);
  expect(existsSync(path.join(root, 'filter-ran'))).toBe(false);
  expect(fingerprint(root)).toBe(before);
});

it('observes submodule HEAD changes without invalidating for ignored submodule output', async () => {
  const source = repository();
  write(source, '.gitignore', 'cache/\n');
  write(source, 'file.txt', 'base\n');
  const first = commit(source);
  write(source, 'file.txt', 'later\n');
  commit(source);
  const root = repository();
  fixtureGit(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'module']);
  commit(root);
  const { identity, revision } = await open(root);
  write(root, 'module/cache/output', 'ignored output\n');
  await delay(600);
  expect((await watchers.state(identity)).revision).toBe(revision);
  fixtureGit(path.join(root, 'module'), ['checkout', '--detach', first]);
  await expect.poll(async () => (await watchers.state(identity)).revision, { timeout: 5000 }).toBeGreaterThan(revision);
});

it('reports observation failure when the repository is removed', async () => {
  const root = repository();
  write(root, 'file.txt', 'base\n');
  commit(root);
  const { identity } = await open(root);
  rmSync(root, { recursive: true });
  await expect.poll(async () => (await watchers.state(identity)).watching, { timeout: 5000 }).toBe(false);
});

// Hold only the first scan at its real Git subprocess boundary, so a change
// observed during baseline establishment cannot disappear into that baseline.
(process.platform === 'win32' ? it.skip : it)('retains invalidation observed during the initial scan', async () => {
  const root = repository(); write(root, 'file.txt', 'base\n'); commit(root);
  const identity = await createGitAdapter().resolveRepository(root);
  const proxy = temporaryDirectory(); const once = path.join(proxy, 'once');
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
  writeFileSync(path.join(proxy, 'git'), `#!/bin/sh
/usr/bin/git "$@"
result=$?
case " $* " in
  *" ls-files "*)
    if [ ! -f ${quote(once)} ]; then
      printf 'during baseline\\n' > ${quote(path.join(root, 'file.txt'))}
      touch ${quote(once)}
      sleep 1
    fi
    ;;
esac
exit "$result"
`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${proxy}:${originalPath ?? ''}`;
  let initial;
  try { initial = await watchers.state(identity); }
  finally { process.env.PATH = originalPath; }
  expect(initial.watching).toBe(true);
  await expect.poll(async () => (await watchers.state(identity)).revision, { timeout: 5000 }).toBeGreaterThan(initial.revision);
});
