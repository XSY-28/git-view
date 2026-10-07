import { constants, type Stats } from 'node:fs';
import { chmod, link, lstat, mkdir, open, opendir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { checkPrivate, privateDirectoryPermissions, syncDirectory, replaceFile, openRead } from '../../git-write/src/filesystem.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { QueryError, repositorySchema, operationReceiptSchema, type RepositoryIdentity } from '@git-view/contracts';
import { repositoryEvidenceSchema } from '../../git-write/src/repository.js';
import { indexWriteEvidenceSchema } from '../../git-write/src/index.js';

const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const lockSchema = z.object({ schemaVersion: z.literal(1), token: z.string().uuid(), ownerId: z.string().uuid(), pid: z.number().int().positive() }).strict();
const pendingMarkerSchema = z.object({ schemaVersion: z.literal(1), operationId: z.string().uuid() }).strict();
export const storedReceiptSchema = z.object({
  schemaVersion: z.literal(1), repository: repositorySchema.strict(), receipt: operationReceiptSchema.strict(),
  ownerId: z.string().uuid(), pid: z.number().int().positive(), evidence: z.union([indexWriteEvidenceSchema, repositoryEvidenceSchema]).optional(),
}).strict();
export type StoredReceipt = z.infer<typeof storedReceiptSchema>;
const hash = (input: string) => createHash('sha256').update(input).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const unsafe = () => new QueryError('PERMISSION_DENIED', '操作回执目录或文件不安全，请检查本机应用数据目录。');
function parseReceipt(data: unknown, operationId?: string): StoredReceipt {
  const parsed = storedReceiptSchema.safeParse(data);
  if (!parsed.success || (operationId !== undefined && parsed.data.receipt.operationId !== operationId) || parsed.data.receipt.worktreeId !== parsed.data.repository.worktreeId || (parsed.data.evidence && !sameRepository(parsed.data.repository, parsed.data.evidence.repository))) throw new QueryError('INTERNAL_ERROR', '操作回执内容无效；为避免重复执行，已停止这次请求。');
  return parsed.data;
}

async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw unsafe();
  if (process.platform === 'win32') await privateDirectoryPermissions(directory);
  else await chmod(directory, 0o700);
}
async function readJson(file: string): Promise<unknown | undefined> {
  let handle;
  try {
    handle = await openRead(file);
    const stat = await handle.stat();
    await checkPrivate(file, stat, false);
    if (stat.size > MAX_RECORD_BYTES) throw new QueryError('INTERNAL_ERROR', '操作回执过大，无法可靠读取。');
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (missing(error)) return undefined;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw unsafe();
    throw error;
  } finally { await handle?.close(); }
}
async function assertTarget(file: string) {
  try { await checkPrivate(file, await lstat(file), false); } catch (error) { if (!missing(error)) throw error; }
}
async function atomicJson(file: string, data: unknown) {
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new QueryError('OUTPUT_LIMIT', '操作回执超过安全大小限制。');
  await assertTarget(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await assertTarget(file);
    await replaceFile(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
}
export function sameRepository(first: RepositoryIdentity, second: RepositoryIdentity) {
  return first.repositoryId === second.repositoryId && first.worktreeId === second.worktreeId && first.worktreeRoot === second.worktreeRoot && first.gitDir === second.gitDir && first.commonGitDir === second.commonGitDir;
}
export function processAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export async function createReceiptStore(directory: string) {
  await privateDirectory(directory);
  const root = path.join(await realpath(directory), 'operations');
  await privateDirectory(root);
  const pendingRoot = path.join(root, 'pending');
  await privateDirectory(pendingRoot);
  const receiptPath = (operationId: string) => path.join(root, `${hash(operationId)}.json`);
  const markerPath = (operationId: string) => path.join(pendingRoot, `${hash(operationId)}.json`);
  const lockPath = (repository: RepositoryIdentity) => path.join(root, `${hash(repository.gitDir)}.lock`);
  const commonLockPath = (repository: RepositoryIdentity) => path.join(root, `common-${hash(repository.commonGitDir)}.lock`);
  const secureRoot = async () => checkPrivate(root, await lstat(root), true);
  const securePending = async () => { await secureRoot(); await checkPrivate(pendingRoot, await lstat(pendingRoot), true); };
  async function clearPending(operationId: string) {
    await securePending();
    await assertTarget(markerPath(operationId));
    try { await unlink(markerPath(operationId)); await syncDirectory(pendingRoot); } catch (error) { if (!missing(error)) throw error; }
  }
  return {
    key: (operationId: string) => receiptPath(operationId),
    async load(operationId: string): Promise<StoredReceipt | undefined> {
      await secureRoot();
      const data = await readJson(receiptPath(operationId));
      if (data === undefined) return undefined;
      return parseReceipt(data, operationId);
    },
    async listUnresolved(repository: RepositoryIdentity): Promise<StoredReceipt[]> {
      await securePending();
      const records: StoredReceipt[] = [];
      let count = 0, receiptCount = 0, bytes = 0;
      // Completed history is intentionally not scanned. A marker is durable before
      // writer invocation and removed only after a terminal receipt is durable.
      const names: string[] = [];
      const directory = await opendir(pendingRoot);
      for await (const entry of directory) {
        if (++count > 2000) throw new QueryError('OUTPUT_LIMIT', '待核实索引超过 2000 项，无法完整检查待核实操作。请先整理应用数据目录。');
        if (!entry.name.endsWith('.json')) continue;
        if (++receiptCount > 1000) throw new QueryError('OUTPUT_LIMIT', '待核实操作超过 1000 项，无法完整检查。请先按操作 ID 核对回执。');
        if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) throw new QueryError('INTERNAL_ERROR', '待核实索引含无法识别的文件，未忽略该文件。');
        names.push(entry.name);
      }
      // Reject an oversized scan before launching per-file native ACL checks.
      for (const name of names) {
        const marker = pendingMarkerSchema.safeParse(await readJson(path.join(pendingRoot, name)));
        if (!marker.success || hash(marker.data.operationId) !== name.slice(0, -5)) throw new QueryError('INTERNAL_ERROR', '待核实索引内容无效，无法可靠恢复。');
        const file = receiptPath(marker.data.operationId);
        const stat = await lstat(file); await checkPrivate(file, stat, false);
        bytes += stat.size;
        if (bytes > 16 * 1024 * 1024) throw new QueryError('OUTPUT_LIMIT', '操作回执超过 16 MiB，无法完整检查待核实操作。请先整理应用数据目录。');
        const data = await readJson(file);
        if (data === undefined) throw new QueryError('INTERNAL_ERROR', '操作记录在读取时消失，未返回不完整的待核实列表。');
        const record = parseReceipt(data, marker.data.operationId);
        if (['succeeded', 'failed'].includes(record.receipt.status)) { await clearPending(record.receipt.operationId); continue; }
        if (sameRepository(record.repository, repository)) records.push(record);
      }
      return records;
    },
    async save(record: StoredReceipt) {
      await secureRoot();
      await atomicJson(receiptPath(record.receipt.operationId), storedReceiptSchema.parse(record));
      if (['succeeded', 'failed'].includes(record.receipt.status)) await clearPending(record.receipt.operationId);
    },
    async reserve(record: StoredReceipt) {
      await secureRoot();
      const text = JSON.stringify(storedReceiptSchema.parse(record));
      if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new QueryError('OUTPUT_LIMIT', '操作回执超过安全大小限制。');
      const file = receiptPath(record.receipt.operationId);
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
        // link provides atomic no-replace publication; another repository cannot
        // claim or overwrite the same operation ID in a competing service.
        try { await link(temporary, file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
        await syncDirectory(root);
        await securePending();
        await atomicJson(markerPath(record.receipt.operationId), { schemaVersion: 1, operationId: record.receipt.operationId });
        return true;
      } finally { await unlink(temporary).catch(() => {}); }
    },
    async lock(repository: RepositoryIdentity, ownerId: string, common = false) {
      await secureRoot();
      const file = common ? commonLockPath(repository) : lockPath(repository);
      const record = { schemaVersion: 1 as const, token: randomUUID(), ownerId, pid: process.pid };
      let handle;
      try { handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new QueryError('REPOSITORY_BUSY', `此工作区已有写操作或上次退出留下的操作锁；请先查询原操作回执，并确认原进程退出后再处理应用锁文件：${file}`, true);
        throw error;
      }
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
      catch (error) { await handle.close(); await unlink(file).catch(() => {}); throw error; }
      await handle.close();
      await syncDirectory(root);
      return async () => {
        const current = lockSchema.safeParse(await readJson(file));
        if (current.success && current.data.token === record.token) { await unlink(file); await syncDirectory(root); }
      };
    },
    async hasLiveLock(repository: RepositoryIdentity, ownerId: string) {
      await secureRoot();
      const data = await readJson(lockPath(repository)) ?? await readJson(commonLockPath(repository));
      if (data === undefined) return false;
      const record = lockSchema.safeParse(data);
      if (!record.success) throw new QueryError('INTERNAL_ERROR', '操作锁内容无效，请先核对仓库与操作回执。');
      return record.data.ownerId === ownerId && processAlive(record.data.pid);
    },
  };
}
