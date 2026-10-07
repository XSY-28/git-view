import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { createGitAdapter } from '@git-view/git-cli';
import type { RepositoryIdentity } from '@git-view/contracts';
import { runGit } from '../../../packages/git-cli/src/runner';

const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

/** A watch event is only a hint. Observe mutable Git state and Git-visible paths
 * before invalidating the UI; root directory times and object-cache maintenance
 * do not describe changes to the user's repository view. */
export async function watchFingerprint(repository: RepositoryIdentity, signal: AbortSignal): Promise<string> {
  const values: string[] = [];
  const gitDirectories = new Set<string>();
  async function gitState(directory: string) {
    if (gitDirectories.has(directory)) return;
    gitDirectories.add(directory);
    async function visit(file: string, root = false): Promise<void> {
      signal.throwIfAborted();
      const key = `git:${file}`;
      try {
        const info = await lstat(file);
        if (info.isSymbolicLink()) values.push(`${key}:link:${await readlink(file)}`);
        else if (info.isDirectory()) {
          for (const name of (await readdir(file)).sort()) {
            // Objects are immutable; adding/repacking them does not change refs.
            // Tracked submodules are observed through their own resolved Git dirs.
            if (root && (name === 'objects' || name === 'modules')) continue;
            await visit(path.join(file, name));
          }
        } else if (info.isFile()) {
          const digest = createHash('sha256');
          for await (const chunk of createReadStream(file, { signal })) digest.update(chunk);
          values.push(`${key}:${info.mode & 0o111}:${digest.digest('hex')}`);
        } else values.push(`${key}:${info.mode}`);
      } catch (error) { if (missing(error)) values.push(`${key}:missing`); else throw error; }
    }
    await visit(directory, true);
    // Alternates can change object availability without moving a ref.
    await visit(path.join(directory, 'objects/info/alternates'));
  }
  await gitState(repository.gitDir);
  await gitState(repository.commonGitDir);

  // ls-files honours this repository's actual ignore rules, including tracked
  // files inside ignored directories. It never runs clean/process filters.
  const names = await runGit(repository.worktreeRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { signal });
  const files = new Map<string, Buffer>();
  const policyDirectories = new Map<string, Buffer>([['', Buffer.alloc(0)]]);
  let start = 0;
  for (let index = 0; index < names.length; index++) if (names[index] === 0) {
    const name = names.subarray(start, index); start = index + 1;
    if (name.length) {
      files.set(name.toString('base64'), name);
      let end = name.lastIndexOf(47);
      while (end >= 0) {
        const parent = name.subarray(0, end); policyDirectories.set(parent.toString('base64'), parent);
        end = parent.lastIndexOf(47);
      }
    }
  }
  // Ignore/attribute policy still affects tracked files when the policy file
  // itself is ignored. Keep those paths observable without scanning ignored trees.
  for (const directory of policyDirectories.values()) for (const policy of ['.gitignore', '.gitattributes']) {
    const name = Buffer.concat([directory, Buffer.from(`${directory.length ? '/' : ''}${policy}`)]);
    files.set(name.toString('base64'), name);
  }
  const entries = [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (let index = 0; index < entries.length; index += 32) {
    const batch = await Promise.all(entries.slice(index, index + 32).map(async ([key, name]) => {
      signal.throwIfAborted();
      const file = Buffer.concat([Buffer.from(`${repository.worktreeRoot}${path.sep}`), name]);
      try {
        const info = await lstat(file, { bigint: true });
        if (info.isDirectory()) {
          // A gitlink's worktree can contain ignored build output. Its HEAD and
          // refs, rather than the directory clock, determine its Git state.
          try {
            await lstat(Buffer.concat([file, Buffer.from(`${path.sep}.git`)]));
            const submodule = await createGitAdapter().resolveRepository(file.toString('utf8'), signal);
            await gitState(submodule.gitDir); await gitState(submodule.commonGitDir);
          } catch (error) { if (!missing(error)) throw error; }
          return `${key}:directory:${info.mode}:${info.ino}`;
        }
        return `${key}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`;
      } catch (error) { if (missing(error)) return `${key}:missing`; throw error; }
    }));
    values.push(...batch);
  }
  return createHash('sha256').update(values.sort().join('\0')).digest('hex');
}
