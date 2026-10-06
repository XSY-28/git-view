import { summarizeOverview } from './inspection';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { QueryError, overviewSchema, sessionSchema, toAppError, type ApiRequest, type ApiResponse } from '@git-view/contracts';
import { callInstance, ensureInstance, instanceOrigin, verifyInstance } from '../../local/src/runtime';
import { dataDirectory, readInstance, type InstanceRecord } from '../../local/src/storage';

type Arguments = { command: 'open' | 'inspect' | 'shutdown'; repo?: string; json: boolean; noBrowser: boolean };
export function parseArguments(args: string[]): Arguments {
  const command = args[0];
  if (command !== 'open' && command !== 'inspect' && command !== 'shutdown') throw new QueryError('INVALID_REQUEST', '用法：git-view open|inspect --repo <absolute-path> [--json]；git-view shutdown [--json]。');
  const parsed: Arguments = { command, json: false, noBrowser: false };
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (seen.has(arg)) throw new QueryError('INVALID_REQUEST', `重复参数：${arg}`); seen.add(arg);
    if (arg === '--json') parsed.json = true;
    else if (arg === '--no-browser' && command === 'open') parsed.noBrowser = true;
    else if (arg === '--repo' && command !== 'shutdown') {
      const value = args[++index];
      if (!value || !isAbsolute(value) || value.includes('\0')) throw new QueryError('INVALID_REQUEST', '--repo 必须是明确的本机绝对路径。');
      parsed.repo = value;
    } else if (arg === '--view' && command === 'open') {
      if (args[++index] !== 'changes') throw new QueryError('INVALID_REQUEST', '当前只支持 --view changes。');
    } else throw new QueryError('INVALID_REQUEST', `未知参数：${arg}`);
  }
  if (command !== 'shutdown' && !parsed.repo) throw new QueryError('INVALID_REQUEST', '缺少 --repo；请明确当前会话的仓库或 worktree 路径。');
  return parsed;
}
async function launchBrowser(url: string): Promise<boolean> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: 'ignore', shell: false });
    child.once('error', () => resolve(false));
    child.once('exit', code => resolve(code === 0));
  });
}
function valueOf(result: ApiResponse): unknown {
  if (!result.ok) throw new QueryError(result.error.code, result.error.message, result.error.retryable);
  return result.data;
}
export type CliDependencies = {
  ensure?: () => Promise<InstanceRecord>;
  call?: (record: InstanceRecord, request: ApiRequest) => Promise<ApiResponse>;
  launch?: (url: string) => Promise<boolean>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};
export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? (text => process.stdout.write(text));
  const stderr = dependencies.stderr ?? (text => process.stderr.write(text));
  let parsed: Arguments | undefined;
  try {
    parsed = parseArguments(args);
    const call = dependencies.call ?? callInstance;
    const base = () => ({ schemaVersion: 1 as const, requestId: randomUUID() });
    let result: unknown;
    if (parsed.command === 'shutdown') {
      const record = await readInstance(dataDirectory());
      if (record && await verifyInstance(record)) valueOf(await call(record, { ...base(), action: 'shutdown' }));
      result = { schemaVersion: 1, ok: true, action: 'shutdown', running: false };
    } else {
      const record = await (dependencies.ensure ?? ensureInstance)();
      const session = sessionSchema.parse(valueOf(await call(record, { ...base(), action: 'open', path: parsed.repo! })));
      if (parsed.command === 'inspect') {
        const overview = overviewSchema.parse(valueOf(await call(record, { ...base(), action: 'overview', sessionId: session.sessionId, generation: session.generation + 1 })));
        result = summarizeOverview(overview);
      } else {
        const url = `${instanceOrigin(record)}/?session=${encodeURIComponent(session.sessionId)}`;
        let launchStatus: 'requested' | 'failed' | 'skipped' = 'skipped';
        if (!parsed.noBrowser) {
          const ticketResult = valueOf(await call(record, { ...base(), action: 'ticket', sessionId: session.sessionId }));
          if (!ticketResult || typeof ticketResult !== 'object' || !('ticket' in ticketResult) || typeof ticketResult.ticket !== 'string') throw new QueryError('INVALID_REQUEST', '页面授权票据响应无效。');
          launchStatus = await (dependencies.launch ?? launchBrowser)(`${url}#ticket=${encodeURIComponent(ticketResult.ticket)}`) ? 'requested' : 'failed';
        }
        result = { schemaVersion: 1, ok: launchStatus !== 'failed', action: 'open', worktreeId: session.repository.worktreeId, worktreeRoot: session.repository.worktreeRoot, sessionId: session.sessionId, url, launchStatus, rendered: 'unverified', ...(launchStatus === 'failed' ? { error: { code: 'INTERNAL_ERROR', message: '浏览器打开请求失败，请重试 git-view open。', retryable: true } } : {}) };
        if (launchStatus === 'failed') { stdout(`${JSON.stringify(result)}\n`); return 1; }
      }
    }
    stdout(`${JSON.stringify(result, null, parsed.json ? undefined : 2)}\n`);
    return 0;
  } catch (error) {
    const failure = { schemaVersion: 1, ok: false, error: toAppError(error) };
    stdout(`${JSON.stringify(failure)}\n`);
    if (!args.includes('--json')) stderr(`${failure.error.message}\n`);
    return 1;
  }
}
