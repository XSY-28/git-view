import { execFile } from 'node:child_process';
import { constants, type Stats } from 'node:fs';
import { lstat, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { QueryError } from '@git-view/contracts';
export function windowsHelper(): string | undefined {
  const helper = process.env.GIT_VIEW_NATIVE_HELPER;
  return helper && path.isAbsolute(helper) ? helper : undefined;
}
export function windowsPlatform<T>(request: Record<string, unknown>, env = process.env): Promise<T> {
  const helper = windowsHelper();
  if (!helper) throw new QueryError('UNSUPPORTED_REPOSITORY', 'Windows 写入需要桌面原生组件，请使用完整安装包。');
  return new Promise((resolve, reject) => {
    const child = execFile(helper, ['--windows-platform'], { env, windowsHide: true, timeout: 150_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new QueryError('INTERNAL_ERROR', `Windows 原生操作失败：${error.message}`));
      try {
        const result = JSON.parse(stdout);
        if (result.ok !== true) throw new QueryError('PERMISSION_DENIED', String(result.error));
        resolve(result.data);
      } catch (failure) { reject(failure); }
    });
    child.stdin?.on('error', () => {}); child.stdin?.end(JSON.stringify(request));
  });
}
export async function privateDirectoryPermissions(directory: string): Promise<void> {
  await windowsPlatform({ operation: 'private-directory', path: directory });
}
export async function checkPrivate(file: string, stat: Stats, directory: boolean): Promise<void> {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new QueryError('PERMISSION_DENIED', '操作回执路径不是普通文件或目录。');
  if (process.platform === 'win32') await windowsPlatform({ operation: 'check-private', path: file });
  else if ((process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new QueryError('PERMISSION_DENIED', '操作回执目录或文件不安全。');
}
export async function syncDirectory(directory: string): Promise<void> {
  // Windows publishes replacement files with MOVEFILE_WRITE_THROUGH. Pending
  // marker/lock deletion is conservative: a surviving marker is reconciled from
  // the flushed receipt; never use the POSIX directory-fsync API on Windows.
  if (process.platform === 'win32') return;
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function replaceFile(source: string, target: string): Promise<void> {
  if (process.platform === 'win32') await windowsPlatform({ operation: 'replace', path: source, target });
  else await rename(source, target);
}
export async function openRead(file: string) {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new QueryError('PERMISSION_DENIED', '拒绝读取链接或特殊元数据文件。');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) throw new QueryError('STALE_RESULT', '元数据路径已变化。');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
