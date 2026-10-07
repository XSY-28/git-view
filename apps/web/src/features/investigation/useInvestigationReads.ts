import { useEffect, useRef } from 'react';
import { z } from 'zod';
import { queryKey, type ApiRequest, type ReadStamp, type RepositorySession } from '@git-view/contracts';
import { api, ApiError, errorMessage } from '../../state/api';
import { RequestGate } from '../../state/request-gate';
import type { Resource, ResourceSetter } from '../../state/resource';
export type { Resource } from '../../state/resource';

export type Setter<T> = ResourceSetter<T>;
type InvestigationRequest = Extract<ApiRequest, { action: 'search' | 'file-history' | 'file-history-change' | 'blame' | 'records' | 'stash-detail' | 'stash-change' }>;
type Fields = InvestigationRequest extends infer T ? T extends InvestigationRequest ? Omit<T, 'schemaVersion' | 'requestId' | 'sessionId' | 'generation'> : never : never;
export const empty = <T,>(): Resource<T> => ({ loading: false });
export const stale = <T,>(previous: Resource<T>): Resource<T> => ({ ...previous, loading: false, stale: Boolean(previous.value), error: undefined, cancelled: false });
type Pager<T> = { count: (value: T) => number; cursor: (value: T) => string | undefined; merge: (previous: T, next: T) => T; reloadTo?: number; appendTo?: T };

/** All investigation reads use the same stamp checks, including errors and pages. */
export function useInvestigationReads(session: RepositorySession, blocked: boolean, onCancellation: (cancelled: boolean) => void, initiallyCancelled: string[] = []) {
  const gate = useRef(new RequestGate()); const cancelled = useRef(new Set(initiallyCancelled));
  const active = useRef({ session, blocked }); active.current = { session, blocked };
  const context = `${session.sessionId}:${session.generation}:${blocked}`; const current = useRef('');
  if (current.current !== context) { current.current = context; gate.current.setContext(session.sessionId, session.generation); }
  const update = () => onCancellation(cancelled.current.size > 0);
  function resume() { cancelled.current.clear(); update(); }
  async function query<T>(slot: string, fields: Fields, schema: z.ZodType<T>, setter: Setter<T>, options: { keep?: boolean; success?: (value: T) => void; pager?: Pager<T> } = {}) {
    if (active.current.blocked) return;
    cancelled.current.delete(slot); update();
    const initial = active.current.session;
    let request = { ...fields, schemaVersion: 1, sessionId: initial.sessionId, generation: initial.generation, requestId: 'pending' } as InvestigationRequest;
    let ticket = gate.current.begin(slot, queryKey(request, initial.repository.worktreeId)); request.requestId = ticket.requestId;
    setter(previous => ({ ...(options.keep ? previous : {}), loading: true, stale: options.keep && Boolean(previous.value), activity: { id: ticket.requestId, startedAt: Date.now() } }));
    try {
      let value: T | undefined; let stamp: ReadStamp | undefined;
      const seen = new Set<string>();
      while (true) {
        const response = await api(request, schema, ticket.controller.signal);
        if (!gate.current.accepts(ticket)) return;
        if (!response.stamp || !gate.current.accepts(ticket, response.stamp)) throw new Error('读取结果与当前请求身份不匹配，结果未被采用。');
        stamp = response.stamp;
        value = value && options.pager ? options.pager.merge(value, response.data) : response.data;
        const cursor = options.pager?.cursor(value);
        if (!options.pager || !cursor || options.pager.count(value) >= (options.pager.reloadTo ?? 0)) break;
        if (seen.has(cursor) || !options.pager.count(response.data)) throw new Error('历史分页未取得进展，保留上次结果。');
        seen.add(cursor);
        request = { ...request, cursor, requestId: 'pending' } as InvestigationRequest;
        ticket = gate.current.begin(slot, queryKey(request, initial.repository.worktreeId)); request.requestId = ticket.requestId;
      }
      if (!gate.current.accepts(ticket)) return;
      if (options.pager?.appendTo) value = options.pager.merge(options.pager.appendTo, value!);
      setter({ value: value!, stamp, loading: false }); options.success?.(value!);
    } catch (error) {
      if (!gate.current.accepts(ticket)) return;
      const mismatch = error instanceof ApiError && error.stamp && !gate.current.accepts(ticket, error.stamp);
      setter(previous => ({ ...previous, loading: false, stale: Boolean(previous.value), error: mismatch ? '读取结果与当前请求身份不匹配，结果未被采用。' : errorMessage(error) }));
    }
  }
  function clear<T>(slot: string, setter: Setter<T>, keep = false) { gate.current.cancel(slot); setter(keep ? stale : empty()); }
  function cancel<T>(slot: string, setter: Setter<T>) {
    cancelled.current.add(slot); gate.current.cancel(slot);
    setter(previous => ({ ...previous, loading: false, cancelled: true, error: undefined, stale: Boolean(previous.value) })); update();
  }
  function fresh<T>(resource: Resource<T>) { return !blocked && !resource.loading && !resource.error && !resource.stale && !resource.cancelled && resource.stamp?.sessionId === session.sessionId && resource.stamp.generation === session.generation; }
  useEffect(() => { update(); return () => { gate.current.cancelAll(); onCancellation(false); }; }, []);
  return { query, clear, cancel, fresh, resume };
}
