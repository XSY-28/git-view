import { spawn } from 'node:child_process';
import { devNull } from 'node:os';
import { QueryError, type RepositoryIdentity } from '@git-view/contracts';

/** Private plumbing boundary. There is deliberately no API accepting user commands. */
export function runPlumbing(repository: RepositoryIdentity, args: string[], options: { input?: Buffer; index?: string; signal?: AbortSignal; allowMissing?: boolean } = {}): Promise<Buffer> {
  const exact = (expected: string[]) => args.length === expected.length && args.every((value, i) => value === expected[i]);
  const allowed = exact(['config', '--null', '--list', '--show-origin', '--includes'])
    || exact(['rev-parse', '--verify', '--quiet', 'HEAD']) || exact(['rev-parse', '--show-object-format'])
    || exact(['ls-files', '--stage', '-z']) || exact(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    || (args.length === 5 && exact(['ls-tree', '-r', '-z', '--full-tree', args[4]!]) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(args[4]!))
    || [false, true].some((cached) => ['filter', 'all'].some((selection) => exact(['check-attr', '-z', ...(cached ? ['--cached'] : []), '--stdin', ...(selection === 'filter' ? ['filter'] : ['filter', 'text', 'eol', 'ident', 'working-tree-encoding'])])))
    || exact(['hash-object', '-w', '--stdin', '--no-filters'])
    || exact(['update-index', '--add', '--remove', '-z', '--index-info']);
  if (!allowed || (args[0] === 'update-index' && !options.index)) throw new QueryError('INTERNAL_ERROR', '拒绝未授权的 Git 写入命令。');
  if (options.signal?.aborted) return Promise.reject(new QueryError('CANCELLED', '操作已取消。'));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  Object.assign(env, { GIT_DIR: repository.gitDir, GIT_WORK_TREE: repository.worktreeRoot, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C', LANG: 'C', ...(options.index ? { GIT_INDEX_FILE: options.index } : {}) });
  const fixed = ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.splitIndex=false', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...fixed, ...args], { cwd: repository.worktreeRoot, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, failure: QueryError | undefined;
    const stop = (error: QueryError) => { failure ??= error; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop(new QueryError('TIMEOUT', 'Git 暂存操作超时。')), 30_000);
    const abort = () => stop(new QueryError('CANCELLED', '操作已取消。'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const collect = (target: Buffer[], value: Buffer) => { bytes += value.length; if (bytes > 32 * 1024 * 1024) stop(new QueryError('OUTPUT_LIMIT', 'Git 输出超过安全上限。')); else target.push(value); };
    child.stdout.on('data', (value: Buffer) => collect(stdout, value));
    child.stderr.on('data', (value: Buffer) => collect(stderr, value));
    child.on('error', (error: NodeJS.ErrnoException) => { failure = new QueryError(error.code === 'ENOENT' ? 'GIT_NOT_FOUND' : 'PERMISSION_DENIED', '无法启动 Git 暂存操作。'); });
    child.on('close', (code) => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      if (code === 0 || (options.allowMissing && code === 1)) return resolve(Buffer.concat(stdout));
      const message = Buffer.concat(stderr).toString('utf8').slice(0, 2000).trim();
      reject(new QueryError(/index\.lock|another git process/i.test(message) ? 'REPOSITORY_BUSY' : 'INTERNAL_ERROR', message || 'Git 暂存操作失败。'));
    });
    child.stdin.on('error', () => { /* close reports early exit */ });
    child.stdin.end(options.input);
  });
}
