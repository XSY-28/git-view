import { randomUUID } from 'node:crypto';
import { COMPARISON_LIMITS, comparisonOptionsSchema, type ComparisonOptions, type ComparisonPageOptions, type ComparisonMode, type ComparisonCommits, type RevisionComparison, type RepositoryIdentity, type ChangeEntry, type CommitNode } from '@git-view/contracts';
import { GitReadError } from './runner.js';
import { createImmutableReader } from './immutable.js';
import { splitNul, utf8 } from './parse.js';
import type { ReadLimits } from './limits.js';

type Page = { comparisonId: string; worktreeId: string; side: ComparisonPageOptions['side']; historyKey: string; offset: number };
/** Snapshot only stored objects. Mutable refs are resolved once, never used for pages or file reads. */
export function createComparisonReader(limits: ReadLimits, rejectPromisor: (root: string, gitDir: string, signal?: AbortSignal) => Promise<void>) {
  const cursors = new Map<string, Page>();
  const { run, historyState, resolve, trees: readTrees, treeChange } = createImmutableReader(limits, rejectPromisor);
  async function assertSnapshot(repo: RepositoryIdentity, comparison: RevisionComparison, signal?: AbortSignal) {
    if (comparison.worktreeId !== repo.worktreeId) throw new GitReadError('STALE_RESULT', '比较结果属于其他工作区，请重新比较。', true);
    await rejectPromisor(repo.worktreeRoot, repo.commonGitDir, signal);
    if ((await historyState(repo)).key !== comparison.historyKey) throw new GitReadError('STALE_RESULT', '本机历史边界已经变化，请重新比较。', true);
  }
  const trees = async (repo: RepositoryIdentity, base: string, target: string, signal?: AbortSignal) => ({ ...await readTrees(repo, base, target, signal), base });
  async function compareRevisions(repo: RepositoryIdentity, options: ComparisonOptions, signal?: AbortSignal): Promise<RevisionComparison> {
    if (!comparisonOptionsSchema.safeParse(options).success) throw new GitReadError('INVALID_REQUEST', '比较端点无效，请选择 HEAD、完整引用或提交 ID。');
    await rejectPromisor(repo.worktreeRoot, repo.commonGitDir, signal);
    const history = await historyState(repo);
    const a = await resolve(repo, options.a, signal);
    const b = await resolve(repo, options.b, signal);
    const bases = (await run(repo, ['merge-base', '--all', a.oid, b.oid], { signal, allowedExitCodes: [0, 1] })).toString('ascii').trim().split('\n').filter(Boolean);
    const counts = (await run(repo, ['rev-list', '--left-right', '--count', `${a.oid}...${b.oid}`, '--'], { signal })).toString('ascii').trim().split(/\s+/).map(Number);
    if (counts.length !== 2 || counts.some(n => !Number.isSafeInteger(n) || n < 0)) throw new GitReadError('INTERNAL_ERROR', '独有提交数量记录不完整。');
    const incomplete = history.shallow.size > 0;
    const mergeBases: RevisionComparison['mergeBases'] = incomplete
      ? { status: 'incomplete', oids: bases, reason: '浅历史不完整，无法确定完整历史中的共同祖先。' }
      : bases.length === 1 ? { status: 'unique', oids: bases }
        : bases.length > 1 ? { status: 'multiple', oids: bases, reason: '存在多个共同祖先，未任意选择比较基准。' }
          : { status: 'none', oids: [], reason: '两个端点没有共同祖先。' };
    const endpoints = await trees(repo, a.oid, b.oid, signal);
    const fromMergeBase = mergeBases.status === 'unique' ? await trees(repo, bases[0]!, b.oid, signal) : undefined;
    const replaced = (await run(repo, ['for-each-ref', '--format=%(refname)', 'refs/replace/'], { signal })).length > 0;
    const result: RevisionComparison = {
      comparisonId: randomUUID(), worktreeId: repo.worktreeId, observedAt: new Date().toISOString(), historyKey: history.key, a, b, mergeBases,
      exclusive: { a: counts[0]!, b: counts[1]!, complete: !incomplete }, endpoints, ...(fromMergeBase ? { fromMergeBase } : {}),
      warnings: [...(incomplete ? ['独有提交仅统计本机可见历史，数量可能不完整。'] : []), ...(replaced ? ['比较使用原始 Git 对象，未应用 refs/replace 历史替换。'] : [])],
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > COMPARISON_LIMITS.snapshotBytes) throw new GitReadError('OUTPUT_LIMIT', '比较文件清单超过安全上限，未返回不完整结果。');
    // Endpoint resolution is multi-command: reject a mixed observation on a moving ref.
    if ((await resolve(repo, options.a, signal)).oid !== a.oid || (await resolve(repo, options.b, signal)).oid !== b.oid) throw new GitReadError('STALE_RESULT', '比较端点在读取期间变化，请重新比较。', true);
    await assertSnapshot(repo, result, signal);
    return result;
  }
  async function listComparisonCommits(repo: RepositoryIdentity, comparison: RevisionComparison, options: ComparisonPageOptions, signal?: AbortSignal): Promise<ComparisonCommits> {
    await assertSnapshot(repo, comparison, signal);
    if (options.side !== 'a' && options.side !== 'b') throw new GitReadError('INVALID_REQUEST', '比较方向无效。');
    const page = options.cursor ? cursors.get(options.cursor) : { comparisonId: comparison.comparisonId, worktreeId: repo.worktreeId, side: options.side, historyKey: comparison.historyKey, offset: 0 };
    if (!page || page.comparisonId !== comparison.comparisonId || page.worktreeId !== repo.worktreeId || page.side !== options.side || page.historyKey !== comparison.historyKey) throw new GitReadError('STALE_RESULT', '比较分页属于其他比较、方向或工作区，请重新比较。', true);
    const included = comparison[options.side].oid;
    const excluded = comparison[options.side === 'a' ? 'b' : 'a'].oid;
    const records = splitNul(await run(repo, ['log', '-z', '--topo-order', `--max-count=${limits.historyPageSize + 1}`, `--skip=${page.offset}`, '--format=%H%x00%P%x00%an%x00%aI%x00%s', included, `^${excluded}`, '--'], { signal }));
    if (records.length % 5) throw new GitReadError('INTERNAL_ERROR', '独有提交历史记录不完整。');
    const shallow = (await historyState(repo)).shallow;
    const commits: CommitNode[] = [];
    for (let i = 0; i < Math.min(records.length, limits.historyPageSize * 5); i += 5) {
      let fields: string[];
      try { fields = records.slice(i, i + 5).map(item => utf8.decode(item)); } catch { throw new GitReadError('OBJECT_UNAVAILABLE', '提交元数据不是有效的 UTF-8，暂不能展示。'); }
      const [oid, parents, author, authoredAt, subject] = fields;
      const node: CommitNode = { oid: oid!, parents: parents!.split(' ').filter(Boolean), author: author!, authoredAt: authoredAt!, subject: subject!, refs: [], boundary: shallow.has(oid!) };
      if (node.boundary) {
        const stored = (await run(repo, ['cat-file', 'commit', node.oid], { signal })).toString('utf8').split('\n\n')[0]!;
        node.parents = stored.split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7));
      }
      commits.push(node);
    }
    await assertSnapshot(repo, comparison, signal);
    let nextCursor: string | undefined;
    if (records.length > limits.historyPageSize * 5) {
      nextCursor = randomUUID(); cursors.set(nextCursor, { ...page, offset: page.offset + commits.length });
      if (cursors.size > limits.historyCursorCount) cursors.delete(cursors.keys().next().value!);
    }
    return { comparisonId: comparison.comparisonId, side: options.side, commits, ...(nextCursor ? { nextCursor } : {}), complete: comparison.exclusive.complete };
  }
  async function readComparisonChange(repo: RepositoryIdentity, comparison: RevisionComparison, mode: ComparisonMode, entry: ChangeEntry, signal?: AbortSignal) {
    await assertSnapshot(repo, comparison, signal);
    const tree = mode === 'endpoints' ? comparison.endpoints : mode === 'merge-base' ? comparison.fromMergeBase : undefined;
    const current = tree?.changes.find(item => item.id === entry.id);
    if (!tree || !current) throw new GitReadError('STALE_RESULT', '文件不属于此比较基准，请重新选择。', true);
    const result = await treeChange(repo, tree, current, signal);
    await assertSnapshot(repo, comparison, signal);
    return result;
  }
  return { compareRevisions, listComparisonCommits, readComparisonChange };
}
