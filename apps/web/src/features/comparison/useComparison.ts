import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { comparisonCommitsSchema, diffSchema, queryKey, revisionComparisonSchema, type ApiRequest, type ChangeEntry, type ComparisonCommits, type ComparisonMode, type ComparisonOptions, type ComparisonSide, type Diff, type RepositorySession, type RevisionComparison } from '@git-view/contracts';
import { api, ApiError, errorMessage } from '../../state/api';
import { RequestGate } from '../../state/request-gate';
import { matchesFileFilter } from '../changes/change-filter';
import type { Resource, ResourceSetter } from '../../state/resource';

type Setter<T> = ResourceSetter<T>;
type Slot = 'compare' | 'diff' | 'a' | 'b';
type Fields = { action: 'compare' } & ComparisonOptions | { action: 'comparison-change'; comparisonId: string; mode: ComparisonMode; entryId: string } | { action: 'comparison-commits'; comparisonId: string; side: ComparisonSide; cursor?: string };
const empty = <T,>(): Resource<T> => ({ loading: false });

/** Comparison selection and request identity have one owner, separate from live worktree reads. */
export function useComparison(session: RepositorySession, blocked: boolean, onCancellation: (cancelled: boolean) => void) {
  const gate = useRef(new RequestGate());
  const context = `${session.sessionId}:${session.generation}:${blocked}`;
  const currentContext = useRef('');
  if (currentContext.current !== context) {
    currentContext.current = context;
    gate.current.setContext(session.sessionId, session.generation);
  }
  const active = useRef({ session, blocked }); active.current = { session, blocked };
  const applied = useRef<ComparisonOptions | undefined>(undefined);
  const snapshot = useRef<RevisionComparison | undefined>(undefined);
  const modeRef = useRef<ComparisonMode>('endpoints');
  const filterRef = useRef('');
  // undefined permits the initial default; null retains an explicit cleared selection.
  const selected = useRef<ChangeEntry | null | undefined>(undefined);
  const cancelled = useRef(new Set<Slot>());
  const [comparison, setComparison] = useState<Resource<RevisionComparison>>(empty);
  const [diff, setDiff] = useState<Resource<Diff>>(empty);
  const [pages, setPages] = useState<Record<ComparisonSide, Resource<ComparisonCommits>>>({ a: empty(), b: empty() });
  const [mode, setMode] = useState<ComparisonMode>('endpoints');
  const [selectedId, setSelectedId] = useState<string>();
  function pageSetter(side: ComparisonSide): Setter<ComparisonCommits> { return value => setPages(previous => ({ ...previous, [side]: typeof value === 'function' ? value(previous[side]) : value })); }
  function updateCancellation() { onCancellation(cancelled.current.size > 0); }
  async function query<T>(slot: Slot, fields: Fields, schema: z.ZodType<T>, setter: Setter<T>, success?: (value: T) => void, keep = false) {
    if (active.current.blocked || cancelled.current.has(slot)) return;
    const current = active.current.session;
    const request = { ...fields, schemaVersion: 1, sessionId: current.sessionId, generation: current.generation, requestId: 'pending' } as ApiRequest;
    const ticket = gate.current.begin(slot, queryKey(request, current.repository.worktreeId)); request.requestId = ticket.requestId;
    setter(previous => ({ ...(keep ? previous : {}), loading: true, stale: keep && Boolean(previous.value), activity: { id: ticket.requestId, startedAt: Date.now() } }));
    try {
      const response = await api(request, schema, ticket.controller.signal);
      if (!gate.current.accepts(ticket)) return;
      if (!response.stamp || !gate.current.accepts(ticket, response.stamp)) throw new Error('读取结果与当前请求身份不匹配，结果未被采用。');
      setter({ value: response.data, loading: false, stamp: response.stamp }); success?.(response.data);
    } catch (error) {
      if (!gate.current.accepts(ticket)) return;
      const mismatch = error instanceof ApiError && error.stamp && !gate.current.accepts(ticket, error.stamp);
      setter(previous => ({ ...previous, loading: false, stale: Boolean(previous.value), error: mismatch ? '读取结果与当前请求身份不匹配，结果未被采用。' : errorMessage(error) }));
    }
  }
  function clearChildren(keep = false) {
    gate.current.cancel('diff'); gate.current.cancel('a'); gate.current.cancel('b');
    const stale = <T,>(value: Resource<T>): Resource<T> => keep ? { ...value, loading: false, stale: Boolean(value.value), error: undefined, cancelled: false } : empty();
    setDiff(stale); setPages(previous => ({ a: stale(previous.a), b: stale(previous.b) }));
    if (!keep) { selected.current = undefined; setSelectedId(undefined); }
  }
  function invalidate() {
    gate.current.cancelAll(); snapshot.current = undefined; applied.current = undefined;
    cancelled.current.clear(); updateCancellation(); clearChildren(); setComparison(empty());
  }
  function selectFile(entry: ChangeEntry, keep = false) {
    const current = snapshot.current;
    if (!current || active.current.blocked || !entry.supported || cancelled.current.has('compare')) return;
    selected.current = entry; setSelectedId(entry.id); cancelled.current.delete('diff'); updateCancellation();
    void query('diff', { action: 'comparison-change', comparisonId: current.comparisonId, mode: modeRef.current, entryId: entry.id }, diffSchema, setDiff, undefined, keep);
  }
  function compare(options: ComparisonOptions, keep = false) {
    if (active.current.blocked) return;
    applied.current = options; snapshot.current = undefined;
    cancelled.current.clear(); updateCancellation(); clearChildren(keep);
    void query('compare', { action: 'compare', ...options }, revisionComparisonSchema, setComparison, result => {
      snapshot.current = result;
      const nextMode = modeRef.current === 'merge-base' && !result.fromMergeBase ? 'endpoints' : modeRef.current;
      modeRef.current = nextMode; setMode(nextMode);
      const entries = (nextMode === 'endpoints' ? result.endpoints : result.fromMergeBase)?.changes ?? [];
      const eligible = entries.filter(e => e.supported && matchesFilter(e));
      const next = eligible.find(e => e.id === selected.current?.id) ?? eligible[0];
      if (next && selected.current !== null && !cancelled.current.has('diff')) selectFile(next, keep && next.id === selected.current?.id);
      else { if (selected.current !== null) selected.current = undefined; setSelectedId(undefined); setDiff(empty()); }
    }, keep);
  }
  function changeMode(value: ComparisonMode) {
    if (value === modeRef.current || !snapshot.current || active.current.blocked) return;
    if (value === 'merge-base' && !snapshot.current.fromMergeBase) return;
    gate.current.cancel('diff'); setDiff(empty()); selected.current = undefined; setSelectedId(undefined);
    modeRef.current = value; setMode(value);
    const tree = value === 'endpoints' ? snapshot.current.endpoints : snapshot.current.fromMergeBase;
    const first = tree?.changes.find(e => e.supported && matchesFilter(e)); if (first) selectFile(first);
  }
  function matchesFilter(entry: ChangeEntry) {
    return matchesFileFilter(entry, filterRef.current);
  }
  function filterFiles(value: string) {
    filterRef.current = value;
    if (selected.current && !matchesFilter(selected.current)) { gate.current.cancel('diff'); setDiff(empty()); selected.current = null; setSelectedId(undefined); }
  }
  function loadPage(side: ComparisonSide, cursor?: string) {
    const current = snapshot.current; if (!current || active.current.blocked) return;
    cancelled.current.delete(side); updateCancellation();
    const setter = pageSetter(side);
    void query(side, { action: 'comparison-commits', comparisonId: current.comparisonId, side, ...(cursor ? { cursor } : {}) }, comparisonCommitsSchema, value => setter(previous => {
      if (typeof value === 'function') return value(previous);
      if (value.value && (value.value.comparisonId !== current.comparisonId || value.value.side !== side)) return { ...previous, loading: false, stale: Boolean(previous.value), error: '读取结果与当前请求身份不匹配，结果未被采用。' };
      if (!value.value || !cursor || previous.value?.comparisonId !== current.comparisonId) return value;
      const seen = new Set(previous.value.commits.map(c => c.oid));
      return { ...value, value: { ...value.value, commits: [...previous.value.commits, ...value.value.commits.filter(c => !seen.has(c.oid))] } };
    }), undefined, Boolean(cursor));
  }
  function cancel(slot: Slot) {
    const slots: Slot[] = slot === 'compare' ? ['compare', 'diff', 'a', 'b'] : [slot];
    for (const key of slots) {
      cancelled.current.add(key); gate.current.cancel(key);
      const stop = <T,>(value: Resource<T>): Resource<T> => ({ ...value, loading: false, error: undefined, cancelled: true, stale: Boolean(value.value) });
      if (key === 'compare') setComparison(stop); else if (key === 'diff') setDiff(stop); else pageSetter(key)(stop);
    }
    updateCancellation();
  }
  function retryDiff() { if (selected.current) selectFile(selected.current, true); }
  useEffect(() => {
    cancelled.current.clear(); updateCancellation();
    if (blocked) { snapshot.current = undefined; clearChildren(true); setComparison(previous => ({ ...previous, loading: false, stale: Boolean(previous.value) })); }
    else if (applied.current) compare(applied.current, true);
    // Refresh re-resolves symbolic endpoints. Individual pages never re-resolve them.
  }, [session.sessionId, session.generation, blocked]);
  useEffect(() => () => { gate.current.cancelAll(); onCancellation(false); }, []);
  const fresh = !blocked && !comparison.loading && !comparison.error && !comparison.stale && !comparison.cancelled && comparison.stamp?.generation === session.generation && comparison.stamp.sessionId === session.sessionId;
  return { comparison, diff, pages, mode, selectedId, fresh, compare, invalidate, changeMode, selectFile, filterFiles, loadPage, cancel, retryDiff };
}
