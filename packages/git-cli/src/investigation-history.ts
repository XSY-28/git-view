import { randomUUID } from 'node:crypto';
import { fileHistoryOptionsSchema, investigationFilterKey, searchOptionsSchema, type CommitNode, type FileHistoryOptions, type FileHistoryPage, type HeadState, type RepositoryIdentity, type SearchOptions, type SearchPage } from '@git-view/contracts';
import { createImmutableReader, fullOid } from './immutable.js';
import { readRefs } from './navigation.js';
import { hash, parseRawDiff, splitNul, utf8 } from './parse.js';
import { rawFlags } from './diff.js';
import { GitReadError } from './runner.js';
import { InvestigationStore, type InvestigationSnapshot } from './investigation-store.js';
import type { ReadLimits } from './limits.js';

export type ImmutableReader = ReturnType<typeof createImmutableReader>;
const shallowWarning = '浅历史只包含本机可见提交，历史调查可能不完整。';
const limitWarning = (limit: number) => `仅调查本次范围内最新 ${limit} 条候选提交，较早结果未覆盖。`;
function node(fields: Buffer[], shallow: Set<string>, refs = new Map<string, string[]>): CommitNode {
  let values: string[];
  try { values = fields.map(bytes => utf8.decode(bytes)); } catch { throw new GitReadError('OBJECT_UNAVAILABLE', '提交元数据不是有效的 UTF-8，暂不能展示。'); }
  const [oid, parents, author, authoredAt, subject] = values;
  if (!oid || !fullOid.test(oid) || !parents!.split(' ').filter(Boolean).every(oid => fullOid.test(oid))) throw new GitReadError('OBJECT_UNAVAILABLE', '提交元数据记录不完整。');
  return { oid, parents: parents!.split(' ').filter(Boolean), author: author!, authoredAt: authoredAt!, subject: subject!, refs: refs.get(oid) ?? [], boundary: shallow.has(oid) };
}

