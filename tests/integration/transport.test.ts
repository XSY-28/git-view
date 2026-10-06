import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { QueryError, type ApiResponse, type RepositorySession } from '@git-view/contracts';
import { startLocalServer, type RepositoryQueries } from '../../apps/local/src/server';
import { readInstance, RecentStore } from '../../apps/local/src/storage';
import { verifyInstance } from '../../apps/local/src/runtime';
import { parseArguments, runCli } from '../../apps/cli/src/cli';

const directories: string[] = [];
const servers: Awaited<ReturnType<typeof startLocalServer>>[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 'git-view-transport-')); directories.push(path); return path; }
function queries(): RepositoryQueries {
  const sessions = new Map<string, RepositorySession>();
  return {
    async open(path) {
      const root = path.endsWith('/child') ? path.slice(0, -6) : path;
      const session: RepositorySession = { sessionId: randomUUID(), generation: 0, repository: { repositoryId: `repo:${root}`, worktreeId: `wt:${root}`, worktreeRoot: root, gitDir: `${root}/.git`, commonGitDir: `${root}/.git` } };
      sessions.set(session.sessionId, session); return session;
    },
    getSession(id) { const session = sessions.get(id); if (!session) throw new QueryError('STALE_RESULT', '会话不存在。'); return session; },
    async execute() { return { schemaVersion: 1, ok: true, data: { alive: true } }; },
  };
}
async function setup(options: Partial<Parameters<typeof startLocalServer>[0]> = {}) {
  const server = await startLocalServer({ directory: await directory(), queries: queries(), ...options }); servers.push(server); return server;
}
async function api(server: Awaited<ReturnType<typeof setup>>, action: Record<string, unknown>, headers?: Record<string, string>) {
  return fetch(`${server.origin}/api`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers ?? { Authorization: `Bearer ${server.record.cliToken}` }) }, body: JSON.stringify({ schemaVersion: 1, requestId: randomUUID(), ...action }) });
}
async function createTicket(server: Awaited<ReturnType<typeof setup>>) {
  const opened = await (await api(server, { action: 'open', path: '/example' })).json();
  const ticket = await (await api(server, { action: 'ticket', sessionId: opened.data.sessionId })).json();
  return { session: opened.data as RepositorySession, ticket: ticket.data.ticket as string };
}
async function exchange(server: Awaited<ReturnType<typeof setup>>, ticket: string, origin = server.origin) {
  return fetch(`${server.origin}/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ schemaVersion: 1, ticket }) });
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('loopback capability transport', () => {
  it('rejects missing authentication, forged Origin and forged Host', async () => {
    const server = await setup();
    expect((await api(server, { action: 'recents' }, {})).status).toBe(403);
    expect((await api(server, { action: 'recents' }, { Origin: 'https://evil.example', Authorization: `Bearer ${server.record.cliToken}` })).status).toBe(403);
    const forgedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${server.origin}/health`, { headers: { Host: `evil.example:${server.record.port}`, Authorization: `Bearer ${server.record.cliToken}` } }, response => { response.resume(); resolve(response.statusCode); });
      request.once('error', reject); request.end();
    });
    expect(forgedHostStatus).toBe(403);
    expect((await api(server, { action: 'recents' })).status).toBe(200);
    expect(await verifyInstance(server.record)).toBe(true);
    expect(await verifyInstance({ ...server.record, instanceId: randomUUID() })).toBe(false);
    expect(await verifyInstance({ ...server.record, cliToken: 'wrong'.repeat(10) })).toBe(false);
  });
  it('exchanges a one-use ticket and keeps refresh authenticated without exposing CLI token', async () => {
    const server = await setup(); const { session, ticket } = await createTicket(server);
    const result = await exchange(server, ticket); expect(result.status).toBe(200);
    const cookie = result.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict'); expect(cookie).not.toContain(server.record.cliToken);
    expect((await exchange(server, ticket)).status).toBe(403);
    const browserHeaders = { Cookie: cookie.split(';')[0]!, Origin: server.origin };
    expect((await api(server, { action: 'heartbeat' }, browserHeaders)).status).toBe(200);
    const refresh = await fetch(`${server.origin}/api/session`, { method: 'POST', headers: { ...browserHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, sessionId: session.sessionId }) });
    expect((await refresh.json()).data.sessionId).toBe(session.sessionId);
    expect((await api(server, { action: 'heartbeat' }, { Cookie: cookie })).status).toBe(403);
    expect((await api(server, { action: 'overview', sessionId: 'another-session', generation: 1 }, browserHeaders)).status).toBe(403);
    const restarted = await setup();
    expect((await api(restarted, { action: 'heartbeat' }, { Cookie: cookie, Origin: restarted.origin })).status).toBe(403);
  });
  it('requires exact Origin for exchange and expires tickets after 60 seconds', async () => {
    let now = 1_000; const server = await setup({ now: () => now });
    const { ticket } = await createTicket(server);
    expect((await exchange(server, ticket, 'null')).status).toBe(403);
    now += 60_001;
    expect((await exchange(server, ticket)).status).toBe(403);
  });
  it('preserves authorization for the first tab when opening a second worktree', async () => {
    const server = await setup();
    const first = await createTicket(server);
    const initial = await exchange(server, first.ticket);
    const cookie = initial.headers.get('set-cookie')!.split(';')[0]!;
    const second = await createTicket(server);
    const additional = await fetch(`${server.origin}/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.origin, Cookie: cookie }, body: JSON.stringify({ schemaVersion: 1, ticket: second.ticket }) });
    expect(additional.status).toBe(200);
    expect(additional.headers.get('set-cookie')!.split(';')[0]).toBe(cookie);
    for (const session of [first.session, second.session]) {
      expect((await api(server, { action: 'overview', sessionId: session.sessionId, generation: 1 }, { Origin: server.origin, Cookie: cookie })).status).toBe(200);
    }
  });
  it('rejects schema mismatch and invalid request shapes', async () => {
    const server = await setup();
    const wrongVersion = await (await api(server, { action: 'recents', schemaVersion: 2 })).json();
    expect(wrongVersion.error.code).toBe('VERSION_MISMATCH');
    const invalid = await (await api(server, { action: 'overview', generation: 'bad' })).json();
    expect(invalid.error.code).toBe('INVALID_REQUEST');
    const arbitrary = await (await api(server, { action: 'exec', command: 'git status' })).json();
    expect(arbitrary.error.code).toBe('INVALID_REQUEST');
    const relative = await (await api(server, { action: 'open', path: '.' })).json();
    expect(relative.error.code).toBe('INVALID_REQUEST');
  });
  it('restricts runtime files and persists recents per actual worktree, recovering corruption', async () => {
    const folder = await directory(); const server = await setup({ directory: folder });
    await api(server, { action: 'open', path: '/example' });
    await api(server, { action: 'open', path: '/example/child' });
    await api(server, { action: 'open', path: '/other-worktree' });
    expect(server.recents.list().map(item => item.path)).toEqual(['/other-worktree', '/example']);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((await stat(join(folder, 'instance.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(folder, 'recents.json'))).mode & 0o777).toBe(0o600);
    expect((await readInstance(folder))?.instanceId).toBe(server.record.instanceId);
    await server.close();
    expect(await readInstance(folder)).toBeUndefined();
    const reloaded = new RecentStore(folder); await reloaded.load(); expect(reloaded.list()).toHaveLength(2);
    await writeFile(join(folder, 'recents.json'), 'broken');
    const recovered = new RecentStore(folder); await recovered.load(); expect(recovered.list()).toEqual([]);
  });
  it('serves a static build, refuses traversal and shuts down after idle timeout', async () => {
    const web = await directory(); await writeFile(join(web, 'index.html'), '<html>Git View</html>');
    const server = await setup({ webDirectory: web, idleTimeoutMs: 100 });
    expect(await (await fetch(server.origin)).text()).toContain('Git View');
    expect((await fetch(`${server.origin}/%2e%2e%2fsecret`)).status).toBe(404);
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(await verifyInstance(server.record)).toBe(false);
  });
});

describe('CLI output boundary', () => {
  it('requires explicit absolute paths and rejects unknown options', () => {
    expect(parseArguments(['inspect', '--repo', '/repo with space', '--json']).repo).toBe('/repo with space');
    expect(() => parseArguments(['inspect', '--repo', 'relative'])).toThrow();
    expect(() => parseArguments(['open', '--repo', '/repo', '--view', 'other'])).toThrow();
    expect(() => parseArguments(['inspect', '--repo', '/repo', '--exec', 'status'])).toThrow();
  });
  it('launches with a ticket but prints only a sanitized URL and never claims rendered', async () => {
    const server = await setup(); let output = ''; let launched = '';
    const code = await runCli(['open', '--repo', '/example', '--json'], {
      ensure: async () => server.record,
      launch: async url => { launched = url; return true; }, stdout: text => { output += text; },
    });
    expect(code).toBe(0); expect(launched).toContain('#ticket=');
    const parsed = JSON.parse(output); expect(parsed.url).not.toContain('#'); expect(parsed.launchStatus).toBe('requested'); expect(parsed.rendered).toBe('unverified');
    expect(output).not.toContain(server.record.cliToken); expect(output).not.toContain(launched.split('#ticket=')[1]);
    expect(output.trim().split('\n')).toHaveLength(1);
  });
  it('reports launch failure separately and returns nonzero', async () => {
    const server = await setup(); let output = '';
    const code = await runCli(['open', '--repo', '/example', '--json'], { ensure: async () => server.record, launch: async () => false, stdout: text => { output += text; } });
    expect(code).toBe(1); expect(JSON.parse(output).launchStatus).toBe('failed');
  });
});

describe('authenticated native folder selection', () => {
  it('cannot launch a native dialog without valid local authentication', async () => {
    const pickFolder = vi.fn(async () => ({ cancelled: true as const }));
    const server = await setup({ pickFolder });
    expect((await api(server, { action: 'pick-folder' }, {})).status).toBe(403);
    expect((await api(server, { action: 'pick-folder' }, { Origin: 'https://evil.example', Authorization: `Bearer ${server.record.cliToken}` })).status).toBe(403);
    expect(pickFolder).not.toHaveBeenCalled();
    const valid = await api(server, { action: 'pick-folder' });
    expect((await valid.json()).data).toEqual({ cancelled: true });
    expect(pickFolder).toHaveBeenCalledOnce();
  });
  it('returns the exact selected path, then reuses normal open and browser authorization', async () => {
    const path = '/中文 仓库/line\nbreak';
    const server = await setup({ pickFolder: async () => ({ cancelled: false, path }) });
    const { session, ticket } = await createTicket(server);
    const authorization = await exchange(server, ticket);
    const headers = { Cookie: authorization.headers.get('set-cookie')!.split(';')[0]!, Origin: server.origin };
    const choice = await (await api(server, { action: 'pick-folder' }, headers)).json();
    expect(choice.data).toEqual({ cancelled: false, path });
    expect(server.recents.list()).toHaveLength(1);
    expect(server.recents.list()[0]?.path).toBe(session.repository.worktreeRoot);
    const opened = await (await api(server, { action: 'open', path: choice.data.path }, headers)).json();
    expect(opened.data.repository.worktreeRoot).toBe(path);
    expect((await api(server, { action: 'overview', sessionId: opened.data.sessionId, generation: 0 }, headers)).status).toBe(200);
    expect(server.recents.list()[0]?.path).toBe(path);
  });
  it('cancel preserves the current session and recent list without attempting to open a repository', async () => {
    const repositoryQueries = queries(); const open = vi.spyOn(repositoryQueries, 'open');
    const server = await setup({ queries: repositoryQueries, pickFolder: async () => ({ cancelled: true }) });
    const { session } = await createTicket(server);
    const before = server.recents.list(); const calls = open.mock.calls.length;
    const response = await (await api(server, { action: 'pick-folder' })).json();
    expect(response).toMatchObject({ ok: true, data: { cancelled: true } });
    expect(open).toHaveBeenCalledTimes(calls);
    expect(repositoryQueries.getSession(session.sessionId)).toEqual(session);
    expect(server.recents.list()).toEqual(before);
  });
  it('picker failure leaves manual path opening available and rejects invalid returned paths', async () => {
    const unavailable = await setup();
    expect((await (await api(unavailable, { action: 'pick-folder' })).json()).error.code).toBe('PICKER_UNAVAILABLE');
    expect((await (await api(unavailable, { action: 'open', path: '/example' })).json()).ok).toBe(true);
    const invalid = await setup({ pickFolder: async () => ({ cancelled: false, path: 'relative' }) });
    expect((await (await api(invalid, { action: 'pick-folder' })).json()).error.code).toBe('PICKER_UNAVAILABLE');
    expect(invalid.recents.list()).toEqual([]);
  });
  it('disconnecting the browser aborts the native request', async () => {
    let notifyStarted!: () => void; let notifyAborted!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const aborted = new Promise<void>(resolve => { notifyAborted = resolve; });
    const server = await setup({ pickFolder: signal => new Promise((resolve, reject) => {
      signal!.addEventListener('abort', () => { notifyAborted(); reject(new QueryError('CANCELLED', '选择已取消。')); }, { once: true });
      notifyStarted();
    }) });
    const controller = new AbortController();
    const request = fetch(`${server.origin}/api`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.record.cliToken}` }, body: JSON.stringify({ schemaVersion: 1, requestId: 'cancel-picker', action: 'pick-folder' }) }).catch(() => undefined);
    await started; controller.abort(); await request; await aborted;
    expect(server.recents.list()).toEqual([]);
  });
});
