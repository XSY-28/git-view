import { constants } from 'node:fs';
import { lstat, open, readFile, readlink, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChangeEntry, CommitDetail, CommitNode, Diff, GitAdapter, HeadState, History, HistoryOptions, HistoryOrder, RawOverview, RepositoryIdentity } from '@git-view/contracts';
import { GitReadError, runGit, type RunOptions } from './runner.js';
import { hash, parseRawDiff, parseStatus, splitNul, utf8 } from './parse.js';
import { historyFilterKey, historyRefSchema, historyOrderSchema, resolveHistoryOrder } from '@git-view/contracts';
import { createNavigationReader, readRefs } from './navigation.js';
import { readLimits, type ReadLimits } from './limits.js';
import { createBlobVerifier, diffFlags, rawFlags, requireEntry, renderPreview } from './diff.js';
import { createComparisonReader } from './comparison.js';
export { DEFAULT_READ_LIMITS, type ReadLimits } from './limits.js';

export { GitReadError } from './runner.js';
async function optionalRead(file: string): Promise<Buffer> {
  try { return await readFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0); throw error; }
}
async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function requireOid(oid: string) {
  if (!/^[0-9a-f]+$/i.test(oid) || oid.length > 128) throw new GitReadError('INVALID_REQUEST', '提交 ID 无效。');
}

interface PageState extends HistoryOptions { order: HistoryOrder; worktreeId: string; tips: string[]; refs: Map<string, string[]>; offset: number; headOid?: string; tipOid?: string }

