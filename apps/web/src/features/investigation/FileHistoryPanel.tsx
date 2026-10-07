import { useEffect, useRef, useState } from 'react';
import { blameSchema, diffSchema, fileHistoryOptionsSchema, fileHistoryPageSchema, type Blame, type Diff, type FileHistoryEntry, type FileHistoryOptions, type FileHistoryPage, type FileSide, type Navigation, type RepositorySession } from '@git-view/contracts';
import { useI18n } from '../../i18n';
import { ReadFeedback } from '../feedback/ReadFeedback';
import { DiffView } from '../changes/DiffView';
import { RevisionPicker } from '../navigation/RevisionPicker';
import { InvestigationList } from './InvestigationList';
import { BlameView } from './BlameView';
import { useInvestigationReads, type Resource } from './useInvestigationReads';
import { mergeFiles } from './paging';
import { restoredResource, type InvestigationReadingMemory, type OpenInvestigationCommit } from './reading-memory';
import { useReadingSurface } from './useReadingSurface';

export function FileHistoryPanel({ session, navigation, initial, blocked, memory, mobilePanel, onChange, onShowDetail, onOpenCommit, onCancellation }: { session: RepositorySession; navigation?: Navigation; initial?: FileHistoryOptions; blocked: boolean; memory: InvestigationReadingMemory; mobilePanel: 'navigation' | 'list' | 'diff'; onChange: (value: FileHistoryOptions) => void; onShowDetail: () => void; onOpenCommit: OpenInvestigationCommit; onCancellation: (cancelled: boolean) => void }) {
  const { t } = useI18n(); const [options, setOptions] = useState<FileHistoryOptions>(() => initial ?? { endpoint: { kind: 'head' }, path: '' });
  const cache = useRef(memory.file ??= { position: { pageTop: 0, scroll: {} }, applied: initial && fileHistoryOptionsSchema.safeParse(initial).success ? initial : undefined }).current;
  const [history, setHistory] = useState<Resource<FileHistoryPage>>(() => restoredResource(cache.history)); const [diff, setDiff] = useState<Resource<Diff>>(() => restoredResource(cache.diff)); const [blame, setBlame] = useState<Resource<Blame>>(() => restoredResource(cache.blame));
  const [selectedId, setSelectedId] = useState(cache.selected); const selected = useRef(cache.history?.value?.entries.find(item => item.entryId === cache.selected)); const snapshot = useRef(cache.history?.value); const count = useRef(cache.history?.value?.entries.length ?? 0);
  const [content, setContent] = useState<'diff' | FileSide>(cache.content ?? 'diff'); const contentRef = useRef(content); contentRef.current = content;
  const applied = useRef(cache.applied);
  const read = useInvestigationReads(session, blocked, onCancellation, [cache.history?.cancelled && 'list', cache.diff?.cancelled && 'diff', cache.blame?.cancelled && 'blame'].filter((slot): slot is string => typeof slot === 'string'));
  const contextChanged = Boolean(cache.context && (cache.context.sessionId !== session.sessionId || cache.context.generation !== session.generation));
  const surface = useReadingSurface(cache.position, Boolean(history.value), read.fresh(history) && (!selectedId || (content === 'diff' ? read.fresh(diff) : read.fresh(blame))));
  useEffect(() => { cache.context = { sessionId: session.sessionId, generation: session.generation }; cache.history = history; cache.diff = diff; cache.blame = blame; cache.applied = applied.current; cache.selected = selectedId; cache.content = content; }, [history, diff, blame, selectedId, content]);
  function openCommit(oid: string, focus = 'commit') { cache.position.pageTop = window.scrollY; onOpenCommit(oid, { tab: 'file', focus }); }
  function clearChildren(keep = false) { read.clear('diff', setDiff, keep); read.clear('blame', setBlame, keep); if (!keep) { selected.current = undefined; setSelectedId(undefined); } }
  function select(item: FileHistoryEntry, activate = false, keep = false, view = contentRef.current) {
    if (!snapshot.current || !item.change.supported) return;
    if (view === 'before' && (!item.base || item.change.kind.startsWith('A'))) { view = item.change.kind.startsWith('D') ? 'diff' : 'after'; contentRef.current = view; setContent(view); }
    if (view === 'after' && item.change.kind.startsWith('D')) { view = item.base ? 'before' : 'diff'; contentRef.current = view; setContent(view); }
    if (selected.current?.entryId !== item.entryId) { delete cache.position.scroll.diff; delete cache.position.scroll.blame; }
    selected.current = item; cache.selected = item.entryId; setSelectedId(item.entryId); if (activate) onShowDetail();
    if (view === 'diff') read.clear('blame', setBlame); else read.clear('diff', setDiff);
    if (view === 'diff') void read.query('diff', { action: 'file-history-change', snapshotId: snapshot.current.snapshotId, entryId: item.entryId }, diffSchema, setDiff, { keep });
    else void read.query('blame', { action: 'blame', snapshotId: snapshot.current.snapshotId, entryId: item.entryId, side: view }, blameSchema, setBlame, { keep });
  }
  function load(value: FileHistoryOptions, keep = false, cursor?: string) {
    applied.current = value; snapshot.current = undefined; clearChildren(keep || Boolean(cursor));
    void read.query('list', { action: 'file-history', ...value, cursor }, fileHistoryPageSchema, setHistory, { keep: keep || Boolean(cursor), pager: { count: page => page.entries.length, cursor: page => page.nextCursor, merge: mergeFiles, reloadTo: keep ? count.current : 0, appendTo: cursor ? history.value : undefined }, success: page => {
      snapshot.current = page; count.current = page.entries.length;
      const previous = selected.current; const item = page.entries.find(item => item.entryId === previous?.entryId) ?? page.entries.find(item => item.change.supported);
      if (item) select(item, false, keep && item.entryId === previous?.entryId); else { selected.current = undefined; setSelectedId(undefined); clearChildren(); }
    } });
  }
  function edit(next: FileHistoryOptions) { applied.current = undefined; cache.applied = undefined; cache.position.scroll = {}; snapshot.current = undefined; count.current = 0; clearChildren(); read.clear('list', setHistory); read.resume(); setOptions(next); onChange(next); }
  function cancelList() { read.cancel('list', setHistory); read.cancel('diff', setDiff); read.cancel('blame', setBlame); snapshot.current = undefined; }
  useEffect(() => {
    if (blocked) { snapshot.current = undefined; read.clear('list', setHistory, true); clearChildren(true); }
    else if (applied.current && !read.fresh(history) && (contextChanged || !history.cancelled && !history.error)) { read.resume(); load(applied.current, true); }
    else if (read.fresh(history) && selected.current) {
      const child = contentRef.current === 'diff' ? diff : blame;
      if (!(contentRef.current === 'diff' ? read.fresh(diff) : read.fresh(blame)) && !child.cancelled && !child.error) select(selected.current, false, true);
    }
  }, [session.sessionId, session.generation, blocked]);
  const page = history.value; const fresh = read.fresh(history); const item = page?.entries.find(item => item.entryId === selectedId); const valid = fileHistoryOptionsSchema.safeParse(options).success;
  function changeContent(value: 'diff' | FileSide) { contentRef.current = value; cache.content = value; setContent(value); if (selected.current && fresh) select(selected.current, false, false, value); }
  return <section className="investigation-file" {...surface}>
    <form className="investigation-form file-history-form" aria-label={t('文件历史')} onSubmit={event => { event.preventDefault(); if (valid) { onChange(options); read.resume(); load(options); } }}>
      <RevisionPicker id="file-history-endpoint" label={t('文件历史版本')} commitLabel={t('文件历史提交 ID')} value={options.endpoint} navigation={navigation} disabled={blocked} onChange={endpoint => edit({ ...options, endpoint })}/>
      <input aria-label={t('文件历史路径')} value={options.path} placeholder={t('精确仓库内路径')} spellCheck={false} maxLength={32768} disabled={blocked} onChange={event => edit({ ...options, path: event.target.value })}/>
      <button className="button" disabled={!valid || blocked || history.loading}>{t('查看历史')}</button>
    </form>
    <ReadFeedback className="investigation-read" state={history} hasValue={Boolean(page)} scope={t('文件历史')} onCancel={cancelList} onRetry={() => { if (valid) { read.resume(); load(options, true); } }}/>
    {page && <><div className={`investigation-summary ${fresh ? '' : 'stale-content'}`}><strong>{page.path}</strong><code title={page.tipOid}>{page.tipOid.slice(0, 10)}</code><span>{t('第一父链')}</span></div>{page.warnings.map(warning => <p key={warning} className="investigation-limitation">{t(warning)}</p>)}</>}
    <main className={`workspace investigation-workspace mobile-${mobilePanel}`}>
      <aside className="list-panel"><InvestigationList items={page?.entries ?? []} itemKey={item => item.entryId} selected={selectedId} label={t('文件历史记录')} disabled={!fresh} onSelect={(item, activate) => select(item, activate)} render={item => <><code title={item.commit.oid}>{item.commit.oid.slice(0, 10)}</code><span>{item.commit.subject}<small>{item.change.path}{item.change.oldPath && ` ← ${item.change.oldPath}`}</small></span><small>{item.commit.author}</small></>}/>{page && !page.entries.length && fresh && <p className="panel-wait">{t('此范围内没有文件历史')}</p>}{page?.nextCursor && <button className="load-more" disabled={!fresh} onClick={() => { if (applied.current) load(applied.current, false, page.nextCursor); }}>{t('继续加载')}</button>}</aside>
      <section className="detail-panel" aria-label={t('文件历史详情')}>
        {item && <><div className="investigation-detail-title"><code title={item.commit.oid}>{item.commit.oid.slice(0, 10)}</code><span>{item.commit.subject}</span><button data-reading-focus="commit" disabled={!fresh} onClick={() => openCommit(item.commit.oid)}>{t('查看提交')}</button></div><nav className="investigation-content-tabs" aria-label={t('文件调查内容')}><button aria-pressed={content === 'diff'} disabled={!fresh} onClick={() => changeContent('diff')}>{t('文件差异')}</button><button aria-pressed={content === 'before'} disabled={!fresh || !item.base || item.change.kind.startsWith('A')} onClick={() => changeContent('before')}>{t('比较前行来源')}</button><button aria-pressed={content === 'after'} disabled={!fresh || item.change.kind.startsWith('D')} onClick={() => changeContent('after')}>{t('比较后行来源')}</button></nav></>}
        <ReadFeedback state={content === 'diff' ? diff : blame} hasValue={Boolean(content === 'diff' ? diff.value : blame.value)} scope={t(content === 'diff' ? '文件差异' : '行来源')} onCancel={() => content === 'diff' ? read.cancel('diff', setDiff) : read.cancel('blame', setBlame)} onRetry={() => { if (fresh && selected.current) select(selected.current, false, true); else if (valid) load(options, true); }}/>
        {content === 'diff' && diff.value ? <div className={!fresh || diff.stale ? 'stale-content' : ''}><DiffView diff={diff.value} observedAt={diff.stamp?.finishedAt} positionKey={JSON.stringify([session.repository.worktreeId, 'file-history', diff.value.base, diff.value.target, diff.value.entry.id])}/></div> : content !== 'diff' && blame.value ? <div className={!fresh || blame.stale ? 'stale-content' : ''}><BlameView blame={blame.value} disabled={!fresh || !read.fresh(blame)} onOpenCommit={(oid, line) => openCommit(oid, `blame:${line}`)}/></div> : !item && <p className="panel-wait">{t('未选择文件记录')}</p>}
      </section>
    </main>
  </section>;
}
