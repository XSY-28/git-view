import { transport } from './transport';
import { watchStateSchema, REFRESH_TIMING } from '../../../shared/transport';
import { responseSchema, type ApiRequest, type AppError, type ReadStamp, type RepositorySession, sessionSchema } from '@git-view/contracts';
import { z } from 'zod';

export class ApiError extends Error {
  constructor(public detail: AppError, public stamp?: ReadStamp) { super(detail.message); this.name = 'ApiError'; }
}
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}（${error.detail.code}）`;
  if (error instanceof Error && error.name === 'AbortError') return '读取已取消，可重新读取。';
  if (error instanceof TypeError) return '无法连接本地进程。请在终端重新运行 git-view open --repo <仓库路径>，再打开新的页面。';
  return error instanceof Error ? error.message : '读取失败，请重试。';
}

export async function api<T>(request: ApiRequest, schema: z.ZodType<T>, signal?: AbortSignal): Promise<{ data: T; stamp?: ReadStamp }> {
  const result = responseSchema.safeParse(await transport.request(request, signal));
  if (!result.success) throw new Error('本地进程与页面协议不兼容，请重新构建并启动。');
  if (!result.data.ok) throw new ApiError(result.data.error, result.data.stamp);
  const parsed = schema.safeParse(result.data.data);
  if (!parsed.success) throw new Error('读取结果不符合此查询的数据约定，请重试或更新本地进程。');
  return { data: parsed.data, ...(result.data.stamp ? { stamp: result.data.stamp } : {}) };
}
export async function bootstrap(sessionId: string, ticket: string | null): Promise<RepositorySession | undefined> {
  if (ticket) {
    const auth = responseSchema.safeParse(await transport.authenticate(ticket));
    if (!auth.success) throw new Error('页面授权响应不兼容，请重新运行 git-view open。');
    if (!auth.data.ok) throw new ApiError(auth.data.error);
  }
  if (!sessionId) return undefined;
  const response = responseSchema.safeParse(await transport.session(sessionId));
  if (!response.success) throw new Error('无法识别仓库会话，请重新运行 git-view open。');
  if (!response.data.ok) throw new ApiError(response.data.error);
  return sessionSchema.parse(response.data.data);
}

export function subscribeRepositoryInvalidation(sessionId: string, onInvalidate: () => void, onError: (error: unknown) => void): () => void {
  const controller = new AbortController();
  let revision: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    try {
      const response = responseSchema.or(z.object({ schemaVersion: z.literal(1), ok: z.literal(true), data: watchStateSchema })).parse(await transport.watch(sessionId, controller.signal));
      if (!response.ok) throw new ApiError(response.error);
      const state = watchStateSchema.parse(response.data);
      if (!state.watching) throw new Error('文件监听不可用；返回窗口时仍会刷新，也可手动刷新。');
      if (revision !== undefined && revision !== state.revision) {
        clearTimeout(debounce);
        debounce = setTimeout(() => { if (!controller.signal.aborted) onInvalidate(); }, REFRESH_TIMING.debounceMs);
      }
      revision = state.revision;
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, REFRESH_TIMING.pollMs);
    } catch (error) { if (!controller.signal.aborted) onError(error); }
  };
  void poll();
  return () => { controller.abort(); clearTimeout(timer); clearTimeout(debounce); };
}
