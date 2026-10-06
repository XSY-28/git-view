import { z } from 'zod';
import { QueryError, requestSchema, operationRequestSchema } from '@git-view/contracts';
import { createLocalService, failure, success, type RepositoryQueries } from './service';
import type { Readable, Writable } from 'node:stream';

const id = z.string().min(1).max(200);
const envelopeSchema = z.discriminatedUnion('operation', [
  z.object({ id, operation: z.literal('request'), request: requestSchema }).strict(),
  z.object({ id, operation: z.literal('write'), request: operationRequestSchema }).strict(),
  z.object({ id, operation: z.literal('session'), sessionId: id }).strict(),
  z.object({ id, operation: z.literal('watch'), sessionId: id }).strict(),
  z.object({ id, operation: z.literal('cancel'), targetId: id }).strict(),
]);
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT = 64;
/** One authenticated parent process owns this channel. Never listen on a network port. */
export async function runStdio(queries: RepositoryQueries, directory: string, input: Readable, output: Writable, options: { allowWrites?: boolean } = {}) {
  const service = await createLocalService(queries, directory);
  const pending = new Map<string, AbortController>();
  let buffer = Buffer.alloc(0); let closed = false;
  const send = (id: string, response: unknown) => { if (!closed) output.write(`${JSON.stringify({ id, response })}\n`); };
  const dispatch = async (line: Buffer) => {
    let envelope: z.infer<typeof envelopeSchema>; let requestId = 'transport';
    try {
      const raw: unknown = JSON.parse(line.toString('utf8'));
      if (raw && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string') requestId = raw.id.slice(0, 200);
      const parsed = envelopeSchema.safeParse(raw);
      if (!parsed.success) throw new QueryError('INVALID_REQUEST', '桌面请求格式无效。');
      envelope = parsed.data;
      if (envelope.operation === 'write' && !options.allowWrites) throw new QueryError('UNAUTHORIZED', '此查询通道没有写入权限。');
      if (envelope.operation === 'cancel') { pending.get(envelope.targetId)?.abort(); send(envelope.id, success({ alive: true })); return; }
      if (pending.has(envelope.id) || pending.size >= MAX_IN_FLIGHT) throw new QueryError('INVALID_REQUEST', '桌面请求重复或并发请求过多。');
      const controller = new AbortController(); pending.set(envelope.id, controller);
      try {
        const response = envelope.operation === 'session' ? service.session(envelope.sessionId)
          : envelope.operation === 'watch' ? service.watch(envelope.sessionId)
          : envelope.operation === 'write' ? await service.operation(envelope.request, controller.signal)
          : await service.request(envelope.request, controller.signal);
        send(envelope.id, response);
      } finally { pending.delete(envelope.id); }
    } catch (error) { send(requestId, failure(error, requestId)); }
  };
  const close = () => { closed = true; for (const controller of pending.values()) controller.abort(); service.close(); };
  input.on('data', (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    let index: number;
    while ((index = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, index); buffer = buffer.subarray(index + 1);
      if (line.length > MAX_LINE_BYTES) { send('transport', failure(new QueryError('OUTPUT_LIMIT', '桌面请求超过限制。'))); close(); input.destroy(); return; }
      if (line.length) void dispatch(line);
    }
    if (buffer.length > MAX_LINE_BYTES) { send('transport', failure(new QueryError('OUTPUT_LIMIT', '桌面请求超过限制。'))); close(); input.destroy(); }
  });
  input.once('end', close); input.once('error', close);
  output.once('error', close);
  return { close };
}