export function createGitAdapter(options: { limits?: Partial<ReadLimits> } = {}): GitAdapter {
  const limits = readLimits(options.limits);
  const executeGit = (cwd: string, args: string[], options: RunOptions = {}) => runGit(cwd, args, { timeoutMs: limits.timeoutMs, maxOutputBytes: limits.maxOutputBytes, stderrPreviewChars: limits.stderrPreviewChars, ...options });
  const cursors = new Map<string, PageState>();
  const run = (repository: RepositoryIdentity, args: string[], signal?: AbortSignal) => executeGit(repository.worktreeRoot, args, { signal });

  async function rejectPromisor(root: string, commonGitDir: string, signal?: AbortSignal) {
    const config = await executeGit(root, ['config', '--null', '--get-regexp', '^(extensions\.partialclone|remote\..*\.promisor)$'], { signal, allowedExitCodes: [0, 1] });
    let packs: string[] = [];
    try { packs = await readdir(path.join(commonGitDir, 'objects/pack')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (config.length || packs.some((file) => file.endsWith('.promisor'))) throw new GitReadError('UNSUPPORTED_REPOSITORY', '首版暂不读取 partial clone / promisor 仓库，以确保缺失对象不会触发隐式联网。');
  }

  async function resolveRepository(input: string, signal?: AbortSignal): Promise<RepositoryIdentity> {
    let root: string;
    try { root = await realpath(input); } catch (error) { throw new GitReadError((error as NodeJS.ErrnoException).code === 'EACCES' ? 'PERMISSION_DENIED' : 'INVALID_REPOSITORY', '仓库路径不存在或无法访问。'); }
    if (!(await lstat(root)).isDirectory()) throw new GitReadError('INVALID_REPOSITORY', '请提供仓库目录。');
    const bare = (await executeGit(root, ['rev-parse', '--is-bare-repository'], { signal })).toString('utf8').trim();
    if (bare === 'true') throw new GitReadError('UNSUPPORTED_REPOSITORY', '首版仅支持有工作区的本地仓库，暂不支持裸仓库。');
    const values: string[] = [];
    for (const flag of ['--show-toplevel', '--absolute-git-dir', '--git-common-dir']) {
      const result = await executeGit(root, ['rev-parse', '--path-format=absolute', flag], { signal });
      try { values.push(utf8.decode(result).replace(/\n$/, '')); } catch { throw new GitReadError('UNSUPPORTED_PATH', '仓库根路径不是有效的 UTF-8，暂不支持。'); }
    }
    const [worktreeRoot, gitDir, commonGitDir] = await Promise.all(values.map((value) => realpath(value)));
    await rejectPromisor(worktreeRoot!, commonGitDir!, signal);
    return { repositoryId: hash(commonGitDir!), worktreeId: hash(gitDir!), worktreeRoot: worktreeRoot!, gitDir: gitDir!, commonGitDir: commonGitDir! };
  }

  async function readHead(repository: RepositoryIdentity, signal?: AbortSignal): Promise<HeadState> {
    const branch = (await executeGit(repository.worktreeRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { signal, allowedExitCodes: [0, 1] })).toString('utf8').trim();
    const oid = (await executeGit(repository.worktreeRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'], { signal, allowedExitCodes: [0, 1] })).toString('ascii').trim();
    if (branch) return oid ? { kind: 'branch', branch, oid } : { kind: 'unborn', branch };
    if (!oid) throw new GitReadError('OBJECT_UNAVAILABLE', 'HEAD 无法解析为提交。');
    return { kind: 'detached', oid };
  }

  async function operations(repository: RepositoryIdentity): Promise<string[]> {
    const states: [string, string][] = [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase/am'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect'], ['sequencer', 'sequencer']];
    const result: string[] = [];
    for (const [file, name] of states) if (await exists(path.join(repository.gitDir, file))) result.push(name);
    return result;
  }

  async function hasFilters(repository: RepositoryIdentity, signal?: AbortSignal): Promise<boolean> {
    const config = await executeGit(repository.worktreeRoot, ['config', '--null', '--get-regexp', '^filter\..*\.(clean|process)$'], { signal, allowedExitCodes: [0, 1] });
    const active = new Set<string>();
    for (const record of splitNul(config)) {
      const newline = record.indexOf(10);
      const key = record.subarray(0, newline).toString('utf8');
      if (record.subarray(newline + 1).toString('utf8').trim()) active.add(key.slice(7, key.lastIndexOf('.')));
    }
    if (!active.size) return false;
    // Listing names and reading attributes never runs content filters. Check both the
    // worktree and index attribute views conservatively before status can hash files.
    const files = await run(repository, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], signal);
    if (!files.length) return false;
    for (const cached of [false, true]) {
      const attrs = splitNul(await executeGit(repository.worktreeRoot, ['check-attr', '-z', ...(cached ? ['--cached'] : []), '--stdin', 'filter'], { signal, input: files }));
      if (attrs.length % 3) throw new GitReadError('UNSUPPORTED_FILTER', '无法可靠读取过滤器属性，未扫描工作区。');
      for (let i = 2; i < attrs.length; i += 3) if (active.has(attrs[i]!.toString('utf8'))) return true;
    }
    return false;
  }

  async function metadata(repository: RepositoryIdentity, signal?: AbortSignal): Promise<string> {
    const values: string[] = [];
    if (await exists(path.join(repository.gitDir, 'index.lock'))) throw new GitReadError('REPOSITORY_BUSY', 'index 正在被其他 Git 操作写入，请稍后刷新。', true);
    const head = await readHead(repository, signal);
    values.push(JSON.stringify(head));
    values.push(JSON.stringify(await operations(repository)));
    for (const file of ['index', 'HEAD', 'config.worktree', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) values.push(hash(await optionalRead(path.join(repository.gitDir, file))));
    values.push(hash(await optionalRead(path.join(repository.commonGitDir, 'config'))));
    values.push(hash(await optionalRead(path.join(repository.commonGitDir, 'info/attributes'))));
    values.push(hash(await optionalRead(path.join(repository.commonGitDir, 'info/exclude'))));
    values.push(hash(await optionalRead(path.join(repository.commonGitDir, 'shallow'))));
    return hash(values.join('\0'));
  }

  async function marker(repository: RepositoryIdentity, scanWorktree: boolean, signal?: AbortSignal): Promise<string> {
    const before = await metadata(repository, signal);
    const values: string[] = [before];
    if (scanWorktree) {
      const files = splitNul(await run(repository, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], signal));
      const names = new Map<string, Buffer>();
      names.set('', Buffer.alloc(0));
      for (const name of files) {
        names.set(name.toString('base64'), name);
        // Parent directory metadata also detects additions/removals between commands.
        let end = name.lastIndexOf(47);
        while (end >= 0) { const parent = name.subarray(0, end); names.set(parent.toString('base64'), parent); end = parent.lastIndexOf(47); }
      }
      const entries = [...names.entries()].sort(([a], [b]) => a.localeCompare(b));
      // Batches avoid opening thousands of filesystem requests simultaneously.
      for (let i = 0; i < entries.length; i += limits.metadataBatchSize) {
        const items = await Promise.all(entries.slice(i, i + limits.metadataBatchSize).map(async ([id, name]) => {
          if (signal?.aborted) throw new GitReadError('CANCELLED', '读取已取消。');
          const full = Buffer.concat([Buffer.from(`${repository.worktreeRoot}/`), name]);
          try { const info = await lstat(full, { bigint: true }); return `${id}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`; }
          catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return `${id}:missing`; throw error; }
        }));
        values.push(...items);
      }
    }
    // A marker itself spans several commands and filesystem batches. Do not accept
    // a mixed HEAD/index observation as a stable before/after fingerprint.
    if (before !== await metadata(repository, signal)) throw new GitReadError('STALE_RESULT', '仓库元数据在观测期间变化，正在重试。', true);
    return hash(values.join('\0'));
  }

  async function readOverview(repository: RepositoryIdentity, signal?: AbortSignal): Promise<RawOverview> {
    await rejectPromisor(repository.worktreeRoot, repository.commonGitDir, signal);
    for (let attempt = 0; attempt <= limits.consistencyRetries; attempt++) {
      try {
        const initialMetadata = await metadata(repository, signal);
        const filtered = await hasFilters(repository, signal);
        const before = await marker(repository, !filtered, signal);
        if (initialMetadata !== await metadata(repository, signal)) continue;
        const head = await readHead(repository, signal);
        const operation = await operations(repository);
        let changes: RawOverview['changes'];
        if (filtered) {
          const staged = parseRawDiff(await run(repository, ['diff', '--cached', ...rawFlags], signal), 'head-index');
          changes = { staged: staged.filter((item) => item.kind !== 'U'), unstaged: [], untracked: [], conflicts: staged.filter((item) => item.kind === 'U') };
        } else {
          changes = parseStatus(await run(repository, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=dirty', '--no-ahead-behind'], signal));
        }
        const filteredAfter = await hasFilters(repository, signal);
        const after = await marker(repository, !filtered, signal);
        if (before !== after || filtered !== filteredAfter) continue;
        const warnings = filtered ? ['UNSUPPORTED_FILTER：检测到路径使用外部 clean/process 过滤器；为确保不执行仓库程序，未扫描工作区及未跟踪文件，仅列出安全读取的暂存内容。此保守降级会同时跳过本仓库中未使用过滤器的工作文件。'] : [];
        if ([...changes.staged, ...changes.unstaged, ...changes.untracked, ...changes.conflicts].some((item) => !item.supported)) warnings.push('非 UTF-8 路径以字节转义名称显示，无法展开对应详情。');
        return { repository, head, operation, changes, complete: !filtered, warnings, fingerprint: after };
      } catch (error) {
        if (!(error instanceof GitReadError) || !['STALE_RESULT', 'REPOSITORY_BUSY'].includes(error.code)) throw error;
      }
    }
    throw new GitReadError('REPOSITORY_BUSY', '仓库在读取期间持续变化，请稍后刷新。', true);
  }

  async function previewUntracked(repository: RepositoryIdentity, entry: ChangeEntry): Promise<Diff> {
    const name = requireEntry(entry).at(-1)!;
    const full = path.join(repository.worktreeRoot, name);
    const parent = await realpath(path.dirname(full));
    if (parent !== repository.worktreeRoot && !parent.startsWith(`${repository.worktreeRoot}${path.sep}`)) throw new GitReadError('UNSUPPORTED_PATH', '路径通过符号链接指向仓库外，未读取目标内容。');
    const info = await lstat(full);
    if (info.isSymbolicLink()) return { ...renderPreview(entry, Buffer.from(await readlink(full)), '未跟踪', '链接本身', limits, 'text'), reason: '仅展示符号链接的目标路径，没有读取链接目标内容。' };
    if (!info.isFile()) return { entry, comparison: entry.comparison, text: '', format: 'unavailable', complete: false, reason: '仅支持普通文件和符号链接本身的预览。', base: '未跟踪', target: '工作区' };
    if (info.size > limits.previewBytes) return renderPreview(entry, Buffer.alloc(limits.previewBytes + 1, 32), '未跟踪', '工作区', limits, 'text');
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      // The file may grow after lstat. Read at most limit + 1 bytes, never unbounded readFile.
      const bytes = Buffer.alloc(limits.previewBytes + 1);
      const result = await handle.read(bytes, 0, bytes.length, 0);
      return renderPreview(entry, bytes.subarray(0, result.bytesRead), '未跟踪', '工作区', limits, 'text');
    } finally { await handle.close(); }
  }

  async function readChange(repository: RepositoryIdentity, entry: ChangeEntry, expectedFingerprint: string, signal?: AbortSignal): Promise<Diff> {
    requireEntry(entry);
    const before = await readOverview(repository, signal);
    if (before.fingerprint !== expectedFingerprint) throw new GitReadError('STALE_RESULT', '文件或比较基准已经变化，请刷新概览后重试。', true);
    const current = [...before.changes.staged, ...before.changes.unstaged, ...before.changes.untracked, ...before.changes.conflicts].find((item) => item.id === entry.id);
    if (!current) throw new GitReadError('STALE_RESULT', '所选变化已经不在当前清单中，请刷新。', true);
    if (current.comparison !== 'head-index' && await hasFilters(repository, signal)) throw new GitReadError('UNSUPPORTED_FILTER', '工作区需要外部内容过滤器，首版不运行过滤器。');
    let result: Diff;
    if (current.comparison === 'untracked-preview') result = await previewUntracked(repository, current);
    else {
      const staged = current.comparison === 'head-index';
      const paths = requireEntry(current);
      await verifyBlobs(repository, staged && before.head.kind !== 'unborn' ? [before.head.oid] : [], paths, true, signal);
      const bytes = await run(repository, ['diff', ...(staged ? ['--cached'] : []), ...diffFlags, '--', ...paths], signal);
      result = renderPreview(current, bytes, staged ? before.head.kind === 'unborn' ? '空树（首次提交）' : before.head.oid : 'index', staged ? 'index' : 'worktree', limits);
    }
    const after = await marker(repository, before.complete, signal);
    if (before.fingerprint !== after) throw new GitReadError('STALE_RESULT', '文件在读取差异期间变化，请刷新后重试。', true);
    return result;
  }

  async function shallowSet(repository: RepositoryIdentity): Promise<Set<string>> {
    return new Set((await optionalRead(path.join(repository.commonGitDir, 'shallow'))).toString('ascii').trim().split('\n').filter(Boolean));
  }
  const verifyBlobs = createBlobVerifier((repository, args, options) => executeGit(repository.worktreeRoot, args, options));
  async function commitNode(repository: RepositoryIdentity, oid: string, signal?: AbortSignal): Promise<CommitNode> {
    requireOid(oid);
    const bytes = await run(repository, ['cat-file', 'commit', oid], signal);
    let text: string;
    try { text = utf8.decode(bytes); } catch { throw new GitReadError('OBJECT_UNAVAILABLE', '提交元数据不是有效的 UTF-8，暂不能展示。'); }
    const boundary = (await shallowSet(repository)).has(oid);
    const split = text.indexOf('\n\n');
    const headers = text.slice(0, split).split('\n');
    const author = headers.find((line) => line.startsWith('author '))?.match(/^author (.*) <.*> (\d+) ([+-]\d+)$/);
    return { oid, parents: headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7)), author: author?.[1] ?? '未知作者', authoredAt: author?.[2] ? new Date(Number(author[2]) * 1000).toISOString() : '', subject: text.slice(split + 2).split('\n')[0] ?? '', refs: [], boundary };
  }
  const listNavigation = createNavigationReader(run, readHead, limits);
  async function refSnapshot(repository: RepositoryIdentity, signal?: AbortSignal) {
    const refs = new Map<string, string[]>();
    for (const ref of await readRefs(repository, run, signal)) {
      const label = ref.name.replace(/^refs\/(heads|tags|remotes)\//, '');
      refs.set(ref.oid, [...(refs.get(ref.oid) ?? []), label]);
    }
    return refs;
  }
  async function listHistory(repository: RepositoryIdentity, options: HistoryOptions, signal?: AbortSignal): Promise<History> {
    await rejectPromisor(repository.worktreeRoot, repository.commonGitDir, signal);
    if ((options.scope === 'ref') !== (options.ref !== undefined) || (options.ref && !historyRefSchema.safeParse(options.ref).success)) throw new GitReadError('INVALID_REQUEST', '历史引用筛选无效，请使用导航中的完整引用名。');
    if (options.order !== undefined && !historyOrderSchema.safeParse(options.order).success) throw new GitReadError('INVALID_REQUEST', '历史排序无效。');
    const order = resolveHistoryOrder(options);
    let state: PageState;
    if (options.cursor) {
      const saved = cursors.get(options.cursor);
      if (!saved || saved.worktreeId !== repository.worktreeId || historyFilterKey(saved) !== historyFilterKey(options)) throw new GitReadError('STALE_RESULT', '历史分页属于其他工作区、筛选或排序，请刷新历史。', true);
      state = saved;
    } else {
      const head = await readHead(repository, signal);
      const navigation = await listNavigation(repository, signal);
      const refs = new Map<string, string[]>();
      for (const ref of navigation.refs) refs.set(ref.oid, [...(refs.get(ref.oid) ?? []), ref.name.replace(/^refs\/(heads|tags|remotes)\//, '')]);
      const headOid = head.kind === 'unborn' ? undefined : head.oid;
      const tipOid = options.scope === 'ref' ? navigation.refs.find(ref => ref.name === options.ref)?.oid : undefined;
      if (options.scope === 'ref' && !tipOid) throw new GitReadError('STALE_RESULT', '所选引用已经不存在或未指向本机提交，请刷新导航。', true);
      const tips = options.scope === 'ref' ? [tipOid!] : options.scope === 'head' ? headOid ? [headOid] : [] : [...new Set([...refs.keys(), ...(headOid ? [headOid] : [])])];
      state = { worktreeId: repository.worktreeId, scope: options.scope, order, ...(options.ref ? { ref: options.ref } : {}), tips, refs, offset: 0, ...(headOid ? { headOid } : {}), ...(tipOid ? { tipOid } : {}) };
    }
    const shallow = await shallowSet(repository);
    const identity = { scope: state.scope, order: state.order, shallow: shallow.size > 0, ...(state.headOid ? { headOid: state.headOid } : {}), ...(state.ref ? { ref: state.ref } : {}), ...(state.tipOid ? { tipOid: state.tipOid } : {}) };
    if (!state.tips.length) return { commits: [], ...identity };
    const bytes = await run(repository, ['log', '-z', state.order === 'date' ? '--date-order' : '--topo-order', `--max-count=${limits.historyPageSize + 1}`, `--skip=${state.offset}`, '--format=%H%x00%P%x00%an%x00%aI%x00%s', ...state.tips, '--'], signal);
    const records = splitNul(bytes);
    if (records.length % 5) throw new GitReadError('INTERNAL_ERROR', '提交历史记录不完整。');
    const commits: CommitNode[] = [];
    for (let i = 0; i < Math.min(records.length, limits.historyPageSize * 5); i += 5) {
      const [oid, parents, author, authoredAt, subject] = records.slice(i, i + 5).map(item => item.toString('utf8'));
      const node: CommitNode = { oid: oid!, parents: parents!.split(' ').filter(Boolean), author: author!, authoredAt: authoredAt!, subject: subject!, refs: state.refs.get(oid!) ?? [], boundary: shallow.has(oid!) };
      if (node.boundary) node.parents = (await commitNode(repository, node.oid, signal)).parents;
      commits.push(node);
    }
    let nextCursor: string | undefined;
    if (records.length > limits.historyPageSize * 5) {
      nextCursor = randomUUID();
      cursors.set(nextCursor, { ...state, offset: state.offset + commits.length });
      if (cursors.size > limits.historyCursorCount) cursors.delete(cursors.keys().next().value!);
    }
    return { commits, ...identity, ...(nextCursor ? { nextCursor } : {}) };
  }

  async function readCommit(repository: RepositoryIdentity, oid: string, signal?: AbortSignal): Promise<CommitDetail> {
    await rejectPromisor(repository.worktreeRoot, repository.commonGitDir, signal);
    requireOid(oid);
    oid = (await run(repository, ['rev-parse', '--verify', `${oid}^{commit}`], signal)).toString('ascii').trim();
    const commit = await commitNode(repository, oid, signal);
    const refs = await refSnapshot(repository, signal);
    commit.refs = refs.get(oid) ?? [];
    const base = commit.parents[0] ?? null;
    if (commit.boundary && base) throw new GitReadError('OBJECT_UNAVAILABLE', '此提交位于浅克隆边界，父提交不在本机；未联网获取，无法可靠比较。');
    const bytes = await run(repository, ['diff-tree', '--no-commit-id', '-r', ...rawFlags, ...(base ? [base, oid] : ['--root', oid]), '--'], signal);
    return { commit, base, comparisonLabel: base ? commit.parents.length > 1 ? '相对第一父提交（不是合并全部变化）' : '相对父提交' : '相对空树（首次提交）', changes: parseRawDiff(bytes, 'commit-parent') };
  }
  async function readCommitChange(repository: RepositoryIdentity, oid: string, entry: ChangeEntry, signal?: AbortSignal): Promise<Diff> {
    const detail = await readCommit(repository, oid, signal);
    oid = detail.commit.oid;
    const current = detail.changes.find((candidate) => candidate.id === entry.id);
    if (!current) throw new GitReadError('STALE_RESULT', '该文件不属于所选提交的比较结果。', true);
    const paths = requireEntry(current);
    await verifyBlobs(repository, detail.base ? [detail.base, oid] : [oid], paths, false, signal);
    const bytes = await run(repository, ['diff-tree', '--no-commit-id', '-r', '-p', ...diffFlags, ...(detail.base ? [detail.base, oid] : ['--root', oid]), '--', ...paths], signal);
    return renderPreview(current, bytes, detail.base ?? '空树（首次提交）', oid, limits);
  }
  const comparisonReader = createComparisonReader(limits, rejectPromisor);
  function safeRead<T extends unknown[], R>(read: (...args: T) => Promise<R>, selectedFile = false): (...args: T) => Promise<R> {
    return async (...args) => {
      try { return await read(...args); } catch (error) {
        if (error instanceof GitReadError) throw error;
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'EACCES' || code === 'EPERM') throw new GitReadError('PERMISSION_DENIED', '没有权限读取仓库或所选文件，请检查本机文件权限。');
        if (code === 'ENOENT' || code === 'ENOTDIR') throw new GitReadError(selectedFile ? 'STALE_RESULT' : 'INVALID_REPOSITORY', selectedFile ? '所选文件已被删除或移动，请刷新后重试。' : '仓库目录已经不存在或已移动，请重新选择仓库。', true);
        if (code === 'ELOOP' || code === 'EILSEQ') throw new GitReadError('UNSUPPORTED_PATH', '路径包含无法安全读取的符号链接或编码，未展开内容。');
        throw error;
      }
    };
  }
  return { compareRevisions: safeRead(comparisonReader.compareRevisions), listComparisonCommits: safeRead(comparisonReader.listComparisonCommits), readComparisonChange: safeRead(comparisonReader.readComparisonChange), resolveRepository: safeRead(resolveRepository), readOverview: safeRead(readOverview), listNavigation: safeRead(listNavigation), readChange: safeRead(readChange, true), listHistory: safeRead(listHistory), readCommit: safeRead(readCommit), readCommitChange: safeRead(readCommitChange, true) };
}
