import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { revisionEndpointSchema, type RepositoryIdentity, type RevisionEndpoint, type ChangeEntry, type CommitNode } from '@git-view/contracts';
import { hash, parseRawDiff, splitNul, utf8 } from './parse.js';
import { GitReadError, runGit, type RunOptions } from './runner.js';
import { createBlobVerifier, diffFlags, rawFlags, requireEntry, renderPreview } from './diff.js';
import type { ReadLimits } from './limits.js';

export const fullOid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
async function optionalRead(file: string) {
  try { return await readFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0); throw error; }
}

/** Stored objects and ancestry boundaries shared by comparison and investigation. */
export function createImmutableReader(limits: ReadLimits, rejectPromisor: (root: string, gitDir: string, signal?: AbortSignal) => Promise<void>) {
  const run = (repo: RepositoryIdentity, args: string[], options: RunOptions = {}) => runGit(repo.worktreeRoot, args, { timeoutMs: limits.timeoutMs, maxOutputBytes: limits.maxOutputBytes, stderrPreviewChars: limits.stderrPreviewChars, ...options, noReplaceObjects: true });
  const verifyBlobs = createBlobVerifier(run);
  async function historyState(repo: RepositoryIdentity) {
    const shallow = await optionalRead(path.join(repo.commonGitDir, 'shallow'));
    if ((await optionalRead(path.join(repo.commonGitDir, 'info/grafts'))).toString('utf8').split('\n').some(line => line.trim() && !line.trim().startsWith('#'))) throw new GitReadError('UNSUPPORTED_REPOSITORY', '仓库使用 grafts 改写历史，无法可靠比较固定提交。');
    return { key: hash(shallow), shallow: new Set(shallow.toString('ascii').trim().split('\n').filter(Boolean)) };
  }
  async function validateRef(repo: RepositoryIdentity, name: string, signal?: AbortSignal) {
    const normalized = await run(repo, ['check-ref-format', '--normalize', name], { signal, allowedExitCodes: [0, 1] });
    if (normalized.toString('utf8').trim() !== name) throw new GitReadError('INVALID_REQUEST', '比较端点无效，请选择 HEAD、完整引用或提交 ID。');
  }
  async function resolve(repo: RepositoryIdentity, selector: RevisionEndpoint, signal?: AbortSignal) {
    if (!revisionEndpointSchema.safeParse(selector).success) throw new GitReadError('INVALID_REQUEST', '比较端点无效，请选择 HEAD、完整引用或提交 ID。');
    const value = selector.kind === 'head' ? 'HEAD' : selector.kind === 'ref' ? selector.name : selector.oid;
    if (selector.kind === 'commit') {
      const candidates = (await run(repo, ['rev-parse', `--disambiguate=${selector.oid.toLowerCase()}`], { signal })).toString('ascii').trim().split('\n').filter(Boolean);
      if (candidates.length !== 1) throw new GitReadError('OBJECT_UNAVAILABLE', '提交 ID 不存在或前缀不唯一，请提供更完整的提交 ID。');
      const oid = candidates[0]!;
      if ((await run(repo, ['cat-file', '-t', oid], { signal })).toString('ascii').trim() !== 'commit') throw new GitReadError('OBJECT_UNAVAILABLE', '提交 ID 指向的对象不是提交。');
      return { selector, label: value, oid };
    }
    if (selector.kind === 'ref') await validateRef(repo, selector.name, signal);
    const oid = (await run(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${value}^{commit}`], { signal, allowedExitCodes: [0, 1] })).toString('ascii').trim();
    if (!fullOid.test(oid)) throw new GitReadError('OBJECT_UNAVAILABLE', '比较端点无法解析为本机提交，请检查引用或提交 ID。');
    return { selector, label: value, oid };
  }
  async function assertHistory(repo: RepositoryIdentity, snapshot: { worktreeId: string; historyKey: string }, signal?: AbortSignal) {
    if (snapshot.worktreeId !== repo.worktreeId) throw new GitReadError('STALE_RESULT', '观测属于其他工作区，请重新读取。', true);
    await rejectPromisor(repo.worktreeRoot, repo.commonGitDir, signal);
    if ((await historyState(repo)).key !== snapshot.historyKey) throw new GitReadError('STALE_RESULT', '本机历史边界已经变化，请重新比较。', true);
  }
  async function trees(repo: RepositoryIdentity, base: string | null, target: string, signal?: AbortSignal) {
    const changes = parseRawDiff(await run(repo, ['diff-tree', '--no-commit-id', '-r', ...rawFlags, ...(base ? [base, target] : ['--root', target]), '--'], { signal }), 'revision-pair');
    return { base, target, changes };
  }
  async function treeChange(repo: RepositoryIdentity, tree: { base: string | null; target: string; changes: ChangeEntry[] }, entry: ChangeEntry, signal?: AbortSignal) {
    const current = tree.changes.find(item => item.id === entry.id);
    if (!current) throw new GitReadError('INVALID_REQUEST', '该文件不属于选择的比较基准。');
    const paths = requireEntry(current);
    await verifyBlobs(repo, [...(tree.base ? [tree.base] : []), tree.target], paths, false, signal);
    const bytes = await run(repo, ['diff-tree', '--no-commit-id', '-r', '-p', ...diffFlags, '--find-renames', ...(tree.base ? [tree.base, tree.target] : ['--root', tree.target]), '--', ...paths], { signal });
    return renderPreview(current, bytes, tree.base ?? '空树（首次提交）', tree.target, limits);
  }
  async function commitNode(repo: RepositoryIdentity, oid: string, signal?: AbortSignal): Promise<CommitNode> {
    if (!fullOid.test(oid)) throw new GitReadError('INVALID_REQUEST', '提交 ID 无效。');
    const records = splitNul(await run(repo, ['log', '-z', '-1', '--no-walk', '--format=%H%x00%P%x00%an%x00%aI%x00%s', oid, '--'], { signal }));
    if (records.length !== 5) throw new GitReadError('OBJECT_UNAVAILABLE', '提交元数据记录不完整。');
    let values: string[];
    try { values = records.map(value => utf8.decode(value)); } catch { throw new GitReadError('OBJECT_UNAVAILABLE', '提交元数据不是有效的 UTF-8，暂不能展示。'); }
    const [actual, parents, author, authoredAt, subject] = values;
    const boundary = (await historyState(repo)).shallow.has(oid);
    const storedParents = boundary ? (await run(repo, ['cat-file', 'commit', oid], { signal })).toString('utf8').split('\n\n')[0]!.split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7)) : parents!.split(' ').filter(Boolean);
    return { oid: actual!, parents: storedParents, author: author!, authoredAt: authoredAt!, subject: subject!, refs: [], boundary };
  }
  return { run, historyState, validateRef, resolve, assertHistory, trees, treeChange, commitNode, verifyBlobs };
}
