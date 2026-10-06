import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { QueryError, type ErrorCode } from '@git-view/contracts';
import { DEFAULT_READ_LIMITS } from './limits.js';

export class GitReadError extends QueryError {
  constructor(code: ErrorCode, message: string, retryable = false) {
    super(code, message, retryable);
    this.name = 'GitReadError';
  }
}

export interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  stderrPreviewChars?: number;
  allowedExitCodes?: number[];
  input?: Buffer;
}

const commands = new Set(['rev-parse', 'symbolic-ref', 'config', 'status', 'diff', 'diff-tree', 'log', 'for-each-ref', 'cat-file', 'ls-files', 'ls-tree', 'check-attr', 'worktree', 'check-ref-format']);

/** The sole subprocess boundary. Never takes shell text or mutating Git commands. */
export function runGit(cwd: string, args: string[], options: RunOptions = {}): Promise<Buffer> {
  if (!args[0] || !commands.has(args[0])) throw new GitReadError('INTERNAL_ERROR', '拒绝未授权的 Git 查询。');
  if (args[0] === 'worktree' && (args[1] !== 'list' || args.some(arg => !['worktree', 'list', '--porcelain', '-z'].includes(arg)))) throw new GitReadError('INTERNAL_ERROR', 'worktree 仅允许读取列表。');
  if (options.signal?.aborted) return Promise.reject(new GitReadError('CANCELLED', '读取已取消。'));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Inherited repository selectors, config injections and tracing can redirect reads or write logs.
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
    GIT_PAGER: 'cat', LC_ALL: 'C', LANG: 'C',
  });
  const globalArgs = [
    '--no-pager', '--no-optional-locks', '--literal-pathspecs',
    '-c', 'color.ui=false', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'submodule.recurse=false',
    '-c', 'status.submoduleSummary=false', '-c', 'diff.submodule=short', '-c', 'log.showSignature=false',
    '-c', 'i18n.logOutputEncoding=utf-8', '-c', 'protocol.allow=never',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...globalArgs, ...args], { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let stopped: GitReadError | undefined;
    const stop = (error: GitReadError) => { stopped ??= error; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop(new GitReadError('TIMEOUT', 'Git 读取超时，请重试。', true)), options.timeoutMs ?? DEFAULT_READ_LIMITS.timeoutMs);
    const onAbort = () => stop(new GitReadError('CANCELLED', '读取已取消。'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const collect = (target: Buffer[], data: Buffer) => {
      bytes += data.length;
      if (bytes > (options.maxOutputBytes ?? DEFAULT_READ_LIMITS.maxOutputBytes)) stop(new GitReadError('OUTPUT_LIMIT', 'Git 输出超过安全上限，未解析不完整的结果。'));
      else target.push(data);
    };
    child.stdout.on('data', (data: Buffer) => collect(stdout, data));
    child.stderr.on('data', (data: Buffer) => collect(stderr, data));
    child.on('error', (error: NodeJS.ErrnoException) => {
      const missingRepository = error.code === 'ENOENT' && !existsSync(cwd);
      stopped = new GitReadError(missingRepository ? 'INVALID_REPOSITORY' : error.code === 'ENOENT' ? 'GIT_NOT_FOUND' : error.code === 'EACCES' ? 'PERMISSION_DENIED' : 'INTERNAL_ERROR', missingRepository ? '仓库目录已经不存在，请重新选择仓库。' : error.code === 'ENOENT' ? '找不到系统 Git，请先安装 Git。' : `无法启动 Git：${error.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (stopped) return reject(stopped);
      if ((options.allowedExitCodes ?? [0]).includes(code ?? -1)) return resolve(Buffer.concat(stdout));
      const message = Buffer.concat(stderr).toString('utf8').trim().slice(0, options.stderrPreviewChars ?? DEFAULT_READ_LIMITS.stderrPreviewChars);
      const errorCode = /dubious ownership|Permission denied|Operation not permitted/i.test(message) ? 'PERMISSION_DENIED'
        : /index\.lock|Unable to create.*lock|another git process/i.test(message) ? 'REPOSITORY_BUSY'
          : /not a git repository|cannot change to|No such file or directory/i.test(message) ? 'INVALID_REPOSITORY'
            : /bad (?:tree |commit |tag )?object|missing|unable to read|not a valid object|bad revision|invalid object|could not fetch/i.test(message) ? 'OBJECT_UNAVAILABLE'
              : 'INTERNAL_ERROR';
      reject(new GitReadError(errorCode, message || `Git 读取失败（退出码 ${code ?? 'unknown'}）。`, errorCode === 'REPOSITORY_BUSY'));
    });
    child.stdin.on('error', () => { /* Early exit is handled by close; EPIPE adds no information. */ });
    child.stdin.end(options.input);
  });
}