export function createInvestigationHistory(reader: ImmutableReader, store: InvestigationStore, limits: ReadLimits, readHead: (repo: RepositoryIdentity, signal?: AbortSignal) => Promise<HeadState>) {
  async function scope(repo: RepositoryIdentity, options: SearchOptions, signal?: AbortSignal) {
    const refs = await readRefs(repo, (repo, args, signal) => reader.run(repo, args, { signal }), signal);
    const head = await readHead(repo, signal);
    const headOid = head.kind === 'unborn' ? undefined : head.oid;
    const selected = options.scope === 'ref' ? (await reader.resolve(repo, { kind: 'ref', name: options.ref! }, signal)).oid : undefined;
    const tips = options.scope === 'all' ? [...new Set([...refs.map(ref => ref.oid), ...(headOid ? [headOid] : [])])].sort() : selected ? [selected] : headOid ? [headOid] : [];
    const labels = new Map<string, string[]>();
    for (const ref of refs) labels.set(ref.oid, [...(labels.get(ref.oid) ?? []), ref.name]);
    return { tips, labels, key: JSON.stringify([tips, refs, head]) };
  }
  async function searchCommits(repo: RepositoryIdentity, input: SearchOptions, signal?: AbortSignal): Promise<SearchPage> {
    const options = searchOptionsSchema.parse(input); const key = investigationFilterKey(options);
    let snapshot: InvestigationSnapshot; let offset = 0;
    if (options.cursor) ({ snapshot, offset } = store.cursor(options.cursor, repo.worktreeId, key, 'search'));
    else {
      const history = await reader.historyState(repo); const before = await scope(repo, options, signal);
      const term = options.term.toLocaleLowerCase('en');
      const records = before.tips.length ? splitNul(await reader.run(repo, ['log', '-z', '--date-order', '--no-follow', `--max-count=${limits.investigationCommitLimit + 1}`, '--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%ae', ...((options.field === 'subject' || options.field === 'author') ? ['--fixed-strings', '--regexp-ignore-case', `${options.field === 'subject' ? '--grep' : '--author'}=${options.term}`] : []), ...(options.field === 'path' ? ['--full-history'] : []), ...before.tips, '--', ...(options.field === 'path' ? [options.term] : [])], { signal })) : [];
      if (records.length % 6) throw new GitReadError('OBJECT_UNAVAILABLE', '提交元数据记录不完整。');
      const commits: CommitNode[] = [];
      for (let i = 0; i < Math.min(records.length, limits.investigationCommitLimit * 6); i += 6) {
        const commit = node(records.slice(i, i + 5), history.shallow, before.labels);
        const matches = options.field === 'subject' ? commit.subject.toLocaleLowerCase('en').includes(term) : options.field === 'author' ? `${commit.author} ${utf8.decode(records[i + 5]!)}`.toLocaleLowerCase('en').includes(term) : options.field === 'oid' ? commit.oid.startsWith(term) : true;
        if (matches) commits.push(commit);
      }
      const limited = records.length > limits.investigationCommitLimit * 6;
      const data: SearchPage = { snapshotId: randomUUID(), worktreeId: repo.worktreeId, historyKey: history.key, observedAt: new Date().toISOString(), scope: options.scope, ...(options.ref ? { ref: options.ref } : {}), field: options.field, term: options.term, tips: before.tips, commits, complete: !history.shallow.size && !limited, warnings: [...(history.shallow.size ? [shallowWarning] : []), ...(limited ? [limitWarning(limits.investigationCommitLimit)] : [])] };
      if ((await scope(repo, options, signal)).key !== before.key) throw new GitReadError('STALE_RESULT', '调查范围在读取期间变化，请重新读取。', true);
      await reader.assertHistory(repo, data, signal); snapshot = { kind: 'search', data, key }; store.save(snapshot, signal);
    }
    if (snapshot.kind !== 'search') throw new GitReadError('INVALID_REQUEST', '历史调查类型不匹配。');
    await reader.assertHistory(repo, snapshot.data, signal);
    const page = store.page(snapshot, offset);
    return { ...snapshot.data, commits: snapshot.data.commits.slice(page.offset, page.end), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
  async function listFileHistory(repo: RepositoryIdentity, input: FileHistoryOptions, signal?: AbortSignal): Promise<FileHistoryPage> {
    const options = fileHistoryOptionsSchema.parse(input); const key = investigationFilterKey(options);
    let snapshot: InvestigationSnapshot; let offset = 0;
    if (options.cursor) ({ snapshot, offset } = store.cursor(options.cursor, repo.worktreeId, key, 'file'));
    else {
      const history = await reader.historyState(repo); const endpoint = await reader.resolve(repo, options.endpoint, signal);
      const records = splitNul(await reader.run(repo, ['log', '--follow', '--first-parent', '--diff-merges=first-parent', ...rawFlags, `--max-count=${limits.investigationCommitLimit + 1}`, '--format=%H%x00%P%x00%an%x00%aI%x00%s', endpoint.oid, '--', options.path], { signal }));
      const entries: FileHistoryPage['entries'] = []; let currentPath = Buffer.from(options.path).toString('base64'); let candidates = 0;
      for (let i = 0; i < records.length;) {
        if (!records[i]!.length) { i++; continue; }
        if (i + 5 > records.length) throw new GitReadError('OBJECT_UNAVAILABLE', '文件历史记录不完整。');
        let commit = node(records.slice(i, i + 5), history.shallow); i += 5; candidates++;
        const raw: Buffer[] = [];
        while (i < records.length && records[i]!.toString('ascii').replace(/^\n+/, '').startsWith(':')) {
          const rawRecord = records[i++]!;
          const info = rawRecord.subarray(rawRecord.lastIndexOf(58));
          const kind = info.toString('ascii').split(' ').at(-1)!;
          const paths = kind.startsWith('R') || kind.startsWith('C') ? 2 : 1;
          if (i + paths > records.length) throw new GitReadError('OBJECT_UNAVAILABLE', '文件历史路径记录不完整。');
          raw.push(info, ...records.slice(i, i + paths)); i += paths;
        }
        const changes = parseRawDiff(Buffer.concat(raw.flatMap(bytes => [bytes, Buffer.from([0])])), 'revision-pair');
        const change = changes.find(change => change.rawPath === currentPath);
        if (!change || candidates > limits.investigationCommitLimit) continue;
        if (commit.boundary) commit = await reader.commitNode(repo, commit.oid, signal);
        entries.push({ entryId: hash(`${commit.oid}:${change.id}`), commit, change, base: commit.parents[0] ?? null });
        if (change.kind.startsWith('R') && change.rawOldPath) currentPath = change.rawOldPath;
      }
      const limited = candidates > limits.investigationCommitLimit;
      const data: FileHistoryPage = { snapshotId: randomUUID(), worktreeId: repo.worktreeId, historyKey: history.key, observedAt: new Date().toISOString(), tipOid: endpoint.oid, path: options.path, firstParent: true, entries, complete: !history.shallow.size && !limited, warnings: ['仅沿第一父链追踪普通重命名；未覆盖所有合并来源或复制历史。', ...(history.shallow.size ? [shallowWarning] : []), ...(limited ? [limitWarning(limits.investigationCommitLimit)] : [])] };
      if ((await reader.resolve(repo, options.endpoint, signal)).oid !== endpoint.oid) throw new GitReadError('STALE_RESULT', '调查范围在读取期间变化，请重新读取。', true);
      await reader.assertHistory(repo, data, signal); snapshot = { kind: 'file', data, key }; store.save(snapshot, signal);
    }
    if (snapshot.kind !== 'file') throw new GitReadError('INVALID_REQUEST', '历史调查类型不匹配。');
    await reader.assertHistory(repo, snapshot.data, signal); const page = store.page(snapshot, offset);
    return { ...snapshot.data, entries: snapshot.data.entries.slice(page.offset, page.end), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
  function fileEntry(repo: RepositoryIdentity, snapshotId: string, entryId: string) {
    const snapshot = store.get(snapshotId, repo.worktreeId);
    const item = snapshot.kind === 'file' ? snapshot.data.entries.find(entry => entry.entryId === entryId) : undefined;
    if (!item || snapshot.kind !== 'file') throw new GitReadError('STALE_RESULT', '文件不属于此历史观测，请重新选择。', true);
    return { snapshot: snapshot.data, item };
  }
  async function readFileHistoryChange(repo: RepositoryIdentity, snapshotId: string, entryId: string, signal?: AbortSignal) {
    const { snapshot, item } = fileEntry(repo, snapshotId, entryId); await reader.assertHistory(repo, snapshot, signal);
    if (item.commit.boundary && item.base) throw new GitReadError('OBJECT_UNAVAILABLE', '此提交位于浅克隆边界，父提交不在本机；未联网获取，无法可靠比较。');
    const diff = await reader.treeChange(repo, { base: item.base, target: item.commit.oid, changes: [item.change] }, item.change, signal);
    await reader.assertHistory(repo, snapshot, signal); return diff;
  }
  return { searchCommits, listFileHistory, fileEntry, readFileHistoryChange };
}
