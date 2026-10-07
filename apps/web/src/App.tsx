import { LanguageSelector, useI18n } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { commitDetailSchema, diffSchema, folderChoiceSchema, historySchema, overviewSchema, rawOverviewSchema, navigationSchema, queryKey, recentSchema, sessionSchema, type ApiRequest, type ChangeEntry, type CommitDetail, type CommitNode, type Diff, type History, type HistoryOrder, type Overview, type Navigation, type ReadStamp, type RecentRepository, type RepositorySession } from '@git-view/contracts';
import { api, ApiError, bootstrap, errorMessage, readRepositoryWatch, subscribeRepositoryInvalidation } from './state/api';
import { connectDesktopOpen } from './state/transport';
import { RequestGate } from './state/request-gate';
import { ReadCancellation, type ReadSlot } from './state/read-coordination';
import { FEEDBACK_TIMING, ReadFeedback, type ReadState } from './features/feedback/ReadFeedback';
import { ComparisonView } from './features/comparison/ComparisonView';
import { HistoryNavigation, InvestigationView } from './features/investigation/InvestigationView';
import { defaultInvestigation, fileHistoryLocation, type InvestigationMemory, type InvestigationTab } from './features/investigation/options';
import { DiffView } from './features/changes/DiffView';
import { ChangeList } from './features/changes/ChangeList';
import { RepositoryActions } from './features/operations/RepositoryActions';
import { useOperations } from './features/operations/useOperations';
import { OperationDialog, OperationFeedback, OperationSelection } from './features/operations/OperationControls';
import { matchesFileFilter } from './features/changes/change-filter';
import { HistoryGraph, type LocateRequest } from './features/history/HistoryGraph';
import { RepositorySidebar } from './features/navigation/RepositorySidebar';
import { RepositorySwitcher } from './features/navigation/RepositorySwitcher';
import { historyScopeLabel } from './features/navigation/history-scope';
import { CommitSummary } from './features/history/CommitSummary';
import { useHistoryPaneLayout } from './features/history/useHistoryPaneLayout';
import { RepositoryController, RefreshQueue, type HistoryScope, type MainView, type FileListScope } from './state/repository-controller';
import type { ReadingOrigin } from './features/investigation/reading-memory';
import type { Resource, ResourceSetter } from './state/resource';

type SessionFields = { action: 'overview' } | { action: 'navigation' } | { action: 'change'; entryId: string; fingerprint: string } | { action: 'history'; scope: HistoryScope; ref?: string; order?: HistoryOrder; cursor?: string } | { action: 'commit'; oid: string } | { action: 'commit-change'; oid: string; entryId: string };
const invalidReadMessage = '读取结果与当前请求身份不匹配，结果未被采用。';
const empty = <T,>(): Resource<T> => ({ loading: false });
const allEntries = (overview: Overview) => Object.values(overview.changes).flat();
const timeLabel = (locale: string, value?: string) => value ? new Date(value).toLocaleTimeString(locale, { hour12: false }) : '尚未读取';

function Empty({ symbol = '↳', title, children }: { symbol?: string; title: string; children?: React.ReactNode }) {
  const { t } = useI18n(); return <div className="empty-state"><span className="empty-glyph" aria-hidden="true">{symbol}</span><h2>{t(title)}</h2>{children && <p>{children}</p>}</div>; }

