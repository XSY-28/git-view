import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { QueryError, folderChoiceSchema, requestSchema, type FolderChoice, type RepositorySession } from '@git-view/contracts';
import { removeOwnInstance, writePrivateJson, type InstanceRecord } from './storage';

import { createLocalService, failure, success, type RepositoryQueries } from './service';
export type { RepositoryQueries } from './service';
export interface LocalServerOptions {
  queries: RepositoryQueries;
  directory: string;
  webDirectory?: string;
  idleTimeoutMs?: number;
  ticketLifetimeMs?: number;
  now?: () => number;
  persist?: boolean;
  pickFolder?: (signal?: AbortSignal) => Promise<FolderChoice>;
}
const forbidden = () => new QueryError('UNAUTHORIZED', '页面授权无效或已过期，请重新执行 git-view open。');
function equal(a: string, b: string) { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new QueryError('INVALID_REQUEST', '请求必须使用 application/json。');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new QueryError('OUTPUT_LIMIT', '请求超过 1 MiB 限制。');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new QueryError('INVALID_REQUEST', '请求不是有效 JSON。'); }
}
function version(value: unknown) {
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion !== 1) throw new QueryError('VERSION_MISMATCH', '协议版本不兼容，请更新 CLI 与本地进程。');
}
function respond(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

export async function startLocalServer(options: LocalServerOptions) {
  const service = await createLocalService(options.queries, options.directory);
  const now = options.now || Date.now;
  const instanceId = randomUUID();
  const cliToken = randomBytes(32).toString('base64url');
  const cookieName = `git_view_${instanceId.replaceAll('-', '')}`;
  const tickets = new Map<string, { sessionId: string; expires: number }>();
  const browsers = new Map<string, Set<string>>();
  const pickerLifetime = new AbortController();
  let lastActivity = now(); let origin = ''; let closing: Promise<void> | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const close = () => closing ||= new Promise<void>(resolveClose => {
    if (idleTimer) clearInterval(idleTimer);
    tickets.clear(); browsers.clear();
    pickerLifetime.abort();
    service.close();
    server.close(() => { void removeOwnInstance(options.directory, instanceId).finally(resolveClose); });
    server.closeIdleConnections();
  });
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let requestId = 'transport';
    const controller = new AbortController();
    request.once('aborted', () => controller.abort());
    response.once('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      if (request.headers.host !== new URL(origin).host) throw forbidden();
      const suppliedOrigin = request.headers.origin;
      if (suppliedOrigin !== undefined && suppliedOrigin !== origin) throw forbidden();
      const url = new URL(request.url || '/', origin);
      const isCli = equal(request.headers.authorization || '', `Bearer ${cliToken}`);
      const cookieHeader = request.headers.cookie || '';
      const cookieValue = cookieHeader.split(';').map(pair => pair.trim()).find(pair => pair.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      const browserSessions = cookieValue ? browsers.get(cookieValue) : undefined;
      const authenticated = isCli || (suppliedOrigin === origin && browserSessions !== undefined);
      const requireAuthentication = () => { if (!authenticated || (!suppliedOrigin && !isCli)) throw forbidden(); lastActivity = now(); };
      const allowSession = (sessionId: string) => { if (!isCli && !browserSessions?.has(sessionId)) throw forbidden(); };
      if (request.method === 'POST' && url.pathname === '/auth') {
        if (suppliedOrigin !== origin) throw forbidden();
        const body = await jsonBody(request); version(body);
        const parsed = z.object({ schemaVersion: z.literal(1), ticket: z.string().min(1).max(200) }).strict().safeParse(body);
        if (!parsed.success) throw new QueryError('INVALID_REQUEST', '授权请求格式无效。');
        const ticket = tickets.get(parsed.data.ticket); tickets.delete(parsed.data.ticket);
        if (!ticket || ticket.expires <= now()) throw forbidden();
        const session = options.queries.getSession(ticket.sessionId);
        const cookie = cookieValue && browserSessions ? cookieValue : randomBytes(32).toString('base64url');
        const allowedSessions = browserSessions ?? new Set<string>();
        allowedSessions.add(ticket.sessionId); browsers.set(cookie, allowedSessions);
        response.setHeader('Set-Cookie', `${cookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=/`);
        lastActivity = now(); respond(response, 200, success(session)); return;
      }
      if (url.pathname === '/health' && request.method === 'GET') {
        if (!isCli) throw forbidden();
        lastActivity = now(); respond(response, 200, { schemaVersion: 1, instanceId, alive: true }); return;
      }
      if ((url.pathname === '/api/session' || url.pathname === '/api/watch') && (request.method === 'GET' || request.method === 'POST')) {
        requireAuthentication();
        let sessionId = url.searchParams.get('sessionId');
        if (request.method === 'POST') {
          const body = await jsonBody(request); version(body);
          const parsed = z.object({ schemaVersion: z.literal(1), sessionId: z.string().min(1) }).strict().safeParse(body);
          if (!parsed.success) throw new QueryError('INVALID_REQUEST', '会话请求格式无效。');
          sessionId = parsed.data.sessionId;
        }
        if (!sessionId) throw new QueryError('INVALID_REQUEST', '缺少会话标识。');
        allowSession(sessionId); respond(response, 200, url.pathname === '/api/watch' ? service.watch(sessionId) : service.session(sessionId)); return;
      }
      if (url.pathname === '/api' && request.method === 'POST') {
        requireAuthentication();
        const body = await jsonBody(request); version(body);
        const parsed = requestSchema.safeParse(body);
        if (!parsed.success) throw new QueryError('INVALID_REQUEST', '请求字段无效或缺失。');
        const action = parsed.data; requestId = action.requestId;
        if ('sessionId' in action) allowSession(action.sessionId);
        if (action.action === 'recents') { respond(response, 200, await service.request(action, controller.signal)); return; }
        if (action.action === 'heartbeat') { respond(response, 200, success({ alive: true })); return; }
        if (action.action === 'pick-folder') {
          if (!options.pickFolder) throw new QueryError('PICKER_UNAVAILABLE', '当前环境无法打开系统文件夹选择窗口，请手动输入仓库路径。');
          const choice = folderChoiceSchema.parse(await options.pickFolder(AbortSignal.any([controller.signal, pickerLifetime.signal])));
          if (!choice.cancelled && (!isAbsolute(choice.path) || choice.path.includes('\0'))) throw new QueryError('PICKER_UNAVAILABLE', '文件夹选择窗口未返回有效路径，请重试或手动输入路径。');
          respond(response, 200, success(choice)); return;
        }
        if (action.action === 'shutdown') {
          respond(response, 200, success({ alive: false })); setImmediate(() => { void close(); }); return;
        }
        if (action.action === 'ticket') {
          if (!isCli) throw forbidden();
          options.queries.getSession(action.sessionId);
          for (const [key, value] of tickets) if (value.expires <= now()) tickets.delete(key);
          const ticket = randomBytes(32).toString('base64url');
          tickets.set(ticket, { sessionId: action.sessionId, expires: now() + (options.ticketLifetimeMs ?? 60_000) });
          respond(response, 200, success({ ticket })); return;
        }
        const result = await service.request(action, controller.signal);
        if (action.action === 'open' && result.ok) browserSessions?.add((result.data as RepositorySession).sessionId);
        respond(response, 200, result); return;
      }
      if (url.pathname.startsWith('/api') || url.pathname === '/auth' || url.pathname === '/health') { respond(response, 404, failure(new QueryError('INVALID_REQUEST', '未知接口。'))); return; }
      if (request.method !== 'GET' && request.method !== 'HEAD') { respond(response, 405, failure(new QueryError('INVALID_REQUEST', '不支持的请求方式。'))); return; }
      if (!options.webDirectory) { response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('界面构建产物缺失，请运行 pnpm build。'); return; }
      const root = await realpath(options.webDirectory);
      const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const path = await realpath(resolve(root, requested)).catch(() => null);
      if (!path || !path.startsWith(`${root}${sep}`)) { response.writeHead(404); response.end(); return; }
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2' };
      const content = await readFile(path);
      response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      const result = failure(error, requestId);
      respond(response, !result.ok && result.error.code === 'UNAUTHORIZED' ? 403 : 400, result);
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolveListen(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法启动本地监听。');
  origin = `http://127.0.0.1:${address.port}`;
  const record: InstanceRecord = { schemaVersion: 1, instanceId, port: address.port, cliToken, pid: process.pid, startedAt: new Date(now()).toISOString() };
  try {
    if (options.persist !== false) await writePrivateJson(join(options.directory, 'instance.json'), record);
  } catch (error) { await close(); throw error; }
  const timeout = options.idleTimeoutMs ?? 30 * 60_000;
  idleTimer = setInterval(() => { if (now() - lastActivity >= timeout) void close(); }, Math.min(timeout, 30_000));
  idleTimer.unref();
  return { server, origin, record, close, recents: service.recents };
}
