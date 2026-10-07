import { useEffect, useRef, useState } from 'react';
import { diffSchema, recordPageSchema, stashDetailSchema, type ChangeEntry, type ComparisonOptions, type Diff, type Navigation, type RecordOptions, type RecordPage, type RepositoryRecord, type RepositorySession, type StashDetail, type StashPart } from '@git-view/contracts';
import { useI18n } from '../../i18n';
import { ReadFeedback } from '../feedback/ReadFeedback';
import { DiffView } from '../changes/DiffView';
import { ChangeList } from '../changes/ChangeList';
import { matchesFileFilter } from '../changes/change-filter';
import { InvestigationList } from './InvestigationList';
import { empty, useInvestigationReads, type Resource } from './useInvestigationReads';
import { mergeRecords } from './paging';

const parts: { kind: StashPart; label: string }[] = [{ kind: 'worktree', label: '工作区快照' }, { kind: 'index', label: '暂存区快照' }, { kind: 'untracked', label: '未跟踪快照' }];
export function RecordsPanel({ session, kind, navigation, initialRef, blocked, mobilePanel, onChangeRef, onShowDetail, onOpenCommit, onCompare, onCancellation }: { session: RepositorySession; kind: 'stash' | 'reflog'; navigation?: Navigation; initialRef?: string; blocked: boolean; mobilePanel: 'navigation' | 'list' | 'diff'; onChangeRef: (ref: string) => void; onShowDetail: () => void; onOpenCommit: (oid: string) => void; onCompare: (options: ComparisonOptions) => void; onCancellation: (cancelled: boolean) => void }) {
  const { t, locale } = useI18n(); const [ref, setRef] = useState(initialRef ?? 'HEAD');
  const [records, setRecords] = useState<Resource<RecordPage>>(empty); const [detail, setDetail] = useState<Resource<StashDetail>>(empty); const [diff, setDiff] = useState<Resource<Diff>>(empty);
  const [selectedId, setSelectedId] = useState<string>(); const selected = useRef<RepositoryRecord | undefined>(undefined); const snapshot = useRef<RecordPage | undefined>(undefined); const currentDetail = useRef<StashDetail | undefined>(undefined); const count = useRef(0);
  const [part, setPart] = useState<StashPart>('worktree'); const partRef = useRef(part); partRef.current = part;
  const [filter, setFilter] = useState(''); const filterRef = useRef(filter); filterRef.current = filter;
  const [fileId, setFileId] = useState<string>(); const file = useRef<ChangeEntry | null | undefined>(undefined);
  const read = useInvestigationReads(session, blocked, onCancellation);
  function selectFile(entry: ChangeEntry, keep = false) {
    const value = currentDetail.current; if (!value) return;
    file.current = entry; setFileId(entry.id);
    void read.query('diff', { action: 'stash-change', snapshotId: value.snapshotId, recordId: value.recordId, part: partRef.current, entryId: entry.id }, diffSchema, setDiff, { keep });
  }
  function selectRecord(item: RepositoryRecord, activate = false, keep = false) {
    if (!snapshot.current) return;
    selected.current = item; setSelectedId(item.recordId); if (activate) onShowDetail();
    read.clear('diff', setDiff, keep); currentDetail.current = undefined;
    if (!keep) { file.current = undefined; setFileId(undefined); }
    if (kind !== 'stash' || item.availability !== 'commit') { read.clear('detail', setDetail); return; }
    void read.query('detail', { action: 'stash-detail', snapshotId: snapshot.current.snapshotId, recordId: item.recordId }, stashDetailSchema, setDetail, { keep, success: value => {
      currentDetail.current = value;
      if (!value.parts.some(item => item.kind === partRef.current)) { partRef.current = 'worktree'; setPart('worktree'); }
      const entries = value.parts.find(part => part.kind === partRef.current)?.changes ?? [];
      const eligible = entries.filter(item => item.supported && matchesFileFilter(item, filterRef.current));
      const next = eligible.find(item => item.id === file.current?.id) ?? eligible[0];
      if (next && file.current !== null) selectFile(next, keep && next.id === file.current?.id); else { read.clear('diff', setDiff); setFileId(undefined); }
    } });
  }
  function load(keep = false, cursor?: string, nextRef = ref) {
    snapshot.current = undefined; currentDetail.current = undefined; read.clear('detail', setDetail, keep || Boolean(cursor)); read.clear('diff', setDiff, keep || Boolean(cursor));
    if (!keep && !cursor) { selected.current = undefined; setSelectedId(undefined); file.current = undefined; setFileId(undefined); }
    const options: RecordOptions = { kind, ...(kind === 'reflog' ? { ref: nextRef } : {}), cursor };
    void read.query('list', { action: 'records', ...options }, recordPageSchema, setRecords, { keep: keep || Boolean(cursor), pager: { count: page => page.entries.length, cursor: page => page.nextCursor, merge: mergeRecords, reloadTo: keep ? count.current : 0, appendTo: cursor ? records.value : undefined }, success: page => {
      snapshot.current = page; count.current = page.entries.length;
      const previous = selected.current; const next = page.entries.find(item => item.recordId === previous?.recordId) ?? page.entries[0];
      if (next) selectRecord(next, false, keep && next.newOid === previous?.newOid); else { selected.current = undefined; setSelectedId(undefined); read.clear('detail', setDetail); read.clear('diff', setDiff); }
    } });
  }
  function cancelList() { read.cancel('list', setRecords); read.cancel('detail', setDetail); read.cancel('diff', setDiff); snapshot.current = undefined; currentDetail.current = undefined; }
  useEffect(() => { read.resume(); if (blocked) { snapshot.current = undefined; currentDetail.current = undefined; read.clear('list', setRecords, true); read.clear('detail', setDetail, true); read.clear('diff', setDiff, true); } else load(true); }, [session.sessionId, session.generation, blocked]);
  const page = records.value; const fresh = read.fresh(records); const record = page?.entries.find(item => item.recordId === selectedId); const stash = detail.value; const tree = stash?.parts.find(item => item.kind === part); const detailFresh = fresh && read.fresh(detail);
  function changePart(next: StashPart) { partRef.current = next; setPart(next); file.current = undefined; setFileId(undefined); read.clear('diff', setDiff); const first = currentDetail.current?.parts.find(part => part.kind === next)?.changes.find(item => item.supported && matchesFileFilter(item, filterRef.current)); if (first) selectFile(first); }
  return <section className="investigation-records">
    {kind === 'reflog' && <form className="investigation-form records-form" onSubmit={event => { event.preventDefault(); read.resume(); load(); }}><label>{t('引用')}<select aria-label={t('reflog 引用')} value={ref} disabled={blocked} onChange={event => { const next = event.target.value; setRef(next); onChangeRef(next); count.current = 0; read.resume(); load(false, undefined, next); }}><option value="HEAD">HEAD</option>{navigation?.refs.map(ref => <option key={ref.name} value={ref.name}>{ref.name}</option>)}{ref !== 'HEAD' && !navigation?.refs.some(item => item.name === ref) && <option value={ref}>{ref}</option>}</select></label><button className="button" disabled={blocked || records.loading}>{t('读取记录')}</button></form>}
    <ReadFeedback className="investigation-read" state={records} hasValue={Boolean(page)} scope={kind === 'stash' ? 'stash' : 'reflog'} onCancel={cancelList} onRetry={() => { read.resume(); load(true); }}/>
    {page && <div className="investigation-observation">{t('记录观测时间')} · <time dateTime={page.observedAt}>{new Date(page.observedAt).toLocaleString(locale)}</time></div>}
    {page?.warnings.map(warning => <p className="investigation-limitation" key={warning}>{t(warning)}</p>)}
    <main className={`workspace investigation-workspace records-workspace mobile-${mobilePanel}`}>
      <aside className="list-panel"><InvestigationList items={page?.entries ?? []} itemKey={item => item.recordId} selected={selectedId} label={t(kind === 'stash' ? 'stash 记录' : 'reflog 记录')} disabled={!fresh} onSelect={(item, activate) => selectRecord(item, activate)} render={item => <><code title={item.newOid}>{item.newOid.slice(0, 10)}</code><span>{item.message || t('无消息')}<small>{item.selector} · {new Date(item.recordedAt).toLocaleString(locale)}</small></span>{item.availability !== 'commit' && <small>{t(item.availability === 'unavailable' ? '对象不可用' : item.availability === 'deleted' ? '引用已删除' : '非提交对象')}</small>}</>}/>{page && !page.entries.length && fresh && <p className="panel-wait">{t('没有本地记录')}</p>}{page?.nextCursor && <button className="load-more" disabled={!fresh} onClick={() => load(false, page.nextCursor)}>{t('继续加载')}</button>}</aside>
      <section className="detail-panel" aria-label={t('本地记录详情')}>
        {record && <div className={`record-detail ${fresh ? '' : 'stale-content'}`}><div className="investigation-detail-title"><strong>{record.selector}</strong><span>{record.message || t('无消息')}</span></div><div className="record-transition"><code title={record.oldOid}>{/^0+$/.test(record.oldOid) ? t('无先前提交') : record.oldOid.slice(0, 10)}</code> → <code title={record.newOid}>{/^0+$/.test(record.newOid) ? t('引用已删除') : record.newOid.slice(0, 10)}</code></div><div className="record-actor">{record.actor} · <time dateTime={record.recordedAt}>{new Date(record.recordedAt).toLocaleString(locale)}</time></div>{kind === 'reflog' && <div className="record-actions"><button disabled={!fresh || record.availability !== 'commit'} onClick={() => onOpenCommit(record.newOid)}>{t('查看新提交')}</button><button disabled={!fresh || record.availability !== 'commit' || /^0+$/.test(record.oldOid)} onClick={() => onCompare({ a: { kind: 'commit', oid: record.oldOid }, b: { kind: 'commit', oid: record.newOid } })}>{t('比较前后')}</button></div>}{record.availability !== 'commit' && <p className="investigation-limitation">{t('记录仍在本机，但对应提交不可展开。')}</p>}</div>}
        {kind === 'stash' && <><ReadFeedback className="stash-detail-read" state={detail} hasValue={Boolean(stash)} scope={t('stash 详情')} onCancel={() => { read.cancel('detail', setDetail); read.cancel('diff', setDiff); currentDetail.current = undefined; }} onRetry={() => { if (fresh && selected.current) selectRecord(selected.current, false, true); else load(true); }}/>{stash && <div className={`stash-snapshot ${detailFresh ? '' : 'stale-content'}`}>
          <nav className="investigation-content-tabs" aria-label={t('stash 快照')}>{parts.map(item => <button key={item.kind} aria-pressed={part === item.kind} disabled={!detailFresh || !stash.parts.some(part => part.kind === item.kind)} onClick={() => changePart(item.kind)}>{t(item.label)}</button>)}</nav>
          {stash.warnings.map(warning => <p className="investigation-limitation" key={warning}>{t(warning)}</p>)}
          {tree && <div className="stash-files-and-diff"><ChangeList scope="comparison" label={t('stash 文件')} filterLabel={t('筛选 stash 文件')} entries={tree.changes} filter={filter} selected={fileId} disabled={!detailFresh} onFilter={value => { setFilter(value); filterRef.current = value; if (file.current && !matchesFileFilter(file.current, value)) { file.current = null; setFileId(undefined); read.clear('diff', setDiff); } }} onSelect={entry => selectFile(entry)}/><section><ReadFeedback state={diff} hasValue={Boolean(diff.value)} scope={t('stash 文件差异')} onCancel={() => read.cancel('diff', setDiff)} onRetry={() => { if (detailFresh && file.current) selectFile(file.current, true); else if (fresh && selected.current) selectRecord(selected.current, false, true); else load(true); }}/>{diff.value && <div className={diff.stale ? 'stale-content' : ''}><DiffView diff={diff.value} observedAt={diff.stamp?.finishedAt} positionKey={JSON.stringify([session.repository.worktreeId, 'stash', part, diff.value.base, diff.value.target, diff.value.entry.id])}/></div>}</section></div>}
        </div>}</>}
        {!record && <p className="panel-wait">{t('未选择记录')}</p>}
      </section>
    </main>
  </section>;
}
