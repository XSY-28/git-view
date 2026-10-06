import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { z } from 'zod';
import { commitDetailSchema, diffSchema, folderChoiceSchema, historySchema, overviewSchema, navigationSchema, queryKey, recentSchema, sessionSchema, type ApiRequest, type ChangeEntry, type CommitDetail, type CommitNode, type Diff, type History, type HistoryOrder, type Overview, type Navigation, type ReadStamp, type RecentRepository, type RepositorySession } from '@git-view/contracts';
import { api, ApiError, bootstrap, errorMessage, subscribeRepositoryInvalidation } from './state/api';
import { connectDesktopOpen } from './state/transport';
import { RequestGate } from './state/request-gate';
import { ReadCancellation, type ReadSlot } from './state/read-coordination';
import { FEEDBACK_TIMING, ReadFeedback, type ReadState } from './features/feedback/ReadFeedback';
import { DiffView } from './features/changes/DiffView';
import { ChangeList } from './features/changes/ChangeList';
import { matchesFileFilter } from './features/changes/change-filter';
import { HistoryGraph, type LocateRequest } from './features/history/HistoryGraph';
import { RepositorySidebar } from './features/navigation/RepositorySidebar';
import { RepositorySwitcher } from './features/navigation/RepositorySwitcher';
import { historyScopeLabel } from './features/navigation/history-scope';
import { CommitSummary } from './features/history/CommitSummary';
import { RepositoryController, RefreshQueue, type HistoryScope, type MainView } from './state/repository-controller';

type Resource<T> = ReadState & { value?: T; stamp?: ReadStamp };
type ResourceSetter<T> = Dispatch<SetStateAction<Resource<T>>>;
type SessionFields = { action: 'overview' } | { action: 'navigation' } | { action: 'change'; entryId: string; fingerprint: string } | { action: 'history'; scope: HistoryScope; ref?: string; order?: HistoryOrder; cursor?: string } | { action: 'commit'; oid: string } | { action: 'commit-change'; oid: string; entryId: string };
const invalidReadMessage = '读取结果与当前请求身份不匹配，结果未被采用。';
const empty = <T,>(): Resource<T> => ({ loading: false });
const allEntries = (overview: Overview) => Object.values(overview.changes).flat();
const timeLabel = (value?: string) => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '尚未读取';

function Empty({ symbol = '↳', title, children }: { symbol?: string; title: string; children?: React.ReactNode }) { return <div className="empty-state"><span className="empty-glyph" aria-hidden="true">{symbol}</span><h2>{title}</h2>{children && <p>{children}</p>}</div>; }

