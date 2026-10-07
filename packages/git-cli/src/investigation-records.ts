import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { INVESTIGATION_LIMITS, investigationFilterKey, recordOptionsSchema, type ChangeEntry, type RecordOptions, type RecordPage, type RepositoryIdentity, type RepositoryRecord, type StashDetail, type StashPart } from '@git-view/contracts';
import { hash, utf8 } from './parse.js';
import { fullOid } from './immutable.js';
import { GitReadError } from './runner.js';
import { InvestigationStore, type InvestigationSnapshot } from './investigation-store.js';
import type { ImmutableReader } from './investigation-history.js';
import type { ReadLimits } from './limits.js';

export function createInvestigationRecords(reader: ImmutableReader, store: InvestigationStore, limits: ReadLimits) {
  async function logFile(repo: RepositoryIdentity, ref: string, signal?: AbortSignal) {
    const format = (await reader.run(repo, ['config', '--get', 'extensions.refStorage'], { signal, allowedExitCodes: [0, 1] })).toString('ascii').trim();
    if (format && format !== 'files') throw new GitReadError('UNSUPPORTED_REPOSITORY', '此引用存储格式暂不支持本地记录查看。');
    if (ref !== 'HEAD') await reader.validateRef(repo, ref, signal);
    const directory = ref === 'HEAD' ? repo.gitDir : repo.commonGitDir;
    const file = path.join(directory, 'logs', ref);
    let stat;
    try { stat = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: Buffer.alloc(0), exists: false }; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new GitReadError('UNSUPPORTED_PATH', '本地记录路径无法安全读取。');
    if (stat.size > limits.maxOutputBytes) throw new GitReadError('OUTPUT_LIMIT', '本地记录超过安全上限，未返回不完整结果。');
    const actual = await realpath(file); const root = await realpath(directory);
    if (!actual.startsWith(`${root}${path.sep}`)) throw new GitReadError('UNSUPPORTED_PATH', '本地记录路径无法安全读取。');
    const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const observed = await handle.stat();
      if (!observed.isFile() || observed.size > limits.maxOutputBytes) throw new GitReadError('OUTPUT_LIMIT', '本地记录超过安全上限，未返回不完整结果。');
      const bytes = Buffer.alloc(observed.size + 1); let read = 0;
      while (read < bytes.length) {
        if (signal?.aborted) throw new GitReadError('CANCELLED', '读取已取消。');
        const result = await handle.read(bytes, read, bytes.length - read, read); if (!result.bytesRead) break; read += result.bytesRead;
      }
      const after = await handle.stat();
      if (read !== observed.size || after.size !== observed.size || after.mtimeMs !== observed.mtimeMs || after.ctimeMs !== observed.ctimeMs) throw new GitReadError('STALE_RESULT', '本地记录在读取期间变化，请重新读取。', true);
      return { bytes: bytes.subarray(0, read), exists: true };
    } finally { await handle.close(); }
  }
  function parseRecords(bytes: Buffer, ref: string): RepositoryRecord[] {
    if (!bytes.length) return [];
    let text: string;
    try { text = utf8.decode(bytes); } catch { throw new GitReadError('OBJECT_UNAVAILABLE', '本地记录不是有效的 UTF-8，未返回不完整结果。'); }
    if (!text.endsWith('\n')) throw new GitReadError('STALE_RESULT', '本地记录在读取期间变化，请重新读取。', true);
    const occurrences = new Map<string, number>();
    const records = text.slice(0, -1).split('\n').map(line => {
      const record = line.match(/^([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) (.*) (-?[0-9]+) ([+-][0-9]{4})(?:\t(.*))?$/);
      if (!record) throw new GitReadError('OBJECT_UNAVAILABLE', '本地记录格式不完整，未返回推断结果。');
      const [, oldOid, newOid, actor, seconds, , message] = record;
      const date = new Date(Number(seconds) * 1000);
      if (Number.isNaN(date.getTime())) throw new GitReadError('OBJECT_UNAVAILABLE', '本地记录时间无效。');
      // Selectors move when records are appended; identity belongs to the stored record.
      const occurrence = occurrences.get(line) ?? 0; occurrences.set(line, occurrence + 1);
      return { recordId: hash(`${occurrence}:${line}`), oldOid: oldOid!, newOid: newOid!, actor: actor!, recordedAt: date.toISOString(), message: message ?? '', availability: /^0+$/.test(newOid!) ? 'deleted' as const : 'unavailable' as const };
    });
    return records.reverse().map((record, index) => ({ ...record, selector: `${ref === 'refs/stash' ? 'stash' : ref}@{${index}}` }));
  }
  async function availability(repo: RepositoryIdentity, entries: RepositoryRecord[], signal?: AbortSignal) {
    if (!entries.length) return entries;
    const oids = [...new Set(entries.filter(entry => !/^0+$/.test(entry.newOid)).map(entry => entry.newOid))];
    const types = new Map<string, string>();
    if (oids.length) {
      const checked = await reader.run(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { signal, input: Buffer.from(`${oids.join('\n')}\n`) });
      for (const line of checked.toString('ascii').trim().split('\n')) { const [oid, type] = line.split(' '); types.set(oid!, type!); }
    }
    return entries.map(entry => ({ ...entry, availability: /^0+$/.test(entry.newOid) ? 'deleted' as const : types.get(entry.newOid) === 'commit' ? 'commit' as const : types.get(entry.newOid) === 'missing' || !types.has(entry.newOid) ? 'unavailable' as const : 'other' as const }));
  }
  async function listRecords(repo: RepositoryIdentity, input: RecordOptions, signal?: AbortSignal): Promise<RecordPage> {
    const options = recordOptionsSchema.parse(input); const key = investigationFilterKey(options); const ref = options.kind === 'stash' ? 'refs/stash' : options.ref ?? 'HEAD';
    let snapshot: InvestigationSnapshot; let offset = 0;
    if (options.cursor) ({ snapshot, offset } = store.cursor(options.cursor, repo.worktreeId, key, 'records'));
    else {
      const history = await reader.historyState(repo); const before = await logFile(repo, ref, signal);
      const all = parseRecords(before.bytes, ref); const limited = all.length > limits.investigationCommitLimit;
      const data: RecordPage = { snapshotId: randomUUID(), worktreeId: repo.worktreeId, historyKey: history.key, observedAt: new Date().toISOString(), kind: options.kind, ref, entries: all.slice(0, limits.investigationCommitLimit), complete: !limited, warnings: [...(options.kind === 'reflog' ? ['reflog 仅保留本机尚未过期的引用记录，并非完整命令审计。'] : []), ...(!before.exists ? [options.kind === 'stash' ? '本机没有保存的 stash 记录。' : '本机没有此引用的 reflog；记录可能未启用或已经过期。'] : []), ...(limited ? [`仅显示本机最新 ${limits.investigationCommitLimit} 条记录，较早记录未覆盖。`] : [])] };
      const after = await logFile(repo, ref, signal);
      if (after.exists !== before.exists || !after.bytes.equals(before.bytes)) throw new GitReadError('STALE_RESULT', '本地记录在读取期间变化，请重新读取。', true);
      await reader.assertHistory(repo, data, signal); snapshot = { kind: 'records', data, key }; store.save(snapshot, signal);
    }
    if (snapshot.kind !== 'records') throw new GitReadError('INVALID_REQUEST', '历史调查类型不匹配。');
    await reader.assertHistory(repo, snapshot.data, signal); const page = store.page(snapshot, offset);
    const entries = await availability(repo, snapshot.data.entries.slice(page.offset, page.end), signal);
    await reader.assertHistory(repo, snapshot.data, signal);
    return { ...snapshot.data, entries, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
  async function readStash(repo: RepositoryIdentity, snapshotId: string, recordId: string, signal?: AbortSignal): Promise<StashDetail> {
    const snapshot = store.get(snapshotId, repo.worktreeId);
    const record = snapshot.kind === 'records' && snapshot.data.kind === 'stash' ? snapshot.data.entries.find(item => item.recordId === recordId) : undefined;
    if (!record) throw new GitReadError('STALE_RESULT', '记录不属于此 stash 观测，请重新读取。', true);
    await reader.assertHistory(repo, snapshot.data, signal);
    const commit = await reader.commitNode(repo, record.newOid, signal);
    if (commit.parents.length < 2 || commit.parents.length > 3) throw new GitReadError('OBJECT_UNAVAILABLE', 'stash 对象结构不符合预期，未推断快照。');
    const [base, index, untracked] = commit.parents;
    const indexCommit = await reader.commitNode(repo, index!, signal);
    if (indexCommit.parents.length !== 1 || indexCommit.parents[0] !== base) throw new GitReadError('OBJECT_UNAVAILABLE', 'stash 对象结构不符合预期，未推断快照。');
    const parts: StashDetail['parts'] = [
      { kind: 'worktree', ...await reader.trees(repo, base!, commit.oid, signal) },
      { kind: 'index', ...await reader.trees(repo, base!, index!, signal) },
    ];
    if (untracked) {
      if ((await reader.commitNode(repo, untracked, signal)).parents.length) throw new GitReadError('OBJECT_UNAVAILABLE', 'stash 对象结构不符合预期，未推断快照。');
      parts.push({ kind: 'untracked', ...await reader.trees(repo, null, untracked, signal) });
    }
    const result: StashDetail = { snapshotId, recordId, commit, parts, warnings: [...(untracked ? [] : ['此 stash 没有独立的未跟踪文件快照。'])] };
    if (Buffer.byteLength(JSON.stringify(result)) > INVESTIGATION_LIMITS.snapshotBytes) throw new GitReadError('OUTPUT_LIMIT', '历史调查结果超过安全上限，未返回不完整结果。');
    await reader.assertHistory(repo, snapshot.data, signal); return result;
  }
  async function readStashChange(repo: RepositoryIdentity, detail: StashDetail, part: StashPart, entry: ChangeEntry, signal?: AbortSignal) {
    const snapshot = store.get(detail.snapshotId, repo.worktreeId);
    if (snapshot.kind !== 'records' || snapshot.data.kind !== 'stash' || !snapshot.data.entries.some(item => item.recordId === detail.recordId && item.newOid === detail.commit.oid)) throw new GitReadError('STALE_RESULT', '记录不属于此 stash 观测，请重新读取。', true);
    const tree = detail.parts.find(item => item.kind === part);
    if (!tree) throw new GitReadError('INVALID_REQUEST', '此 stash 没有选择的快照。');
    await reader.assertHistory(repo, snapshot.data, signal); const diff = await reader.treeChange(repo, tree, entry, signal);
    await reader.assertHistory(repo, snapshot.data, signal); return diff;
  }
  return { listRecords, readStash, readStashChange };
}
