import { spawn } from 'node:child_process';
import { OPERATION_LIMITS, QueryError, type RepositoryIdentity } from '@git-view/contracts';

export type RepositoryCommand =
  | { kind: 'commit'; message: string }
  | { kind: 'create-branch'; branch: string; oid: string }
  | { kind: 'switch-branch'; branch: string };
export type CommandResult = { code: number | null; diagnostic: string; interrupted: boolean };

/** Only these three operations may run repository hooks. No shell or caller options. */
export function runRepositoryCommand(repository: RepositoryIdentity, command: RepositoryCommand, marker: string, timeoutMs: number = OPERATION_LIMITS.executionTimeoutMs): Promise<CommandResult> {
  const args = command.kind === 'commit' ? ['commit', '--file=-', '--cleanup=verbatim', '--no-status']
    : command.kind === 'create-branch' ? ['update-ref', '--no-deref', '--create-reflog', '-m', marker, '--stdin']
      : ['switch', '--no-guess', '--no-recurse-submodules', '--no-overwrite-ignore', '--', command.branch];
  const input = command.kind === 'commit' ? command.message : command.kind === 'create-branch' ? `create refs/heads/${command.branch} ${command.oid}\n` : undefined;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  Object.assign(env, { GIT_DIR: repository.gitDir, GIT_WORK_TREE: repository.worktreeRoot, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_EDITOR: 'false', GIT_SEQUENCE_EDITOR: 'false', GIT_REFLOG_ACTION: marker, LC_ALL: 'C', LANG: 'C' });
  return new Promise((resolve, reject) => {
    // A timed-out hook/signer must not keep writing after its Git parent is killed.
    const child = spawn('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-c', 'core.logAllRefUpdates=true', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd: repository.worktreeRoot, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let diagnostic = '', size = 0, interrupted = false, spawnError: Error | undefined;
    const stop = () => {
      interrupted = true;
      if (!child.pid) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ }
    };
    const timer = setTimeout(stop, timeoutMs);
    const collect = (chunk: Buffer) => { size += chunk.length; diagnostic = (diagnostic + chunk.toString('utf8')).slice(-8000); if (size > 1024 * 1024) stop(); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => { spawnError = error; });
    child.once('close', code => {
      clearTimeout(timer);
      if (spawnError) reject(new QueryError('INTERNAL_ERROR', `无法启动 Git：${spawnError.message}`));
      else resolve({ code, diagnostic: `${interrupted ? 'Git 或其 hooks/签名程序超时或输出超限，已终止进程组。\n' : ''}${diagnostic.trim()}`, interrupted });
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
