import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { QueryError, type RepositoryIdentity } from '@git-view/contracts';
import { runGit } from '../../git-cli/src/runner.js';
import { optional, readWriteState, parseEntries, type IndexEntry } from './index.js';

export const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const entriesHash = (entries: IndexEntry[]) => hash(JSON.stringify([...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))));
export const query = (repository: RepositoryIdentity, args: string[], signal?: AbortSignal) => runGit(repository.worktreeRoot, args, { signal });
export async function headRef(repository: RepositoryIdentity) {
  return (await runGit(repository.worktreeRoot, ['symbolic-ref', '-q', 'HEAD'], { allowedExitCodes: [0, 1] })).toString().trim() || null;
}
export async function resolveBranch(repository: RepositoryIdentity, branch: string) {
  await validateBranch(repository, branch);
  const output = await runGit(repository.worktreeRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowedExitCodes: [0, 1] });
  return output.toString().trim() || null;
}
export async function validateBranch(repository: RepositoryIdentity, branch: string) {
  if (!branch || branch === 'HEAD' || branch.startsWith('-') || branch !== branch.trim() || branch.includes('\0')) throw new QueryError('INVALID_REQUEST', '分支名称无效。');
  try { await query(repository, ['check-ref-format', `refs/heads/${branch}`]); }
  catch { throw new QueryError('INVALID_REQUEST', '分支名称不符合 Git 命名规则。'); }
}
export async function assertNoIndexLock(repository: RepositoryIdentity) {
  try { await lstat(path.join(repository.gitDir, 'index.lock')); throw new QueryError('REPOSITORY_BUSY', 'index.lock 已存在，请等待外部 Git 操作结束。'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export async function repositoryState(repository: RepositoryIdentity, signal?: AbortSignal) {
  const state = await readWriteState(repository, [], 'unstage-files', signal);
  await assertNoIndexLock(repository);
  const ref = await headRef(repository);
  const hookHashes: string[] = [];
  for (const hook of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-checkout', 'post-index-change', 'reference-transaction']) {
    const location = (await query(repository, ['rev-parse', '--git-path', `hooks/${hook}`], signal)).toString().trim();
    const bytes = await optional(path.resolve(repository.worktreeRoot, location), 1024 * 1024);
    hookHashes.push(`${location}:${bytes ? hash(bytes) : 'absent'}`);
  }
  const config = await query(repository, ['config', '--null', '--list', '--show-origin', '--includes'], signal);
  return { headOid: state.headOid, headRef: ref, indexEntriesHash: entriesHash(state.indexEntries), guard: hash(JSON.stringify([state.guard, state.indexHash, ref, hookHashes, config.toString('base64')])) };
}
export async function targetTree(repository: RepositoryIdentity, oid: string) {
  return parseEntries(await query(repository, ['ls-tree', '-r', '-z', '--full-tree', oid]), true);
}
export async function checkTargetAttributes(repository: RepositoryIdentity, oid: string) {
  const entries = await targetTree(repository, oid);
  if (!entries.length) return;
  // --source reads .gitattributes from the target tree, including files absent in
  // the current checkout. Worktree/info and global attributes remain in effect.
  const attrs = await runGit(repository.worktreeRoot, ['check-attr', `--source=${oid}`, '-z', '--stdin', 'filter'], { input: Buffer.from(entries.map(entry => entry.path).join('\0') + '\0') });
  const parts = attrs.toString('utf8').split('\0');
  for (let i = 2; i < parts.length; i += 3) if (!['unspecified', 'unset'].includes(parts[i]!)) throw new QueryError('UNSUPPORTED_FILTER', '目标分支包含 filter 属性；未运行目标版本的 smudge/process 过滤器。');
}