export function App({ initialSessionId, ticket }: { initialSessionId?: string; ticket: string | null }) {
  const controller = useRef(new RepositoryController());
  const refreshQueue = useRef(new RefreshQueue());
  const fileScroll = useRef<HTMLDivElement>(null);
  const gate = useRef(new RequestGate());
  const cancellation = useRef(new ReadCancellation());
  // Choosing a repository is independent of the current repository's refresh generation.
  const repositoryGate = useRef(new RequestGate());
  const repositoryBusy = useRef(false); const pendingRefresh = useRef(false); const openingPath = useRef<string | undefined>(undefined);
  const currentSession = useRef<RepositorySession | undefined>(undefined); const currentOverview = useRef<Overview | undefined>(undefined); const currentHistory = useRef<History | undefined>(undefined);
  // undefined allows the initial default; null records an explicit cleared selection.
  const selection = useRef<ChangeEntry | null | undefined>(undefined); const commitSelection = useRef<string | undefined>(undefined); const commitFileSelection = useRef<ChangeEntry | null | undefined>(undefined);
  const historyScope = useRef<HistoryScope>('head'); const historyRef = useRef<string | undefined>(undefined);
  const historyOrder = useRef<HistoryOrder>('topo'); const allHistoryOrder = useRef<HistoryOrder>('date');
  const started = useRef(false); const bootstrapDone = useRef(false);
  const staleRecoveries = useRef(0);
  const [session, setSession] = useState<RepositorySession>();
  const [startup, setStartup] = useState<Resource<never>>({ loading: true });
  const [overview, setOverview] = useState<Resource<Overview>>(empty);
  const [history, setHistory] = useState<Resource<History>>(empty);
  const [diff, setDiff] = useState<Resource<Diff>>(empty);
  const [commit, setCommit] = useState<Resource<CommitDetail>>(empty);
  const [commitDiff, setCommitDiff] = useState<Resource<Diff>>(empty);
  const [navigation, setNavigation] = useState<Resource<Navigation>>(empty);
  const [recents, setRecents] = useState<RecentRepository[]>([]);
  const [view, setView] = useState<'changes' | 'history'>('changes');
  const [fileFilters, setFileFilters] = useState({ changes: '', history: '' });
  const [selected, setSelected] = useState<string>(); const [selectedCommit, setSelectedCommit] = useState<string>(); const [selectedCommitFile, setSelectedCommitFile] = useState<string>();
  const [repoPath, setRepoPath] = useState(''); const [showRepository, setShowRepository] = useState(false);
  const [info, setInfo] = useState<{ message: string; id: number }>();
  const noticeVersion = useRef(0);
  function notify(message: string) { setInfo({ message, id: ++noticeVersion.current }); }
  const locateVersion = useRef(0);
  const [locateRequest, setLocateRequest] = useState<LocateRequest>();
  const [mobilePanel, setMobilePanel] = useState<'navigation' | 'list' | 'diff'>('list');
  const [repositoryActivity, setRepositoryActivity] = useState<'picking' | 'opening' | null>(null);
  const [openError, setOpenError] = useState('');
  const [watchError, setWatchError] = useState('');

  async function copyText(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); notify(`已复制${label}。`); }
    catch { notify('无法访问剪贴板，请手动复制。'); }
  }
  function cancel(slot: ReadSlot) {
    refreshQueue.current.reset(); pendingRefresh.current = false;
    const stop = <T,>(setter: ResourceSetter<T>) => () => setter(previous => ({ ...previous, loading: false, error: undefined, cancelled: true, stale: Boolean(previous.value) }));
    const stops = { overview: stop(setOverview), navigation: stop(setNavigation), history: stop(setHistory), commit: stop(setCommit), diff: stop(setDiff), 'commit-diff': stop(setCommitDiff) };
    for (const target of cancellation.current.cancel(slot)) {
      gate.current.cancel(target);
      stops[target]();
    }
  }
  function retry(slot: Exclude<ReadSlot, 'diff' | 'commit-diff'>) {
    cancellation.current.resume(slot);
    if (slot === 'overview') loadOverview();
    else if (slot === 'navigation') loadNavigation();
    else if (slot === 'history') void loadHistory();
    else if (slot === 'commit') loadSelectedCommit(true);
  }
  async function query<T>(slot: ReadSlot, fields: SessionFields, schema: z.ZodType<T>, setter: ResourceSetter<T>, onSuccess?: (data: T) => void, keep = false) {
    const active = currentSession.current; if (!active || cancellation.current.isCancelled(slot)) return;
    const request = { ...fields, schemaVersion: 1, sessionId: active.sessionId, generation: active.generation, requestId: 'pending' } as ApiRequest;
    const identity = gate.current.begin(slot, queryKey(request, active.repository.worktreeId)); request.requestId = identity.requestId;
    let recovering = false;
    setter(previous => ({ ...(keep ? previous : {}), loading: true, error: undefined, cancelled: false, stale: keep && Boolean(previous.value), activity: { id: identity.requestId, startedAt: Date.now() } }));
    try {
      const response = await api(request, schema, identity.controller.signal);
      if (!gate.current.accepts(identity)) return;
      if (!response.stamp || !gate.current.accepts(identity, response.stamp)) throw new Error(invalidReadMessage);
      setter({ value: response.data, loading: false, stamp: response.stamp });
      if (slot === 'diff') staleRecoveries.current = 0;
      onSuccess?.(response.data);
    } catch (error) {
      // An active request with an invalid response must settle as a local protocol
      // failure. An obsolete request must not write success, error, or finally state.
      if (gate.current.accepts(identity)) {
        const mismatch = error instanceof ApiError && error.stamp && !gate.current.accepts(identity, error.stamp);
        if (!mismatch && error instanceof ApiError && error.detail.code === 'STALE_RESULT' && slot === 'diff' && staleRecoveries.current < 1) {
          recovering = true; staleRecoveries.current += 1;
          window.setTimeout(() => { if (gate.current.accepts(identity)) { refreshQueue.current.reset(); refresh('recovery'); } }, 0);
        } else {
          setter(previous => ({ ...previous, loading: false, error: mismatch ? invalidReadMessage : errorMessage(error), stale: Boolean(previous.value) }));
        }
      }
    } finally {
      if (!recovering && gate.current.accepts(identity)) setter(previous => ({ ...previous, loading: false }));
    }
  }
  async function loadRecents(restore = false) {
    const identity = gate.current.begin('recents', 'recents');
    try { const result = await api({ schemaVersion: 1, action: 'recents', requestId: identity.requestId }, z.array(recentSchema), identity.controller.signal); if (gate.current.accepts(identity)) { setRecents(result.data); if (restore && !controller.current.explicitOpen && !repositoryBusy.current && !controller.current.pendingPath && !currentSession.current && result.data[0]) void openRepository(result.data[0].path, false); } } catch { /* Opening a repository remains available if local preferences are unavailable. */ }
  }
  function selectChange(entry: ChangeEntry, nextOverview = currentOverview.current, navigate = true, keep = false, automatic = false) {
    if (!entry.supported || !matchesFileFilter(entry, controller.current.fileFilter('changes'))) return;
    if (!automatic) cancellation.current.resume('diff');
    selection.current = entry; setSelected(entry.id); if (navigate) setMobilePanel('diff'); if (!keep) staleRecoveries.current = 0;
    if (!nextOverview) return;
    void query('diff', { action: 'change', entryId: entry.id, fingerprint: nextOverview.fingerprint }, diffSchema, setDiff, undefined, keep);
  }
  function selectCommitFile(entry: ChangeEntry, oid = commitSelection.current, keep = false, automatic = false) {
    if (!oid || !entry.supported || !matchesFileFilter(entry, controller.current.fileFilter('history'))) return;
    if (!automatic) cancellation.current.resume('commit-diff');
    commitFileSelection.current = entry; setSelectedCommitFile(entry.id);
    void query('commit-diff', { action: 'commit-change', oid, entryId: entry.id }, diffSchema, setCommitDiff, undefined, keep);
  }
  function clearFileSelection(scope: MainView) {
    controller.current.clearSelection(scope);
    cancellation.current.resume(scope === 'changes' ? 'diff' : 'commit-diff');
    if (scope === 'changes') { gate.current.cancel('diff'); selection.current = null; setSelected(undefined); setDiff(empty()); }
    else { gate.current.cancel('commit-diff'); commitFileSelection.current = null; setSelectedCommitFile(undefined); setCommitDiff(empty()); }
  }
  function filterFiles(scope: MainView, value: string) {
    controller.current.fileFilter(scope, value);
    setFileFilters(previous => ({ ...previous, [scope]: value }));
    const entry = scope === 'changes' ? selection.current : commitFileSelection.current;
    if (entry && !matchesFileFilter(entry, value)) clearFileSelection(scope);
  }
  function selectCommit(node: CommitNode, activate = true) {
    commitSelection.current = node.oid; setSelectedCommit(node.oid); if (activate) setMobilePanel('diff');
    gate.current.cancel('commit-diff'); setCommitDiff(empty()); setSelectedCommitFile(undefined); commitFileSelection.current = undefined;
    cancellation.current.resume('commit');
    loadSelectedCommit(false);
  }
  function loadSelectedCommit(keep: boolean) {
    const oid = commitSelection.current; if (!oid) return;
    void query('commit', { action: 'commit', oid }, commitDetailSchema, setCommit, data => {
      const previous = commitFileSelection.current;
      if (previous === null || cancellation.current.isCancelled('commit-diff')) return;
      const eligible = data.changes.filter(entry => entry.supported && matchesFileFilter(entry, controller.current.fileFilter('history')));
      const entry = previous ? eligible.find(entry => entry.id === previous.id) : eligible[0];
      if (entry) selectCommitFile(entry, oid, keep, true);
      else clearFileSelection('history');
    }, keep);
  }
  function requestLocate(targetOid: string) { setLocateRequest({ version: ++locateVersion.current, targetOid }); }
  async function loadHistory(scope = historyScope.current, cursor?: string, locate = false, ref = historyRef.current, order: HistoryOrder = scope === 'all' ? allHistoryOrder.current : 'topo') {
    const active = currentSession.current; if (!active || cancellation.current.isCancelled('history')) return;
    const selectedRef = scope === 'ref' ? ref : undefined;
    const scopeChanged = scope !== historyScope.current || selectedRef !== historyRef.current || order !== historyOrder.current;
    historyScope.current = scope; historyRef.current = selectedRef; historyOrder.current = order;
    if (scope === 'all') allHistoryOrder.current = order;
    if (scopeChanged) { cancellation.current.resume('commit'); setLocateRequest(undefined); gate.current.cancel('commit'); gate.current.cancel('commit-diff'); commitSelection.current = undefined; commitFileSelection.current = undefined; setSelectedCommit(undefined); setSelectedCommitFile(undefined); setCommit(empty()); setCommitDiff(empty()); currentHistory.current = undefined; }
    const previous = currentHistory.current;
    const keep = !scopeChanged && Boolean(previous);
    // Refresh the already loaded window before replacing it; a first-page swap clamps scroll.
    const minimumCount = cursor ? 0 : previous?.commits.length || 0;
    let commits = cursor && previous ? [...previous.commits] : [];
    const seen = new Set(commits.map(node => node.oid));
    let nextCursor = cursor;
    let request = { schemaVersion: 1, sessionId: active.sessionId, generation: active.generation, requestId: 'pending', action: 'history', scope, order, ...(scope === 'ref' ? { ref: historyRef.current } : {}), ...(nextCursor ? { cursor: nextCursor } : {}) } as ApiRequest;
    let identity = gate.current.begin('history', queryKey(request, active.repository.worktreeId));
    let responseStamp: ReadStamp | undefined;
    setHistory(current => ({ ...(keep ? current : {}), loading: true, stale: keep, error: undefined, cancelled: false, activity: { id: identity.requestId, startedAt: Date.now() } }));
    try {
      while (true) {
        request.requestId = identity.requestId;
        const response = await api(request, historySchema, identity.controller.signal);
        responseStamp = response.stamp;
        if (!gate.current.accepts(identity)) return;
        if (!responseStamp || !gate.current.accepts(identity, responseStamp)) throw new Error(invalidReadMessage);
        const page = response.data;
        const additions = page.commits.filter(node => !seen.has(node.oid));
        commits = [...commits, ...additions]; additions.forEach(node => seen.add(node.oid));
        if (commits.length >= minimumCount || !page.nextCursor) {
          const combined = { ...page, commits };
          currentHistory.current = combined; setHistory({ value: combined, loading: false, stamp: responseStamp });
          if (locate && page.headOid) { const target = commits.find(node => node.oid === page.headOid); if (target) { setMobilePanel('list'); selectCommit(target, false); requestLocate(target.oid); } }
          return;
        }
        if (!additions.length || page.nextCursor === nextCursor) throw new Error('历史分页未取得进展，保留上次结果。');
        nextCursor = page.nextCursor;
        request = { ...request, cursor: nextCursor } as ApiRequest;
        identity = gate.current.begin('history', queryKey(request, active.repository.worktreeId));
        responseStamp = undefined;
      }
    } catch (error) {
      if (gate.current.accepts(identity)) {
        const mismatch = error instanceof ApiError && error.stamp && !gate.current.accepts(identity, error.stamp);
        setHistory(current => ({ ...current, loading: false, error: mismatch ? invalidReadMessage : errorMessage(error), stale: Boolean(current.value) }));
      }
    }
  }
  function loadOverview(loadGraph = true) {
    void query('overview', { action: 'overview' }, overviewSchema, setOverview, data => {
      currentOverview.current = data;
      const previous = selection.current; const retained = previous && allEntries(data).find(entry => entry.id === previous.id && entry.supported && matchesFileFilter(entry, controller.current.fileFilter('changes')));
      if (retained) selectChange(retained, data, false, true, true);
      else if (previous) { clearFileSelection('changes'); notify('此前选中的文件已不在当前改动中。请从最新列表重新选择。'); }
      else if (previous === undefined) { const first = allEntries(data).find(entry => entry.supported && matchesFileFilter(entry, controller.current.fileFilter('changes'))); if (first) selectChange(first, data, false, false, true); }
      if (loadGraph) loadHistory();
    }, true);
  }
  function loadNavigation() { void query('navigation', { action: 'navigation' }, navigationSchema, setNavigation, undefined, true); }
  function filterHistory(scope: HistoryScope, ref?: string) { cancellation.current.resume('history'); setView('history'); setMobilePanel('list'); loadHistory(scope, undefined, false, ref); }
  function sortHistory(order: HistoryOrder) { cancellation.current.resume('history'); void loadHistory('all', undefined, false, undefined, order); }
  function adoptSession(next: RepositorySession) {
    refreshQueue.current.reset(); cancellation.current.reset(); pendingRefresh.current = false; setLocateRequest(undefined); currentSession.current = next; setSession(next); currentOverview.current = undefined; currentHistory.current = undefined;
    gate.current.setContext(next.sessionId, next.generation);
    const memory = controller.current.activate(next.repository.worktreeId);
    selection.current = memory.selection; commitSelection.current = memory.commit; commitFileSelection.current = memory.commitFile; historyScope.current = memory.scope; historyRef.current = memory.ref;
    allHistoryOrder.current = memory.allHistoryOrder; historyOrder.current = memory.scope === 'all' ? memory.allHistoryOrder : 'topo'; setView(memory.view); setFileFilters({ ...memory.fileFilters });
    staleRecoveries.current = 0;
    setOverview(empty()); setHistory(empty()); setDiff(empty()); setCommit(empty()); setCommitDiff(empty());
    setSelected(memory.selection?.id); setSelectedCommit(memory.commit); setSelectedCommitFile(memory.commitFile?.id); setInfo(undefined); setNavigation(empty()); setRepoPath(next.repository.worktreeRoot); setMobilePanel('list');
    setShowRepository(false); window.history.replaceState(null, '', `/?session=${encodeURIComponent(next.sessionId)}`);
    loadOverview(); loadNavigation(); void loadRecents();
    if (memory.commit) loadSelectedCommit(false);
  }
  async function openRepository(path?: string, explicit = true) {
    if (path !== undefined && !path.trim()) return;
    if (explicit) controller.current.explicitOpen = true;
    if (repositoryBusy.current) { if (path !== undefined) controller.current.pendingPath = path === openingPath.current ? undefined : path; return; }
    const identity = repositoryGate.current.begin('repository', path === undefined ? 'pick-folder' : `open:${path}`);
    repositoryBusy.current = true; openingPath.current = path;
    setRepositoryActivity(path === undefined ? 'picking' : 'opening');
    setOpenError('');
    try {
      let selectedPath = path;
      if (selectedPath === undefined) {
        const choice = await api({ schemaVersion: 1, action: 'pick-folder', requestId: identity.requestId }, folderChoiceSchema, identity.controller.signal);
        if (!repositoryGate.current.accepts(identity) || choice.data.cancelled) return;
        selectedPath = choice.data.path;
        setRepositoryActivity('opening');
      }
      openingPath.current = selectedPath; setRepoPath(selectedPath);
      const response = await api({ schemaVersion: 1, action: 'open', path: selectedPath, requestId: crypto.randomUUID() }, sessionSchema, identity.controller.signal);
      if (repositoryGate.current.accepts(identity)) adoptSession(response.data);
    } catch (error) {
      if (repositoryGate.current.accepts(identity)) {
        setOpenError(`${path || repoPath || '所选路径'}：${errorMessage(error)}`);
        setShowRepository(true);
      }
    } finally {
      if (repositoryGate.current.accepts(identity)) {
        repositoryBusy.current = false; openingPath.current = undefined;
        setRepositoryActivity(null);
        repositoryGate.current.cancel('repository');
        const pending = controller.current.pendingPath; controller.current.pendingPath = undefined;
        if (pending && pending !== currentSession.current?.repository.worktreeRoot) void openRepository(pending);
        else if (pendingRefresh.current) { pendingRefresh.current = false; refreshQueue.current.reset(); refresh(); }
      }
    }
  }
  function cancelRepositoryOpen(resume = true) {
    repositoryGate.current.cancel('repository');
    repositoryBusy.current = false; openingPath.current = undefined;
    setRepositoryActivity(null); controller.current.pendingPath = undefined; if (resume && pendingRefresh.current) { pendingRefresh.current = false; refreshQueue.current.reset(); refresh(); } else pendingRefresh.current = false;
  }
  function refresh(source: 'manual' | 'focus' | 'change' | 'recovery' = 'manual') {
    if (source === 'focus' && cancellation.current.hasCancelled()) return;
    if (repositoryBusy.current) { pendingRefresh.current = true; return; }
    if (!currentSession.current) return;
    refreshQueue.current.request(performRefresh);
  }
  function performRefresh() {
    if (repositoryBusy.current) { pendingRefresh.current = true; return; }
    const active = currentSession.current; if (!active) return;
    const next = { ...active, generation: active.generation + 1 }; currentSession.current = next; setSession(next);
    gate.current.setContext(next.sessionId, next.generation);
    cancellation.current.reset();
    setInfo(undefined); setDiff(previous => ({ ...previous, stale: Boolean(previous.value), loading: false, cancelled: false, error: undefined }));
    setHistory(previous => ({ ...previous, stale: Boolean(previous.value), loading: false, cancelled: false, error: undefined }));
    setCommit(previous => ({ ...previous, stale: Boolean(previous.value), loading: false, cancelled: false, error: undefined })); setCommitDiff(previous => ({ ...previous, stale: Boolean(previous.value), loading: false, cancelled: false, error: undefined }));
    loadOverview(); loadNavigation();
    if (commitSelection.current) loadSelectedCommit(true);
  }
  function locateHead() {
    setView('history'); setMobilePanel('list'); const head = currentOverview.current?.head;
    if (!head || head.kind === 'unborn') { notify('仓库尚无首次提交，目前没有可定位的 HEAD 提交。'); return; }
    const target = history.value?.commits.find(node => node.oid === head.oid);
    if (target) { selectCommit(target, false); requestLocate(target.oid); }
    else { notify('当前窗口未包含 HEAD，已切换为仅从当前 HEAD 出发的历史。'); cancellation.current.resume('history'); loadHistory('head', undefined, true); }
  }

  useEffect(() => {
    if (started.current) return; started.current = true;
    void bootstrap(initialSessionId || '', ticket).then(initial => { bootstrapDone.current = true; setStartup({ loading: false }); const pending = controller.current.pendingPath; controller.current.pendingPath = undefined; if (initial) adoptSession(initial); if (pending && pending !== initial?.repository.worktreeRoot) void openRepository(pending); else if (!initial) { setShowRepository(true); void loadRecents(true); } }).catch(error => { bootstrapDone.current = true; setStartup({ loading: false, error: errorMessage(error) }); });
    // Bootstrap runs exactly once; the single-use ticket is never retained in the URL.
  }, []);
  useEffect(() => {
    setWatchError('');
    if (!session) return;
    return subscribeRepositoryInvalidation(session.sessionId, () => { if (currentSession.current?.sessionId === session.sessionId) refresh('change'); }, error => { if (currentSession.current?.sessionId === session.sessionId) setWatchError(`${errorMessage(error)} 自动更新已停止，可手动刷新或重新打开仓库。`); });
  }, [session?.sessionId]);
  useEffect(() => {
    if (session) controller.current.save({ view, scope: historyScope.current, ref: historyRef.current, allHistoryOrder: allHistoryOrder.current, selection: selection.current, commit: commitSelection.current, commitFile: commitFileSelection.current });
  }, [session, view, selected, selectedCommit, selectedCommitFile, history.value, commit.value, fileFilters, historyScope.current, historyRef.current, allHistoryOrder.current]);
  useEffect(() => {
    if (view === 'changes' && fileScroll.current) fileScroll.current.scrollTop = controller.current.position('changes');
  }, [view, session?.repository.worktreeId, Boolean(overview.value)]);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() === 'o') { event.preventDefault(); void openRepository(); }
      if (event.key.toLowerCase() === 'r') { event.preventDefault(); refresh(); }
    }
    function hostOpen(event: Event) { const path = (event as CustomEvent<{ path?: unknown }>).detail?.path; if (typeof path === 'string' && path.trim() && (repositoryBusy.current || path !== currentSession.current?.repository.worktreeRoot)) { if (!bootstrapDone.current) { controller.current.explicitOpen = true; controller.current.pendingPath = path; } else void openRepository(path); } }
    window.addEventListener('keydown', keyboard); window.addEventListener('git-view:open-repository', hostOpen);
    let closed = false; let unsubscribe: (() => void) | undefined;
    void connectDesktopOpen().then(cleanup => { if (cleanup) { if (closed) cleanup(); else unsubscribe = cleanup; } }).catch(error => { if (!closed) { setOpenError(errorMessage(error)); setShowRepository(true); } });
    return () => { closed = true; unsubscribe?.(); window.removeEventListener('keydown', keyboard); window.removeEventListener('git-view:open-repository', hostOpen); };
  }, []);
  useEffect(() => {
    function focus() { if (document.visibilityState === 'visible') refresh('focus'); }
    function pageHide() { cancelRepositoryOpen(false); refreshQueue.current.reset(); gate.current.cancelAll(); }
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    window.addEventListener('pagehide', pageHide);
    const heartbeat = window.setInterval(() => { void api({ schemaVersion: 1, action: 'heartbeat', requestId: crypto.randomUUID() }, z.object({ alive: z.boolean() })).catch(() => undefined); }, 60_000);
    return () => {
      window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus);
      window.removeEventListener('pagehide', pageHide); window.clearInterval(heartbeat);
      repositoryGate.current.cancelAll(); repositoryBusy.current = false; refreshQueue.current.reset(); gate.current.cancelAll();
    };
  }, []);

  useEffect(() => {
    if (!info) return;
    const timer = window.setTimeout(() => setInfo(current => current?.id === info.id ? undefined : current), FEEDBACK_TIMING.notificationMs);
    return () => window.clearTimeout(timer);
  }, [info]);

  const data = overview.value;
  const opening = repositoryActivity !== null;
  const branch = data?.head.kind === 'detached' ? 'detached HEAD' : data?.head.branch;
  const headOid = data && data.head.kind !== 'unborn' ? data.head.oid : undefined;
  const headInHistory = Boolean(headOid && history.value?.commits.some(node => node.oid === headOid));
  const head = data?.head.kind === 'unborn' ? '尚无首次提交' : data?.head.oid.slice(0, 8);
  const total = data ? Object.values(data.changes).reduce((count, entries) => count + entries.length, 0) : 0;
  const activeDiff = view === 'changes' ? diff : commitDiff;
  const parentRead = view === 'changes' ? overview : commit;
  const hasSelectedFile = Boolean(activeDiff.value || (view === 'changes' ? selected : selectedCommitFile));
  const diffFeedback = hasSelectedFile && !activeDiff.cancelled && !activeDiff.error && !activeDiff.loading && parentRead.loading
    ? { ...activeDiff, loading: true, activity: parentRead.activity } : activeDiff;
  function retryDiff() {
    if (parentRead.error || parentRead.cancelled || (!parentRead.loading && parentRead.stale)) {
      retry(view === 'changes' ? 'overview' : 'commit'); return;
    }
    if (view === 'changes' && selection.current) selectChange(selection.current, currentOverview.current, false, true);
    else if (view === 'history' && commitFileSelection.current) selectCommitFile(commitFileSelection.current, commitSelection.current, true);
  }
  const commitFeedback = <ReadFeedback state={commit} hasValue={Boolean(commit.value)} scope="提交详情" compact className="commit-read-state" onRetry={() => retry('commit')} onCancel={() => cancel('commit')}/>;

  return <div className="app-shell">
    <header className="app-header">
      <span className="app-mark" title="Git View" aria-label="Git View"><svg viewBox="0 0 30 30" aria-hidden="true"><path d="M8 5v13a6 6 0 0 0 6 6h7M8 11h8a5 5 0 0 0 5-5"/><circle cx="8" cy="5" r="3"/><circle cx="21" cy="5" r="3"/><circle cx="22" cy="24" r="3"/></svg></span>
      <RepositorySwitcher root={session?.repository.worktreeRoot} recents={recents} worktrees={navigation.value?.worktrees} open={showRepository}
        onOpenChange={open => { setShowRepository(open); if (open) void loadRecents(); }} onOpen={path => void openRepository(path)}
        onCopyPath={() => { if (session) copyText(session.repository.worktreeRoot, '仓库路径'); }} busy={opening} disabled={startup.loading || Boolean(startup.error)}
        repoPath={repoPath} onRepoPathChange={setRepoPath} error={openError}/>
      {session && <div className="head-line" aria-label="仓库当前位置"><span className="head-caption">{data?.head.kind === 'detached' ? '当前位置' : '当前分支'}</span><strong title={branch}>{branch || '读取分支中'}</strong><code title={headOid}>{head || '—'}</code></div>}
      <div className="toolbar-status"><span className="readonly">本地 · 只读</span>
        {session && <div className="read-status"><ReadFeedback state={overview} hasValue={Boolean(data)} scope="仓库状态" compact className="overview-read-state" idleLabel={data ? `读取于 ${timeLabel(data.stamp.finishedAt)}` : undefined} onRetry={() => retry('overview')} onCancel={() => cancel('overview')}/><button className="refresh-button" onClick={() => refresh()} disabled={opening} aria-label="刷新仓库"><span aria-hidden="true">↻</span> 刷新</button></div>}
      </div>
    </header>

    {startup.error ? <main className="startup"><Empty symbol="↻" title="需要重新连接本地进程">{startup.error}</Empty><p className="restart-command"><code>git-view open --repo &lt;仓库路径&gt;</code></p></main> : <>
      {opening && <div className="repository-opening notice" role="status">
        <span><span className="spinner" />{repositoryActivity === 'picking' ? '请在系统窗口中选择仓库文件夹。' : '正在验证所选文件夹并读取仓库…'}</span>
        <button onClick={() => cancelRepositoryOpen()}>取消</button>
      </div>}
      {session && <div className={`repository-layout mobile-${mobilePanel}`}><RepositorySidebar key={session.repository.worktreeId} initialSearch={controller.current.search()} onSearch={value => controller.current.search(value)} navigation={navigation.value} scope={historyScope.current} selectedRef={historyRef.current} readState={navigation} onFilter={filterHistory} onRetry={() => retry('navigation')} onCancel={() => cancel('navigation')}/><div className="repository-main">
        {data && (data.operation.length > 0 || !data.complete || data.changes.conflicts.length > 0) && <div className="operation-banner" role="status">{data.operation.length > 0 && <strong>进行中的操作：{data.operation.join('、')}。 </strong>}{data.changes.conflicts.length > 0 && <strong>{data.changes.conflicts.length} 个未解决冲突。 </strong>}{!data.complete && <strong>当前观测不完整。 </strong>}{data.warnings.join(' ')}</div>}
        {watchError && <div className="operation-banner" role="alert">{watchError}</div>}
        {info && <div className="feedback-toast" role="status"><span>{info.message}</span></div>}
        <nav className="view-tabs" aria-label="主视图"><button className={view === 'changes' ? 'active' : ''} onClick={() => { setView('changes'); setMobilePanel('list'); }}>当前改动 <span>{total}</span></button><button className={view === 'history' ? 'active' : ''} onClick={() => { setView('history'); setMobilePanel('list'); if (!history.value && !history.loading) retry('history'); }}>提交历史 <span>{history.value?.commits.length || '·'}</span></button>{view === 'history' && <button className="locate-button" disabled={!headOid || history.loading} title={headInHistory ? '选中并定位当前 HEAD' : '查看从当前 HEAD 出发的历史'} onClick={locateHead}>{headInHistory ? '定位 HEAD' : '查看 HEAD 历史'}</button>}</nav>
        <nav className="mobile-tabs" aria-label="窄窗口面板"><button className={mobilePanel === 'navigation' ? 'active' : ''} onClick={() => setMobilePanel('navigation')}>历史范围</button><button className={mobilePanel === 'list' ? 'active' : ''} onClick={() => setMobilePanel('list')}>{view === 'changes' ? '文件列表' : '提交列表'}</button><button className={mobilePanel === 'diff' ? 'active' : ''} onClick={() => setMobilePanel('diff')}>查看详情</button></nav>

        <main className={`workspace ${view === 'history' ? 'history-workspace' : ''} mobile-${mobilePanel}`}>
          <aside className="list-panel">
            {view === 'changes' ? <><div className="panel-heading"><h2>文件变化</h2><span>{total} 项比较</span></div>{data ? <ChangeList scope="changes" changes={data.changes} filter={fileFilters.changes} onFilter={value => filterFiles('changes', value)} selected={selected} onSelect={(entry, activate) => selectChange(entry, currentOverview.current, activate)} scrollRef={fileScroll} onScroll={top => controller.current.scroll('changes', top)}/> : <p className="panel-wait">{overview.loading ? '正在读取工作区…' : '读取概览后显示文件。'}</p>}</> : <><div className="panel-heading"><h2>提交关系</h2><div className="history-heading-controls"><span className="history-range-label"><span>{historyScopeLabel(historyScope.current, historyRef.current)}</span></span>{historyScope.current === 'all' && <select aria-label="历史排序" className="history-order" value={allHistoryOrder.current} title="时间优先：优先展示较新的提交，保留父子关系。分支聚合：尽量连续展示同一条历史线。" onChange={event => { const order = event.target.value; if (order === 'date' || order === 'topo') sortHistory(order); }}><option value="date">时间优先</option><option value="topo">分支聚合</option></select>}</div></div><ReadFeedback state={history} hasValue={Boolean(history.value)} scope="提交历史" className="history-read-state" onRetry={() => retry('history')} onCancel={() => cancel('history')}/>{history.value?.shallow && <div className="history-boundary-note">浅克隆 · 历史不完整</div>}{history.value?.commits.length ? <HistoryGraph commits={history.value.commits} selected={selectedCommit} headOid={history.value.headOid} onSelect={selectCommit} key={`${session.repository.worktreeId}:${historyScope.current}:${historyRef.current || ''}:${historyOrder.current}`} locateRequest={locateRequest} onLocateConsumed={version => setLocateRequest(current => current?.version === version ? undefined : current)} initialTop={controller.current.position(`history:${historyScope.current}:${historyRef.current || ''}:${historyOrder.current}`)} onScroll={top => controller.current.scroll(`history:${historyScope.current}:${historyRef.current || ''}:${historyOrder.current}`, top)}/> : history.value && !history.loading && !history.error && !history.stale && <Empty title={data?.head.kind === 'unborn' ? '仓库尚无提交' : '当前范围内无提交'}/>}{history.value?.nextCursor && <button className="load-more" disabled={history.loading} onClick={() => { cancellation.current.resume('history'); void loadHistory(historyScope.current, history.value?.nextCursor); }}>继续加载 200 条 <span>↓</span></button>}</>}
          </aside>

          <section className="detail-panel" aria-label="所选内容详情">
            {view === 'history' && <>{commit.value ? <CommitSummary key={commit.value.commit.oid} detail={commit.value} onCopy={value => copyText(value, '提交 ID')} status={commitFeedback}><ChangeList scope="history" entries={commit.value.changes} filter={fileFilters.history} onFilter={value => filterFiles('history', value)} selected={selectedCommitFile} onSelect={entry => selectCommitFile(entry)}/></CommitSummary> : selectedCommit && commitFeedback}</>}

            <ReadFeedback state={diffFeedback} hasValue={Boolean(activeDiff.value)} scope="文件差异" className="diff-read-state" onRetry={retryDiff} onCancel={() => cancel(view === 'changes' ? 'diff' : 'commit-diff')}/>
            {activeDiff.value ? <div className={activeDiff.stale ? 'stale-content' : ''}><DiffView diff={activeDiff.value} observedAt={activeDiff.stamp?.finishedAt} positionKey={JSON.stringify([session.repository.worktreeId, view, activeDiff.value.comparison, activeDiff.value.entry.id, activeDiff.value.base, activeDiff.value.target])}/></div> : !diffFeedback.loading && (view === 'changes' ? (data && total === 0 && data.complete && !overview.stale && !overview.error && !overview.loading ? <Empty symbol="✓" title="工作区干净"><button className="button inline-button" onClick={() => setView('history')}>查看最近提交 →</button></Empty> : <Empty title="未选择文件"/>) : commit.value ? <Empty title="未选择文件"/> : <Empty symbol="⑂" title="未选择提交"/>)}
          </section>

        </main>
      </div></div>}
      {startup.loading && <Empty title="正在连接本地仓库…"/>}
      {!startup.loading && !session && <Empty symbol="⑂" title="尚未打开仓库"/>}
    </>}
  </div>;
}
