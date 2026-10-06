import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { recentSchema } from '@git-view/contracts';
import { api, ApiError } from './api';

afterEach(() => vi.unstubAllGlobals());
function response(body: unknown) { vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }))); }
const request = { schemaVersion: 1, action: 'recents', requestId: 'r' } as const;
describe('browser transport validates both envelope and query payload', () => {
  it('refuses incompatible protocol versions instead of showing empty content', async () => {
    response({ schemaVersion: 2, ok: true, data: [] });
    await expect(api(request, z.array(recentSchema))).rejects.toThrow('协议不兼容');
  });
  it('refuses a valid response payload from the wrong query type', async () => {
    response({ schemaVersion: 1, ok: true, data: { alive: true } });
    await expect(api(request, z.array(recentSchema))).rejects.toThrow('不符合此查询');
  });
  it('keeps failure stamps so errors and loading completion use the same gate', async () => {
    const stamp = { sessionId: 's', generation: 2, queryKey: 'q', requestId: 'r', observationId: 'o', startedAt: '2026-10-05T00:00:00Z', finishedAt: '2026-10-05T00:00:01Z' };
    response({ schemaVersion: 1, ok: false, stamp, requestId: 'r', finishedAt: stamp.finishedAt, error: { code: 'REPOSITORY_BUSY', message: '仓库正在变化', retryable: true } });
    try { await api(request, z.array(recentSchema)); throw new Error('expected failure'); }
    catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).stamp).toEqual(stamp); }
  });
});
