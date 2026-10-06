import type { ApiRequest } from '@git-view/contracts';

interface TauriBridge {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> };
}
declare global { interface Window { __TAURI__?: TauriBridge } }
async function post(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const result = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  return result.json().catch(() => { throw new Error('本地进程返回了无法识别的数据，请重新启动。'); });
}
async function desktop(message: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const bridge = window.__TAURI__!;
  const id = crypto.randomUUID();
  signal?.throwIfAborted();
  let rejectAbort: (reason: unknown) => void = () => {};
  const abort = () => {
    void bridge.core.invoke('query', { message: { id: crypto.randomUUID(), operation: 'cancel', targetId: id } }).catch(() => undefined);
    rejectAbort(new DOMException('读取已取消', 'AbortError'));
  };
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
  signal?.addEventListener('abort', abort, { once: true });
  try { return await Promise.race([bridge.core.invoke('query', { message: { id, ...message } }), cancelled]); }
  finally { signal?.removeEventListener('abort', abort); }
}
const hasDesktop = () => typeof window !== 'undefined' && window.__TAURI__ !== undefined;
export const transport = {
  request: (request: ApiRequest, signal?: AbortSignal) => hasDesktop() ? desktop({ operation: 'request', request }, signal) : post('/api', request, signal),
  session: (sessionId: string) => hasDesktop() ? desktop({ operation: 'session', sessionId }) : post('/api/session', { schemaVersion: 1, sessionId }),
  watch: (sessionId: string, signal?: AbortSignal) => hasDesktop() ? desktop({ operation: 'watch', sessionId }, signal) : post('/api/watch', { schemaVersion: 1, sessionId }, signal),
  authenticate: (ticket: string) => post('/auth', { schemaVersion: 1, ticket }),
};
/** Listen before consuming the one-time startup path, so a second CLI open cannot be lost. */
export async function connectDesktopOpen() {
  const bridge = window.__TAURI__;
  if (!bridge) return;
  const deliver = ({ path }: { path: string }) => window.dispatchEvent(new CustomEvent('git-view:open-repository', { detail: { path } }));
  const unlisten = await bridge.event.listen<{ path: string }>('open-repository', event => deliver(event.payload));
  const initial = await bridge.core.invoke<string | null>('initial_repository');
  if (initial) deliver({ path: initial });
  return unlisten;
}