export function App({ initialSessionId, ticket }: { initialSessionId?: string; ticket: string | null }) {
  const { t, locale, loadLanguage } = useI18n();
  const controller = useRef(new RepositoryController());
  const refreshQueue = useRef(new RefreshQueue());
  const fileScroll = useRef<HTMLDivElement>(null);
  const gate = useRef(new RequestGate());
  const focusGate = useRef(new RequestGate());
  const mainReads = useRef(new Map<string, string>());
  const refreshRequired = useRef(false);
  const watchState = useRef<{ revision: number; watching: boolean } | undefined>(undefined);
  const currentNavigation = useRef<Navigation | undefined>(undefined);
  const cancellation = useRef(new ReadCancellation());
  const comparisonCancelled = useRef(false);
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
  const [view, setView] = useState<MainView>('changes');
  const [readingOrigin, setReadingOrigin] = useState<ReadingOrigin>();
  const [historyView, setHistoryView] = useState<'history' | 'investigation'>('history');
  const [investigationOptions, setInvestigationOptions] = useState<InvestigationMemory>(defaultInvestigation);
  const showingCommitHistory = view === 'history';
  const [fileFilters, setFileFilters] = useState({ changes: '', history: '' });
  const [selected, setSelected] = useState<string>(); const [selectedCommit, setSelectedCommit] = useState<string>(); const [selectedCommitFile, setSelectedCommitFile] = useState<string>();
  const [repoPath, setRepoPath] = useState(''); const [showRepository, setShowRepository] = useState(false);
  const [info, setInfo] = useState<{ message: string; id: number }>();
  const noticeVersion = useRef(0);
  function notify(message: string) { setInfo({ message, id: ++noticeVersion.current }); }
  const locateVersion = useRef(0);
  const historyReadVersion = useRef(0);
  const [locateRequest, setLocateRequest] = useState<LocateRequest>();
  const [mobilePanel, setMobilePanel] = useState<'navigation' | 'list' | 'diff'>('list');
  const [historyDetailsOpen, setHistoryDetailsOpen] = useState(false);
  const historyPane = useHistoryPaneLayout();
  const [repositoryActivity, setRepositoryActivity] = useState<'picking' | 'opening' | null>(null);
  const [openError, setOpenError] = useState('');
  const [watchError, setWatchError] = useState('');
  const [watchEpoch, setWatchEpoch] = useState(0);
  const operations = useOperations({
    overview: overview.value,
    available: Boolean(session && overview.value && !overview.loading && !overview.stale && !overview.error && !overview.cancelled && overview.value.complete && !overview.value.changes.conflicts.length && !overview.value.operation.length && !repositoryActivity),
    beforeExecute: () => {
      refreshQueue.current.reset(); refreshRequired.current = false; pendingRefresh.current = false; focusGate.current.cancelAll(); gate.current.cancelAll();
      const stop = <T,>(setter: ResourceSetter<T>) => setter(previous => ({ ...previous, loading: false, stale: Boolean(previous.value) }));
      stop(setOverview); stop(setNavigation); stop(setHistory); stop(setCommit); stop(setDiff); stop(setCommitDiff);
    },
    afterExecute: receipt => {
      // The mandatory post-write read already observes this operation. Restart
      // polling so its queued notification cannot cancel the next preview.
      setWatchEpoch(value => value + 1);
      if (receipt?.kind === 'switch-branch') {
        selection.current = null; commitSelection.current = undefined; commitFileSelection.current = undefined;
        controller.current.clearSelection('changes'); controller.current.clearSelection('history');
        setSelected(undefined); setSelectedCommit(undefined); setSelectedCommitFile(undefined);
        setDiff(empty()); setCommit(empty()); setCommitDiff(empty()); setHistory(empty()); currentHistory.current = undefined;
        historyScope.current = 'head'; historyRef.current = undefined; historyOrder.current = 'topo'; setHistoryDetailsOpen(false); setView('changes'); setMobilePanel('list');
      }
      refreshQueue.current.reset(); refresh('recovery');
    },
  });
  const operationBusy = operations.state.phase === 'executing' || operations.state.phase === 'checking';

  async function copyText(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); notify(`已复制${label}。`); }
    catch { notify('无法访问剪贴板，请手动复制。'); }
  }
  function cancel(slot: ReadSlot) {
    if (operations.executing.current) return;
    refreshQueue.current.reset(); refreshRequired.current = false; pendingRefresh.current = false; focusGate.current.cancelAll();
    const stop = <T,>(setter: ResourceSetter<T>) => () => setter(previous => ({ ...previous, loading: false, error: undefined, cancelled: true, stale: Boolean(previous.value) }));
    const stops = { overview: stop(setOverview), navigation: stop(setNavigation), history: stop(setHistory), commit: stop(setCommit), diff: stop(setDiff), 'commit-diff': stop(setCommitDiff) };
    for (const target of cancellation.current.cancel(slot)) {
      gate.current.cancel(target);
      stops[target]();
    }
  }
  function retry(slot: Exclude<ReadSlot, 'diff' | 'commit-diff'>) {
    if (operations.executing.current) return;
    cancellation.current.resume(slot);
    if (slot === 'overview') loadOverview();
    else if (slot === 'navigation') loadNavigation();
    else if (slot === 'history') void loadHistory();
    else if (slot === 'commit') loadSelectedCommit(true);
  }
  async function query<T>(slot: ReadSlot, fields: SessionFields, schema: z.ZodType<T>, setter: ResourceSetter<T>, onSuccess?: (data: T) => void, keep = false) {
    const active = currentSession.current; if (!active || operations.executing.current || cancellation.current.isCancelled(slot)) return;
    const request = { ...fields, schemaVersion: 1, sessionId: active.sessionId, generation: active.generation, requestId: 'pending' } as ApiRequest;
    const identity = gate.current.begin(slot, queryKey(request, active.repository.worktreeId)); request.requestId = identity.requestId;
    if (slot === 'overview' || slot === 'navigation') mainReads.current.set(slot, identity.requestId);
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
        if (slot === 'overview') currentOverview.current = undefined;
        if (slot === 'navigation') currentNavigation.current = undefined;
        const mismatch = error instanceof ApiError && error.stamp && !gate.current.accepts(identity, error.stamp);
        if (!mismatch && error instanceof ApiError && error.detail.code === 'STALE_RESULT' && slot === 'diff' && staleRecoveries.current < 1) {
          recovering = true; staleRecoveries.current += 1;
          window.setTimeout(() => { if (gate.current.accepts(identity)) { refreshQueue.current.reset(); refresh('recovery'); } }, 0);
        } else {
          setter(previous => ({ ...previous, loading: false, error: mismatch ? invalidReadMessage : errorMessage(error), stale: Boolean(previous.value) }));
        }
      }
    } finally {
      if (mainReads.current.get(slot) === identity.requestId) mainReads.current.delete(slot);
      if (!recovering && gate.current.accepts(identity)) setter(previous => ({ ...previous, loading: false }));
    }
  }
  async function loadRecents(restore = false) {
    const identity = gate.current.begin('recents', 'recents');
    try { const result = await api({ schemaVersion: 1, action: 'recents', requestId: identity.requestId }, z.array(recentSchema), identity.controller.signal); if (gate.current.accepts(identity)) { setRecents(result.data); if (restore && !controller.current.explicitOpen && !repositoryBusy.current && !controller.current.pendingPath && !currentSession.current && result.data[0]) void openRepository(result.data[0].path, false); } } catch { /* Opening a repository remains available if local preferences are unavailable. */ }
  }
  function selectChange(entry: ChangeEntry, nextOverview = currentOverview.current, navigate = true, keep = false, automatic = false) {
    if (operations.executing.current || !entry.supported || !matchesFileFilter(entry, controller.current.fileFilter('changes'))) return;
    if (!automatic) operations.dismissPreview();
    if (!automatic) cancellation.current.resume('diff');
    selection.current = entry; setSelected(entry.id); if (navigate) setMobilePanel('diff'); if (!keep) staleRecoveries.current = 0;
    if (!nextOverview) return;
    void query('diff', { action: 'change', entryId: entry.id, fingerprint: nextOverview.fingerprint }, diffSchema, setDiff, undefined, keep);
  }
  function selectCommitFile(entry: ChangeEntry, oid = commitSelection.current, keep = false, automatic = false) {
    if (operations.executing.current || !oid || !entry.supported || !matchesFileFilter(entry, controller.current.fileFilter('history'))) return;
    if (!automatic) cancellation.current.resume('commit-diff');
    commitFileSelection.current = entry; setSelectedCommitFile(entry.id);
    void query('commit-diff', { action: 'commit-change', oid, entryId: entry.id }, diffSchema, setCommitDiff, undefined, keep);
  }
  function clearFileSelection(scope: FileListScope) {
    if (operations.executing.current) return;
    controller.current.clearSelection(scope);
    cancellation.current.resume(scope === 'changes' ? 'diff' : 'commit-diff');
    if (scope === 'changes') { gate.current.cancel('diff'); selection.current = null; setSelected(undefined); setDiff(empty()); }
    else { gate.current.cancel('commit-diff'); commitFileSelection.current = null; setSelectedCommitFile(undefined); setCommitDiff(empty()); }
  }
  function filterFiles(scope: FileListScope, value: string) {
    if (operations.executing.current) return;
    if (scope === 'changes') operations.invalidate();
    controller.current.fileFilter(scope, value);
    setFileFilters(previous => ({ ...previous, [scope]: value }));
    const entry = scope === 'changes' ? selection.current : commitFileSelection.current;
    if (entry && !matchesFileFilter(entry, value)) clearFileSelection(scope);
  }
  function selectCommit(node: Pick<CommitNode, 'oid'>, activate = true) {
    if (operations.executing.current) return;
    setReadingOrigin(undefined);
    commitSelection.current = node.oid; setSelectedCommit(node.oid); if (activate) { setHistoryDetailsOpen(true); setMobilePanel('diff'); }
    gate.current.cancel('commit-diff'); setCommitDiff(empty()); setSelectedCommitFile(undefined); commitFileSelection.current = undefined;
    cancellation.current.resume('commit');
    loadSelectedCommit(false);
  }
  function rememberInvestigation(options: InvestigationMemory) { controller.current.investigation(options); setInvestigationOptions(options); }
  function showHistoryTab(tab: InvestigationTab | 'commits') {
    if (operations.executing.current) return;
    if (tab === 'commits') { setHistoryView('history'); setView('history'); }
    else { setReadingOrigin(undefined); rememberInvestigation({ ...controller.current.investigation(), tab }); setHistoryView('investigation'); setView('investigation'); }
    setMobilePanel('list');
    if (tab === 'commits' && !history.value && !history.loading) retry('history');
  }
  function openHistoryCommit(node: Pick<CommitNode, 'oid'>, origin?: ReadingOrigin) {
    showHistoryTab('commits'); selectCommit(node); setReadingOrigin(origin);
  }
  function returnToReading() {
    if (!readingOrigin || operations.executing.current) return;
    const memory = controller.current.investigationReading()[readingOrigin.tab];
    if (memory) memory.position.restoreFocus = readingOrigin.focus;
    showHistoryTab(readingOrigin.tab); setMobilePanel(readingOrigin.tab === 'file' ? 'diff' : 'list'); setReadingOrigin(undefined);
  }
  function investigateFile(diff: Diff) {
    const head = currentOverview.current?.head;
    const file = fileHistoryLocation(diff, head && head.kind !== 'unborn' ? head.oid : undefined);
    if (!file) return;
    if (JSON.stringify(controller.current.investigation().file) !== JSON.stringify(file)) controller.current.investigationReading().file = undefined;
    setReadingOrigin(undefined);
    rememberInvestigation({ ...controller.current.investigation(), tab: 'file', file }); setHistoryView('investigation'); setView('investigation'); setMobilePanel('list');
  }
  function closeHistoryDetails() {
    setHistoryDetailsOpen(false); setMobilePanel('list');
    requestAnimationFrame(() => {
      const workspace = historyPane.workspaceRef.current;
      const target = workspace?.querySelector<HTMLElement>('.commit-row[aria-pressed="true"]') || workspace?.querySelector<HTMLElement>('.history-scroll');
      target?.focus({ preventScroll: true });
    });
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
    const active = currentSession.current; if (!active || operations.executing.current || cancellation.current.isCancelled('history')) return;
    historyReadVersion.current++;
    const selectedRef = scope === 'ref' ? ref : undefined;
    const scopeChanged = scope !== historyScope.current || selectedRef !== historyRef.current || order !== historyOrder.current;
    historyScope.current = scope; historyRef.current = selectedRef; historyOrder.current = order;
    if (scope === 'all') allHistoryOrder.current = order;
    if (scopeChanged) { setHistoryDetailsOpen(false); cancellation.current.resume('commit'); setLocateRequest(undefined); gate.current.cancel('commit'); gate.current.cancel('commit-diff'); commitSelection.current = undefined; commitFileSelection.current = undefined; setSelectedCommit(undefined); setSelectedCommitFile(undefined); setCommit(empty()); setCommitDiff(empty()); currentHistory.current = undefined; }
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
    const historyVersion = historyReadVersion.current;
    void query('overview', { action: 'overview' }, overviewSchema, setOverview, data => {
      currentOverview.current = data;
      const previous = selection.current; const retained = previous && allEntries(data).find(entry => entry.id === previous.id && entry.supported && matchesFileFilter(entry, controller.current.fileFilter('changes')));
      if (retained) selectChange(retained, data, false, true, true);
      else if (previous) { clearFileSelection('changes'); notify('此前选中的文件已不在当前改动中。请从最新列表重新选择。'); }
      else if (previous === undefined) { const first = allEntries(data).find(entry => entry.supported && matchesFileFilter(entry, controller.current.fileFilter('changes'))); if (first) selectChange(first, data, false, false, true); }
      // A history read started after this overview already owns the user's range/page.
      if (loadGraph && historyVersion === historyReadVersion.current) loadHistory();
    }, true);
  }
  function loadNavigation() { void query('navigation', { action: 'navigation' }, navigationSchema, setNavigation, data => { currentNavigation.current = data; }, true); }
  function filterHistory(scope: HistoryScope, ref?: string) { if (operations.executing.current) return; cancellation.current.resume('history'); showHistoryTab('commits'); loadHistory(scope, undefined, false, ref); }
  function sortHistory(order: HistoryOrder) { if (operations.executing.current) return; cancellation.current.resume('history'); void loadHistory('all', undefined, false, undefined, order); }
  function adoptSession(next: RepositorySession) {
    operations.activate(next);
    setHistoryDetailsOpen(false); setReadingOrigin(undefined);
    refreshQueue.current.reset(); cancellation.current.reset(); pendingRefresh.current = false; setLocateRequest(undefined); currentSession.current = next; setSession(next); currentOverview.current = undefined; currentNavigation.current = undefined; watchState.current = undefined; refreshRequired.current = false; mainReads.current.clear(); currentHistory.current = undefined;
    gate.current.setContext(next.sessionId, next.generation); focusGate.current.setContext(next.sessionId, next.generation);
    const memory = controller.current.activate(next.repository.worktreeId);
    setHistoryView(memory.historyView ?? (memory.view === 'investigation' ? 'investigation' : 'history'));
    setInvestigationOptions(memory.investigation ?? defaultInvestigation());
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
    if (operations.executing.current) return;
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
    if (operations.executing.current) return;
    if (source === 'focus' && (cancellation.current.hasCancelled() || comparisonCancelled.current)) return;
    if (repositoryBusy.current) { pendingRefresh.current = true; return; }
    if (!currentSession.current) return;
    if (source !== 'focus') refreshRequired.current = true;
    refreshQueue.current.request(() => { if (refreshRequired.current) performRefresh(); else void checkFocusRefresh(); });
  }
  async function checkFocusRefresh() {
    const active = currentSession.current;
    if (!active || operations.executing.current || repositoryBusy.current || cancellation.current.hasCancelled() || comparisonCancelled.current) return;
    // An in-flight overview/navigation already observes the repository; a probe
    // with the same query key would otherwise cancel it in the local process.
    if (mainReads.current.size) return;
    const beforeOverview = currentOverview.current; const beforeNavigation = currentNavigation.current; const beforeWatch = watchState.current;
    if (!beforeOverview || !beforeNavigation || !beforeWatch?.watching) { performRefresh(); return; }
    const context = active; const probe = focusGate.current.begin('probe', 'focus');
    async function observe<T>(action: 'overview' | 'navigation', schema: z.ZodType<T>) {
      const request = { schemaVersion: 1 as const, action, sessionId: context.sessionId, generation: context.generation, requestId: 'pending' };
      const identity = focusGate.current.begin(action, queryKey(request, context.repository.worktreeId)); request.requestId = identity.requestId;
      const response = await api(request, schema, identity.controller.signal);
      if (!response.stamp || !focusGate.current.accepts(identity, response.stamp)) throw new Error(invalidReadMessage);
      return response.data;
    }
    try {
      const [nextOverview, nextNavigation, nextWatch] = await Promise.all([
        observe('overview', overviewSchema), observe('navigation', navigationSchema), readRepositoryWatch(active.sessionId, probe.controller.signal),
      ]);
      if (!focusGate.current.accepts(probe) || mainReads.current.size || repositoryBusy.current || operations.executing.current) return;
      const unchanged = nextWatch.watching && nextWatch.revision === beforeWatch.revision &&
        JSON.stringify(rawOverviewSchema.parse(beforeOverview)) === JSON.stringify(rawOverviewSchema.parse(nextOverview)) &&
        JSON.stringify(beforeNavigation) === JSON.stringify(nextNavigation);
      if (!unchanged || refreshRequired.current) performRefresh();
    } catch {
      // Failed or mismatched checks cannot establish freshness. The normal read
      // path exposes a persistent failure while retaining old content as stale.
      if (focusGate.current.accepts(probe) && !mainReads.current.size) performRefresh();
    } finally { if (focusGate.current.accepts(probe)) focusGate.current.cancelAll(); }
  }
  function performRefresh() {
    if (operations.executing.current) return;
    refreshRequired.current = false; focusGate.current.cancelAll(); mainReads.current.clear();
    operations.invalidate('仓库状态已更新，请重新选择并预览。');
    if (repositoryBusy.current) { pendingRefresh.current = true; return; }
    const active = currentSession.current; if (!active) return;
    const next = { ...active, generation: active.generation + 1 }; currentSession.current = next; setSession(next);
    gate.current.setContext(next.sessionId, next.generation); focusGate.current.setContext(next.sessionId, next.generation);
    cancellation.current.reset();
    setInfo(undefined); setDiff(previous => ({ ...previous, stale: Boolean(previous.value), loading: false, cancelled: false, error: undefined }));
    setHistory(previous => ({ ...previous, stale: Boolean(previous.value), loading: false, cancelled: false, error: undefined }));
    setCommit(previous => ({ ...previous, stale: Boolean(previous.value), loading: false, cancelled: false, error: undefined })); setCommitDiff(previous => ({ ...previous, stale: Boolean(previous.value), loading: false, cancelled: false, error: undefined }));
    loadOverview(); loadNavigation();
    if (commitSelection.current) loadSelectedCommit(true);
  }
  function locateHead() {
    if (operations.executing.current) return;
    setView('history'); setMobilePanel('list'); const head = currentOverview.current?.head;
    if (!head || head.kind === 'unborn') { notify('仓库尚无首次提交，目前没有可定位的 HEAD 提交。'); return; }
    const target = history.value?.commits.find(node => node.oid === head.oid);
    if (target) { selectCommit(target, false); requestLocate(target.oid); }
    else { notify('当前窗口未包含 HEAD，已切换为仅从当前 HEAD 出发的历史。'); cancellation.current.resume('history'); loadHistory('head', undefined, true); }
  }

  useEffect(() => {
    if (started.current) return; started.current = true;
    void bootstrap(initialSessionId || '', ticket).then(async initial => { await loadLanguage(); bootstrapDone.current = true; setStartup({ loading: false }); const pending = controller.current.pendingPath; controller.current.pendingPath = undefined; if (initial) adoptSession(initial); if (pending && pending !== initial?.repository.worktreeRoot) void openRepository(pending); else if (!initial) { setShowRepository(true); void loadRecents(true); } }).catch(error => { bootstrapDone.current = true; setStartup({ loading: false, error: errorMessage(error) }); });
    // Bootstrap runs exactly once; the single-use ticket is never retained in the URL.
  }, []);
  useEffect(() => {
    setWatchError('');
    if (!session) return;
    return subscribeRepositoryInvalidation(session.sessionId, () => { if (currentSession.current?.sessionId === session.sessionId) refresh('change'); }, error => { if (currentSession.current?.sessionId === session.sessionId) { watchState.current = undefined; setWatchError(`${errorMessage(error)} 自动更新已停止，可手动刷新或重新打开仓库。`); } }, state => {
      if (currentSession.current?.sessionId !== session.sessionId) return;
      if (watchState.current && watchState.current.revision !== state.revision) refreshRequired.current = true;
      watchState.current = state;
    });
  }, [session?.sessionId, watchEpoch]);
  useEffect(() => {
    if (session) controller.current.save({ view, historyView, scope: historyScope.current, ref: historyRef.current, allHistoryOrder: allHistoryOrder.current, selection: selection.current, commit: commitSelection.current, commitFile: commitFileSelection.current });
  }, [session, view, historyView, selected, selectedCommit, selectedCommitFile, history.value, commit.value, fileFilters, historyScope.current, historyRef.current, allHistoryOrder.current]);
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
    function pageHide() { cancelRepositoryOpen(false); refreshQueue.current.reset(); refreshRequired.current = false; focusGate.current.cancelAll(); gate.current.cancelAll(); }
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    window.addEventListener('pagehide', pageHide);
    const heartbeat = window.setInterval(() => { void api({ schemaVersion: 1, action: 'heartbeat', requestId: crypto.randomUUID() }, z.object({ alive: z.boolean() })).catch(() => undefined); }, 60_000);
    return () => {
      window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus);
      window.removeEventListener('pagehide', pageHide); window.clearInterval(heartbeat);
      repositoryGate.current.cancelAll(); repositoryBusy.current = false; refreshQueue.current.reset(); refreshRequired.current = false; focusGate.current.cancelAll(); gate.current.cancelAll();
    };
  }, []);

  useEffect(() => {
    if (!info) return;
    const timer = window.setTimeout(() => setInfo(current => current?.id === info.id ? undefined : current), FEEDBACK_TIMING.notificationMs);
    return () => window.clearTimeout(timer);
  }, [info]);

  const data = overview.value;
  const opening = repositoryActivity !== null;
  useEffect(() => {
    if (!showingCommitHistory || !historyDetailsOpen || showRepository || opening) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      // Let the separator cancel an active drag and dialogs consume Escape first.
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); closeHistoryDetails(); }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [showingCommitHistory, historyDetailsOpen, showRepository, opening]);
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
  const commitFeedback = <ReadFeedback state={commit} hasValue={Boolean(commit.value)} scope={t("提交详情")} compact className="commit-read-state" onRetry={() => retry('commit')} onCancel={() => cancel('commit')}/>;

  return <div className="app-shell">
    <header className="app-header" inert={operationBusy}>
      <span className="app-mark" title="Git View" aria-label="Git View"><svg viewBox="0 0 30 30" aria-hidden="true"><path d="M8 5v13a6 6 0 0 0 6 6h7M8 11h8a5 5 0 0 0 5-5"/><circle cx="8" cy="5" r="3"/><circle cx="21" cy="5" r="3"/><circle cx="22" cy="24" r="3"/></svg></span>
      <RepositorySwitcher root={session?.repository.worktreeRoot} recents={recents} worktrees={navigation.value?.worktrees} open={showRepository}
        onOpenChange={open => { setShowRepository(open); if (open) void loadRecents(); }} onOpen={path => void openRepository(path)}
        onCopyPath={() => { if (session) copyText(session.repository.worktreeRoot, '仓库路径'); }} busy={opening} disabled={operationBusy || startup.loading || Boolean(startup.error)}
        repoPath={repoPath} onRepoPathChange={setRepoPath} error={openError}/>
      {session && <div className="head-line" aria-label={t("仓库当前位置")}><span className="head-caption">{data?.head.kind === 'detached' ? t('当前位置') : t('当前分支')}</span><RepositoryActions mode="branch" label={branch || t('读取分支中')} operations={operations} overview={data} navigation={navigation.value}/><code title={headOid}>{head ? (data?.head.kind === 'unborn' ? t(head) : head) : '—'}</code></div>}
      <div className="toolbar-status"><span className="readonly">{t("本地 Git")}</span><LanguageSelector/>
        {session && <div className="read-status"><ReadFeedback state={overview} hasValue={Boolean(data)} scope={t("仓库状态")} compact className="overview-read-state" idleLabel={data ? t(`读取于 ${timeLabel(locale, data.stamp.finishedAt)}`) : undefined} onRetry={() => retry('overview')} onCancel={() => cancel('overview')}/><button className="refresh-button" onClick={() => refresh()} disabled={opening || operationBusy} aria-label={t("刷新仓库")}><span aria-hidden="true">↻</span> {t(" 刷新")}</button></div>}
      </div>
    </header>

    {startup.error ? <main className="startup"><Empty symbol="↻" title={t("需要重新连接本地进程")}>{t(startup.error)}</Empty><p className="restart-command"><code>{t("git-view open --repo &lt;仓库路径&gt;")}</code></p></main> : <>
      {opening && <div className="repository-opening notice" role="status">
        <span><span className="spinner" />{repositoryActivity === 'picking' ? t('请在系统窗口中选择仓库文件夹。') : t('正在验证所选文件夹并读取仓库…')}</span>
        <button onClick={() => cancelRepositoryOpen()}>{t("取消")}</button>
      </div>}
      {session && <div className={`repository-layout ${showingCommitHistory ? 'with-history-scope' : 'without-history-scope'} mobile-${mobilePanel}`} inert={operationBusy}>
        {showingCommitHistory && <RepositorySidebar key={session.repository.worktreeId} initialSearch={controller.current.search()} onSearch={value => controller.current.search(value)} navigation={navigation.value} scope={historyScope.current} selectedRef={historyRef.current} readState={navigation} onFilter={filterHistory} onRetry={() => retry('navigation')} onCancel={() => cancel('navigation')}/>}
        <div className="repository-main">
        {data && (data.operation.length > 0 || !data.complete || data.changes.conflicts.length > 0) && <div className="operation-banner" role="status">{data.operation.length > 0 && <strong>{t("进行中的操作：")}{data.operation.join('、')}。 </strong>}{data.changes.conflicts.length > 0 && <strong>{data.changes.conflicts.length} {t(" 个未解决冲突。 ")}</strong>}{!data.complete && <strong>{t("当前观测不完整。 ")}</strong>}{data.warnings.map(warning => t(warning)).join(' ')}</div>}
        <OperationFeedback operations={operations}/>
        {watchError && <div className="operation-banner" role="alert">{t(watchError)}</div>}
        {info && <div className="feedback-toast" role="status"><span>{t(info.message)}</span></div>}
        <div className="view-navigation"><nav className="view-tabs" aria-label={t("主视图")}>
          <button className={view === 'changes' ? 'active' : ''} aria-pressed={view === 'changes'} onClick={() => { setView('changes'); setMobilePanel('list'); }}>{t("当前改动 ")}<span>{total}</span></button>
          <button className={view === 'history' || view === 'investigation' ? 'active' : ''} aria-pressed={view === 'history' || view === 'investigation'} onClick={() => showHistoryTab(historyView === 'history' ? 'commits' : investigationOptions.tab)}>{t('历史')}</button>
          <button className={view === 'comparison' ? 'active' : ''} aria-pressed={view === 'comparison'} onClick={() => { setView('comparison'); setMobilePanel('list'); }}>{t('版本比较')}</button>
        </nav><div className="view-actions">
          {showingCommitHistory && readingOrigin && <button disabled={operationBusy} onClick={returnToReading}><span aria-hidden="true">← </span>{t(readingOrigin.tab === 'search' ? '返回搜索结果' : '返回文件历史')}</button>}
          {view === 'changes' && <RepositoryActions mode="commit" operations={operations} overview={data}/>}
          {showingCommitHistory && <button className="locate-button" disabled={!headOid || history.loading} title={headInHistory ? t('选中并定位当前 HEAD') : t('查看从当前 HEAD 出发的历史')} onClick={locateHead}>{headInHistory ? t('定位 HEAD') : t('查看 HEAD 历史')}</button>}
          {showingCommitHistory && selectedCommit && !historyDetailsOpen && <button className="history-open-details" onClick={() => { setHistoryDetailsOpen(true); setMobilePanel('diff'); }}>{t("查看提交详情")}</button>}
        </div></div>
        {(view === 'history' || view === 'investigation') && <HistoryNavigation options={investigationOptions} commits={showingCommitHistory} blocked={operationBusy} onSelect={showHistoryTab}/>}
        {(view !== 'investigation' || investigationOptions.tab !== 'search') && <nav className="mobile-tabs" aria-label={t("窄窗口面板")}>
          {showingCommitHistory && <button className={mobilePanel === 'navigation' ? 'active' : ''} onClick={() => setMobilePanel('navigation')}>{t("历史范围")}</button>}
          <button className={mobilePanel === 'list' ? 'active' : ''} onClick={() => setMobilePanel('list')}>{showingCommitHistory ? t('提交列表') : view === 'investigation' ? t('记录列表') : t('文件列表')}</button>
          <button className={mobilePanel === 'diff' ? 'active' : ''} disabled={showingCommitHistory && !selectedCommit} onClick={() => { setMobilePanel('diff'); if (showingCommitHistory) setHistoryDetailsOpen(true); }}>{t("查看详情")}</button>
        </nav>}

        {view === 'comparison' ? <ComparisonView key={session.sessionId} session={session} navigation={navigation.value} initialOptions={controller.current.comparison()} initialCommit={selectedCommit} blocked={operationBusy} mobilePanel={mobilePanel} onShowDiff={() => setMobilePanel('diff')} onSelectCommit={openHistoryCommit} onFileHistory={investigateFile} onOptionsChange={options => controller.current.comparison(options)} onCancellation={cancelled => { comparisonCancelled.current = cancelled; }}/> : view === 'investigation' ? <InvestigationView key={session.sessionId} session={session} navigation={navigation.value} options={investigationOptions} memory={controller.current.investigationReading()} blocked={operationBusy} mobilePanel={mobilePanel} onChange={rememberInvestigation} onShowDetail={() => setMobilePanel('diff')} onOpenCommit={(oid, origin) => openHistoryCommit({ oid }, origin)} onCompare={options => { controller.current.comparison(options); setView('comparison'); setMobilePanel('list'); }} onCancellation={cancelled => { comparisonCancelled.current = cancelled; }}/> : <main ref={historyPane.workspaceRef} style={view === 'history' ? historyPane.workspaceStyle : undefined} data-details={historyDetailsOpen ? 'open' : 'closed'} className={`workspace ${view === 'history' ? 'history-workspace' : ''} mobile-${mobilePanel}`}>
          <aside className="list-panel">
            {view === 'changes' ? <><div className="panel-heading"><h2>{t("文件变化")}</h2><span>{total} {t(" 项比较")}</span></div>{data ? <ChangeList scope="changes" operations={operations} actions={<OperationSelection operations={operations}/>} disabled={operationBusy} changes={data.changes} filter={fileFilters.changes} onFilter={value => filterFiles('changes', value)} selected={selected} onSelect={(entry, activate) => selectChange(entry, currentOverview.current, activate)} scrollRef={fileScroll} onScroll={top => controller.current.scroll('changes', top)}/> : <p className="panel-wait">{overview.loading ? t('正在读取工作区…') : t('读取概览后显示文件。')}</p>}</> : <><div className="panel-heading"><h2>{t("提交关系")}</h2><div className="history-heading-controls"><span className="history-range-label"><span>{historyScope.current === 'ref' ? historyScopeLabel(historyScope.current, historyRef.current) : t(historyScopeLabel(historyScope.current))}</span></span>{historyScope.current === 'all' && <select aria-label={t("历史排序")} className="history-order" value={allHistoryOrder.current} title={t("时间优先：优先展示较新的提交，保留父子关系。分支聚合：尽量连续展示同一条历史线。")} onChange={event => { const order = event.target.value; if (order === 'date' || order === 'topo') sortHistory(order); }}><option value="date">{t("时间优先")}</option><option value="topo">{t("分支聚合")}</option></select>}</div></div><ReadFeedback state={history} hasValue={Boolean(history.value)} scope={t("提交历史")} className="history-read-state" onRetry={() => retry('history')} onCancel={() => cancel('history')}/>{history.value?.shallow && <div className="history-boundary-note">{t("浅克隆 · 历史不完整")}</div>}{history.value?.commits.length ? <HistoryGraph fullWidth={!historyDetailsOpen} commits={history.value.commits} selected={selectedCommit} headOid={history.value.headOid} onSelect={selectCommit} key={`${session.repository.worktreeId}:${historyScope.current}:${historyRef.current || ''}:${historyOrder.current}`} locateRequest={locateRequest} onLocateConsumed={version => setLocateRequest(current => current?.version === version ? undefined : current)} initialTop={controller.current.position(`history:${historyScope.current}:${historyRef.current || ''}:${historyOrder.current}`)} onScroll={top => controller.current.scroll(`history:${historyScope.current}:${historyRef.current || ''}:${historyOrder.current}`, top)}/> : history.value && !history.loading && !history.error && !history.stale && <Empty title={data?.head.kind === 'unborn' ? t('仓库尚无提交') : t('当前范围内无提交')}/>}{history.value && <div className="history-pagination"><span className="history-loaded-count">{t('已加载 {0} 条提交', [history.value.commits.length])}</span>{history.value.nextCursor && <button className="load-more" disabled={history.loading} onClick={() => { cancellation.current.resume('history'); void loadHistory(historyScope.current, history.value?.nextCursor); }}>{t("继续加载 200 条 ")}<span>↓</span></button>}</div>}</>}
          </aside>

          {view === 'history' && historyDetailsOpen && historyPane.separator}
          <section className="detail-panel" aria-label={t("所选内容详情")} hidden={view === 'history' && !historyDetailsOpen}>
            {view === 'history' && <div className="history-detail-toolbar"><span>{t("提交详情")}</span><button aria-label={t("关闭提交详情")} title={t("关闭提交详情（Esc）")} onClick={closeHistoryDetails}><span aria-hidden="true">×</span> {t(" 关闭")}</button></div>}
            {view === 'history' && <>{commit.value ? <CommitSummary key={commit.value.commit.oid} detail={commit.value} onCopy={value => copyText(value, '提交 ID')} status={commitFeedback}><ChangeList scope="history" entries={commit.value.changes} filter={fileFilters.history} onFilter={value => filterFiles('history', value)} selected={selectedCommitFile} onSelect={entry => selectCommitFile(entry)}/></CommitSummary> : selectedCommit && commitFeedback}</>}

            <ReadFeedback state={diffFeedback} hasValue={Boolean(activeDiff.value)} scope={t("文件差异")} className="diff-read-state" onRetry={retryDiff} onCancel={() => cancel(view === 'changes' ? 'diff' : 'commit-diff')}/>
            {activeDiff.value ? <div className={activeDiff.stale ? 'stale-content' : ''}><DiffView diff={activeDiff.value} actions={fileHistoryLocation(activeDiff.value, headOid) && <button className="file-history-action" disabled={operationBusy || activeDiff.stale || activeDiff.loading} onClick={() => investigateFile(activeDiff.value!)}>{t('文件历史')}</button>} observedAt={activeDiff.stamp?.finishedAt} positionKey={JSON.stringify([session.repository.worktreeId, view, activeDiff.value.comparison, activeDiff.value.entry.id, activeDiff.value.base, activeDiff.value.target])}/></div> : !diffFeedback.loading && (view === 'changes' ? (data && total === 0 && data.complete && !overview.stale && !overview.error && !overview.loading ? <Empty symbol="✓" title={t("工作区干净")}><button className="button inline-button" onClick={() => showHistoryTab('commits')}>{t("查看最近提交 →")}</button></Empty> : <Empty title={t("未选择文件")}/>) : commit.value ? <Empty title={t("未选择文件")}/> : <Empty symbol="⑂" title={t("未选择提交")}/>)}
          </section>

        </main>}
      </div></div>}
      {startup.loading && <Empty title={t("正在连接本地仓库…")}/>}
      {!startup.loading && !session && <Empty symbol="⑂" title={t("尚未打开仓库")}/>}
    </>}
    <OperationDialog operations={operations}/>
  </div>;
}
