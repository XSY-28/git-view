import type { HeadState, Navigation, NavigationRef, RepositoryIdentity } from '@git-view/contracts';
import { GitReadError } from './runner.js';
import { splitNul, utf8 } from './parse.js';
import type { ReadLimits } from './limits.js';
import { realpath } from 'node:fs/promises';

type Run = (repository: RepositoryIdentity, args: string[], signal?: AbortSignal) => Promise<Buffer>;

export async function readRefs(repository: RepositoryIdentity, run: Run, signal?: AbortSignal): Promise<NavigationRef[]> {
  const bytes = await run(repository, ['for-each-ref', '--format=%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)%00%(refname)%00', 'refs/heads', 'refs/tags', 'refs/remotes'], signal);
  let text: string;
  try { text = utf8.decode(bytes); } catch { throw new GitReadError('UNSUPPORTED_PATH', '引用名称不是有效的 UTF-8，暂不能安全导航。'); }
  const records = splitNul(Buffer.from(text.replace(/\n/g, ''), 'utf8'));
  if (records.length % 5) throw new GitReadError('INTERNAL_ERROR', '引用列表记录不完整。');
  const refs: NavigationRef[] = [];
  for (let i = 0; i < records.length; i += 5) {
    const [object, peeled, type, peeledType, name] = records.slice(i, i + 5).map(item => item.toString('utf8'));
    const oid = type === 'commit' ? object : peeledType === 'commit' ? peeled : undefined;
    // Only commit-backed refs can select a history. Non-commit tags have no commit history.
    if (!oid || !name) continue;
    refs.push({ name, oid, kind: name.startsWith('refs/heads/') ? 'local' : name.startsWith('refs/remotes/') ? 'remote' : 'tag' });
  }
  return refs;
}

export function parseWorktrees(bytes: Buffer): Navigation['worktrees'] {
  const worktrees: Navigation['worktrees'] = [];
  let current: Navigation['worktrees'][number] | undefined;
  for (const bytesRecord of splitNul(bytes)) {
    let record: string;
    try { record = utf8.decode(bytesRecord); } catch { throw new GitReadError('UNSUPPORTED_PATH', 'worktree 路径不是有效的 UTF-8，暂不能安全导航。'); }
    if (!record) { if (current) worktrees.push(current); current = undefined; continue; }
    const space = record.indexOf(' ');
    const key = space < 0 ? record : record.slice(0, space);
    const value = space < 0 ? '' : record.slice(space + 1);
    if (key === 'worktree') { if (current) throw new GitReadError('INTERNAL_ERROR', 'worktree 列表缺少记录边界。'); current = { path: value }; continue; }
    if (!current) throw new GitReadError('INTERNAL_ERROR', 'worktree 列表缺少路径。');
    if (key === 'HEAD' && !/^0+$/.test(value)) current.headOid = value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'bare') current.bare = true;
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') current.locked = value || '工作区已锁定';
    else if (key === 'prunable') current.prunable = value || '工作区已失效';
  }
  if (current) worktrees.push(current);
  return worktrees;
}

export function createNavigationReader(run: Run, readHead: (repository: RepositoryIdentity, signal?: AbortSignal) => Promise<HeadState>, limits: ReadLimits) {
  const snapshot = async (repository: RepositoryIdentity, signal?: AbortSignal): Promise<Navigation> => {
    const head = await readHead(repository, signal);
    const refs = await readRefs(repository, run, signal);
    const parsed = parseWorktrees(await run(repository, ['worktree', 'list', '--porcelain', '-z'], signal));
    // Git for Windows uses forward slashes and may expand short path names.
    // Use the same filesystem identity as resolveRepository and RecentStore.
    const worktrees = await Promise.all(parsed.map(async tree => {
      try { return { ...tree, path: await realpath(tree.path) }; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Missing/prunable worktrees still belong in the navigation list.
        if (code === 'ENOENT' || code === 'ENOTDIR') return tree;
        throw error;
      }
    }));
    return { refs: refs.map(ref => ({ ...ref, ...(head.kind !== 'detached' && ref.name === `refs/heads/${head.branch}` ? { current: true } : {}) })), worktrees };
  };
  return async (repository: RepositoryIdentity, signal?: AbortSignal): Promise<Navigation> => {
    for (let attempt = 0; attempt <= limits.consistencyRetries; attempt++) {
      const before = await snapshot(repository, signal);
      const after = await snapshot(repository, signal);
      if (JSON.stringify(before) === JSON.stringify(after)) return after;
    }
    throw new GitReadError('REPOSITORY_BUSY', '引用或 worktree 在读取期间持续变化，请稍后刷新。', true);
  };
}
