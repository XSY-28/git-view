import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { recentSchema, type RecentRepository, type RepositoryIdentity } from '@git-view/contracts';

export const instanceSchema = z.object({ schemaVersion: z.literal(1), instanceId: z.string().min(20), port: z.number().int().min(1).max(65535), cliToken: z.string().min(32), pid: z.number().int().positive(), startedAt: z.string() });
export type InstanceRecord = z.infer<typeof instanceSchema>;
export function dataDirectory() { return process.env.GIT_VIEW_HOME || join(homedir(), '.local', 'share', 'git-view'); }
export async function ensurePrivateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('应用数据目录必须是当前用户拥有的实际目录。');
  await chmod(directory, 0o700);
}
export async function writePrivateJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, file); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
export async function readInstance(directory: string): Promise<InstanceRecord | undefined> {
  try {
    const file = join(directory, 'instance.json');
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) return undefined;
    return instanceSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch { return undefined; }
}
export async function removeOwnInstance(directory: string, instanceId: string) {
  if ((await readInstance(directory))?.instanceId === instanceId) await unlink(join(directory, 'instance.json')).catch(() => {});
}

export class RecentStore {
  private entries: RecentRepository[] = [];
  private writes: Promise<void> = Promise.resolve();
  constructor(private directory: string) {}
  async load() {
    try {
      const value = z.object({ schemaVersion: z.literal(1), repositories: z.array(recentSchema).max(100) }).parse(JSON.parse(await readFile(join(this.directory, 'recents.json'), 'utf8')));
      this.entries = value.repositories;
    } catch (error) {
      this.entries = [];
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await rename(join(this.directory, 'recents.json'), join(this.directory, `recents.corrupt.${Date.now()}.json`)).catch(() => {});
    }
  }
  list() { return [...this.entries]; }
  async add(repository: RepositoryIdentity) {
    this.entries = [{ path: repository.worktreeRoot, worktreeId: repository.worktreeId, openedAt: new Date().toISOString() }, ...this.entries.filter(entry => entry.worktreeId !== repository.worktreeId)].slice(0, 20);
    const snapshot = [...this.entries];
    const write = this.writes.then(() => writePrivateJson(join(this.directory, 'recents.json'), { schemaVersion: 1, repositories: snapshot }));
    this.writes = write.catch(() => {});
    await write;
  }
}
