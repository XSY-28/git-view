import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { QueryError, responseSchema, type ApiRequest, type ApiResponse } from '@git-view/contracts';
import { dataDirectory, ensurePrivateDirectory, readInstance, type InstanceRecord } from './storage';

const healthSchema = z.object({ schemaVersion: z.literal(1), instanceId: z.string(), alive: z.literal(true) });
export function instanceOrigin(record: InstanceRecord) { return `http://127.0.0.1:${record.port}`; }
export async function verifyInstance(record: InstanceRecord): Promise<boolean> {
  try {
    const response = await fetch(`${instanceOrigin(record)}/health`, { headers: { Authorization: `Bearer ${record.cliToken}` }, signal: AbortSignal.timeout(700) });
    if (!response.ok) return false;
    const body = healthSchema.safeParse(await response.json());
    return body.success && body.data.instanceId === record.instanceId;
  } catch { return false; }
}
export async function callInstance(record: InstanceRecord, request: ApiRequest): Promise<ApiResponse> {
  let response: Response;
  try { response = await fetch(`${instanceOrigin(record)}/api`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${record.cliToken}` }, body: JSON.stringify(request), signal: AbortSignal.timeout(30_000) }); }
  catch { throw new QueryError('TIMEOUT', '本地进程未响应，请重新执行命令。', true); }
  let body: unknown;
  try { body = await response.json(); } catch { throw new QueryError('INVALID_REQUEST', '本地进程返回了无法识别的响应。'); }
  if (body && typeof body === 'object' && 'schemaVersion' in body && body.schemaVersion !== 1) throw new QueryError('VERSION_MISMATCH', '本地进程协议版本不兼容。');
  const result = responseSchema.safeParse(body);
  if (!result.success) throw new QueryError('INVALID_REQUEST', '本地进程响应不符合协议。');
  return result.data;
}
function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
const lockSchema = z.object({ ownerId: z.string(), createdAt: z.number() });
async function readLock(file: string) {
  try { return lockSchema.parse(JSON.parse(await readFile(file, 'utf8'))); } catch { return undefined; }
}
async function releaseLock(file: string, ownerId: string) { if ((await readLock(file))?.ownerId === ownerId) await unlink(file).catch(() => {}); }

export async function ensureInstance(options: { directory?: string; serverEntry?: string; startupTimeoutMs?: number } = {}): Promise<InstanceRecord> {
  const directory = options.directory ?? dataDirectory();
  await ensurePrivateDirectory(directory);
  const existing = await readInstance(directory);
  if (existing && await verifyInstance(existing)) return existing;
  const lockPath = join(directory, 'startup.lock');
  const ownerId = randomUUID();
  const deadline = Date.now() + (options.startupTimeoutMs ?? 20_000);
  let ownsLock = false;
  while (Date.now() < deadline) {
    const record = await readInstance(directory);
    if (record && await verifyInstance(record)) return record;
    try {
      const file = await open(lockPath, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ ownerId, createdAt: Date.now() })); } finally { await file.close(); }
      ownsLock = true; break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lock = await readLock(lockPath);
      const stat = await lstat(lockPath).catch(() => undefined);
      if (stat && Date.now() - (lock?.createdAt ?? stat.mtimeMs) > 10_000) {
        if (lock) await releaseLock(lockPath, lock.ownerId);
        else if ((await lstat(lockPath).catch(() => undefined))?.ino === stat.ino) await unlink(lockPath).catch(() => {});
      }
      await sleep(100);
    }
  }
  if (!ownsLock) throw new QueryError('TIMEOUT', '等待本地进程启动超时，请重试。', true);
  try {
    const record = await readInstance(directory);
    if (record && await verifyInstance(record)) return record;
    const entry = options.serverEntry ?? join(dirname(fileURLToPath(import.meta.url)), 'server.mjs');
    const child = spawn(process.execPath, [entry], { detached: true, stdio: 'ignore', env: { ...process.env, GIT_VIEW_HOME: directory } });
    let launchError = false; child.once('error', () => { launchError = true; }); child.unref();
    while (Date.now() < deadline) {
      if (launchError) throw new QueryError('INTERNAL_ERROR', '无法启动本地进程，请检查 Node 与构建产物。');
      const started = await readInstance(directory);
      if (started && await verifyInstance(started)) return started;
      await sleep(100);
    }
    throw new QueryError('TIMEOUT', '本地进程启动超时，请检查是否已运行 pnpm build。', true);
  } finally { await releaseLock(lockPath, ownerId); }
}
