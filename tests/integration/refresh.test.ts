import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createGitAdapter } from '../../packages/git-cli/src/index.js';
import { cleanupFixtures, commit, fixtureGit as git, repository, temporaryDirectory, write } from '../fixtures/git.js';

afterAll(cleanupFixtures);
// These tests deliberately interpose a POSIX executable at the Git boundary.
// The remaining real-repository refresh checks run on every platform.
const unixIt = process.platform === 'win32' ? it.skip : it;

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** The proxy runs real Git first, then changes only this newly-created fixture.
 * It makes the race repeatable at the exact status-to-post-observation boundary.
 */
async function afterStatus<T>(root: string, mutation: string, everyRead: boolean, read: () => Promise<T>): Promise<{ result: T; reads: number }> {
  const proxy = temporaryDirectory();
  const countFile = path.join(proxy, 'reads');
  const script = `#!/bin/sh
case " $* " in
  *" status "*)
    /usr/bin/git "$@"
    result=$?
    if [ "$result" -ne 0 ]; then exit "$result"; fi
    count=0
    if [ -f ${shellQuote(countFile)} ]; then read count < ${shellQuote(countFile)}; fi
    count=$((count + 1))
    echo "$count" > ${shellQuote(countFile)}
    if ${everyRead ? 'true' : '[ "$count" -eq 1 ]'}; then
      ${mutation}
    fi
    exit "$result"
    ;;
esac
exec /usr/bin/git "$@"
`;
  writeFileSync(path.join(proxy, 'git'), script, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${proxy}:${originalPath ?? ''}`;
  try {
    const result = await read();
    return { result, reads: existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0 };
  } finally { process.env.PATH = originalPath; }
}

describe('overview observation consistency', () => {
  unixIt.each(['edit', 'stage', 'commit'] as const)('retries an external %s after status and returns the new complete observation', async change => {
    const root = repository();
    write(root, 'file', 'base\n');
    const oid = commit(root);
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(root);
    const mutation = `printf 'external\\n' > ${shellQuote(path.join(root, 'file'))}\n` +
      (change === 'stage' || change === 'commit' ? `/usr/bin/git -C ${shellQuote(root)} add -- file\n` : '') +
      (change === 'commit' ? `/usr/bin/git -C ${shellQuote(root)} -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=Fixture -c user.email=fixture@example.invalid commit -m external >/dev/null\n` : '');
    const { result: overview, reads } = await afterStatus(root, mutation, false, () => adapter.readOverview(identity));
    expect(reads).toBe(2);
    expect(overview.complete).toBe(true);
    if (change === 'edit') {
      expect(overview.changes.unstaged.map(entry => entry.path)).toEqual(['file']);
      expect(overview.changes.staged).toEqual([]);
    } else if (change === 'stage') {
      expect(overview.changes.staged.map(entry => entry.path)).toEqual(['file']);
      expect(overview.changes.unstaged).toEqual([]);
    } else {
      expect(overview.head.kind !== 'unborn' && overview.head.oid).not.toBe(oid);
      expect(overview.changes).toEqual({ staged: [], unstaged: [], untracked: [], conflicts: [] });
    }
  });

  unixIt('stops after the initial read plus two retries and never turns continuous writes into a clean result', async () => {
    const root = repository();
    write(root, 'file', 'base\n');
    commit(root);
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(root);
    const mutation = `echo "$count" > ${shellQuote(path.join(root, 'file'))}`;
    const { result, reads } = await afterStatus(root, mutation, true, async () => {
      try { return await adapter.readOverview(identity); }
      catch (error) { return error; }
    });
    expect(reads).toBe(3);
    expect(result).toMatchObject({ code: 'REPOSITORY_BUSY', retryable: true });
  });

  it('reports a locked index as busy, and a missing index as actual staged deletions rather than clean', async () => {
    const root = repository();
    write(root, 'file', 'base\n');
    commit(root);
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(root);
    write(root, '.git/index.lock', 'external writer');
    await expect(adapter.readOverview(identity)).rejects.toMatchObject({ code: 'REPOSITORY_BUSY' });
    rmSync(path.join(root, '.git/index.lock'));
    rmSync(path.join(root, '.git/index'));
    const missing = await adapter.readOverview(identity);
    expect(missing.changes.staged).toMatchObject([{ path: 'file', kind: 'D' }]);
    expect(missing.changes.untracked).toMatchObject([{ path: 'file' }]);
  });

  it('preserves unavailable-object errors instead of retrying them as empty status', async () => {
    const root = repository();
    write(root, 'file', 'base\n');
    commit(root);
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(root);
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
    rmSync(path.join(root, '.git/objects', tree.slice(0, 2), tree.slice(2)));
    await expect(adapter.readOverview(identity)).rejects.toMatchObject({ code: 'OBJECT_UNAVAILABLE' });
  });

  it('invalidates selected-file evidence after an external edit even when the pathname stays the same', async () => {
    const root = repository();
    write(root, 'file', 'base\n');
    commit(root);
    write(root, 'file', 'first\n');
    const adapter = createGitAdapter();
    const identity = await adapter.resolveRepository(root);
    const first = await adapter.readOverview(identity);
    write(root, 'file', 'later\n');
    await expect(adapter.readChange(identity, first.changes.unstaged[0]!, first.fingerprint)).rejects.toMatchObject({ code: 'STALE_RESULT' });
    const next = await adapter.readOverview(identity);
    expect((await adapter.readChange(identity, next.changes.unstaged[0]!, next.fingerprint)).text).toContain('+later');
  });
});
