import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import { folderChoiceSchema, QueryError, type FolderChoice } from '@git-view/contracts';

export interface NativePickerLimits {
  timeoutMs?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
}

/** One helper belongs to one picker invocation; the gate opens only after that child exits. */
export function createNativeFolderPicker(executable: string, platform: NodeJS.Platform = process.platform, limits: NativePickerLimits = {}): (signal?: AbortSignal) => Promise<FolderChoice> {
  let busy = false;
  const timeoutMs = limits.timeoutMs ?? 5 * 60_000;
  const maxOutputBytes = limits.maxOutputBytes ?? 32 * 1024;
  const killGraceMs = limits.killGraceMs ?? 250;
  const unavailable = () => new QueryError('PICKER_UNAVAILABLE', '系统文件夹选择器无法启动。请重新构建本地应用，或手动输入仓库的绝对路径。', true);
  return async (signal?: AbortSignal) => {
    if (signal?.aborted) throw new QueryError('CANCELLED', '文件夹选择已取消。', true);
    if (busy) throw new QueryError('PICKER_BUSY', '已有文件夹选择窗口打开，请先完成或取消该窗口。', true);
    if (platform !== 'darwin' || !isAbsolute(executable)) throw unavailable();
    busy = true;
    return new Promise<FolderChoice>((resolveChoice, reject) => {
      let child;
      try { child = spawn(executable, [], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { busy = false; reject(unavailable()); return; }
      const chunks: Buffer[] = [];
      let outputBytes = 0;
      let failure: QueryError | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (error: QueryError) => {
        if (failure) return;
        failure = error;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => { child.kill('SIGKILL'); }, killGraceMs);
        killTimer.unref();
      };
      const abort = () => stop(new QueryError('CANCELLED', '文件夹选择已取消。', true));
      const timeout = setTimeout(() => stop(new QueryError('TIMEOUT', '文件夹选择等待超时，请重新打开选择器。', true)), timeoutMs);
      timeout.unref();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const receive = (chunk: Buffer, stdout: boolean) => {
        if (failure) return;
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) { stop(new QueryError('OUTPUT_LIMIT', '文件夹选择器返回的数据超出限制，请改用手动输入路径。')); return; }
        if (stdout) chunks.push(chunk);
      };
      child.stdout!.on('data', (chunk: Buffer) => receive(chunk, true));
      child.stderr!.on('data', (chunk: Buffer) => receive(chunk, false));
      child.once('error', () => { failure ??= unavailable(); });
      child.once('close', code => {
        clearTimeout(timeout); if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        busy = false;
        if (failure) { reject(failure); return; }
        if (code !== 0) { reject(unavailable()); return; }
        try {
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          const result = folderChoiceSchema.safeParse(JSON.parse(decoded));
          if (!result.success || (!result.data.cancelled && (!isAbsolute(result.data.path) || result.data.path.includes('\0')))) { reject(unavailable()); return; }
          resolveChoice(result.data);
        } catch { reject(unavailable()); }
      });
    });
  };
}
