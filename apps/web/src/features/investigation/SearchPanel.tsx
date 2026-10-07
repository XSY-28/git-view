import { useEffect, useRef, useState } from 'react';
import { searchOptionsSchema, searchPageSchema, type Navigation, type RepositorySession, type SearchOptions, type SearchPage } from '@git-view/contracts';
import { useI18n } from '../../i18n';
import { ReadFeedback } from '../feedback/ReadFeedback';
import { InvestigationList } from './InvestigationList';
import { empty, useInvestigationReads, type Resource } from './useInvestigationReads';
import { mergeSearch } from './paging';

const fields = [{ field: 'subject', label: '标题' }, { field: 'author', label: '作者' }, { field: 'oid', label: '提交 ID' }, { field: 'path', label: '文件路径' }] as const;
export function SearchPanel({ session, navigation, initial, blocked, onChange, onOpenCommit, onCancellation }: { session: RepositorySession; navigation?: Navigation; initial?: SearchOptions; blocked: boolean; onChange: (value: SearchOptions) => void; onOpenCommit: (oid: string) => void; onCancellation: (cancelled: boolean) => void }) {
  const { t, locale } = useI18n();
  const [options, setOptions] = useState<SearchOptions>(() => initial ?? { scope: 'all', field: 'subject', term: '' });
  const [result, setResult] = useState<Resource<SearchPage>>(empty);
  const applied = useRef<SearchOptions | undefined>(initial && searchOptionsSchema.safeParse(initial).success ? initial : undefined);
  const count = useRef(0); const read = useInvestigationReads(session, blocked, onCancellation);
  function edit(next: SearchOptions) { applied.current = undefined; count.current = 0; read.clear('list', setResult); read.resume(); setOptions(next); onChange(next); }
  function load(value: SearchOptions, keep = false, cursor?: string) {
    applied.current = value;
    void read.query('list', { action: 'search', ...value, cursor }, searchPageSchema, setResult, { keep: keep || Boolean(cursor), pager: { count: page => page.commits.length, cursor: page => page.nextCursor, merge: mergeSearch, reloadTo: keep ? count.current : 0, appendTo: cursor ? result.value : undefined }, success: page => { count.current = page.commits.length; } });
  }
  useEffect(() => { read.resume(); if (blocked) read.clear('list', setResult, true); else if (applied.current) load(applied.current, true); }, [session.sessionId, session.generation, blocked]);
  const page = result.value; const fresh = read.fresh(result); const valid = searchOptionsSchema.safeParse(options).success;
  const range = options.scope === 'ref' ? options.ref! : options.scope;
  return <section className="investigation-search">
    <form className="investigation-form search-form" onSubmit={event => { event.preventDefault(); if (valid) { onChange(options); read.resume(); load(options); } }} aria-label={t('提交搜索')}>
      <label>{t('范围')}<select aria-label={t('搜索历史范围')} value={range} disabled={blocked} onChange={event => edit(event.target.value === 'all' || event.target.value === 'head' ? { ...options, scope: event.target.value, ref: undefined } : { ...options, scope: 'ref', ref: event.target.value })}><option value="all">{t('所有引用')}</option><option value="head">HEAD</option>{navigation?.refs.map(ref => <option key={ref.name} value={ref.name}>{ref.name.replace(/^refs\/(heads|remotes|tags)\//, '')}</option>)}</select></label>
      <label>{t('查找')}<select aria-label={t('搜索字段')} value={options.field} disabled={blocked} onChange={event => edit({ ...options, field: event.target.value as SearchOptions['field'] })}>{fields.map(item => <option key={item.field} value={item.field}>{t(item.label)}</option>)}</select></label>
      <input type="search" aria-label={t('搜索提交')} placeholder={t(options.field === 'path' ? '精确仓库内路径' : options.field === 'oid' ? '完整或短提交 ID' : '搜索内容')} value={options.term} disabled={blocked} maxLength={2048} onChange={event => edit({ ...options, term: event.target.value })}/>
      <button className="button" disabled={blocked || !valid || result.loading}>{t('搜索')}</button>
    </form>
    <ReadFeedback className="investigation-read" state={result} hasValue={Boolean(page)} scope={t('提交搜索')} onCancel={() => read.cancel('list', setResult)} onRetry={() => { read.resume(); if (valid) load(options, true); }}/>
    {page && <div className={`investigation-results ${fresh ? '' : 'stale-content'}`}>
      <div className="investigation-summary"><span>{t('结果')} {page.commits.length}</span><span>{t(fields.find(field => field.field === page.field)!.label)}: <strong>{page.term}</strong></span><time>{new Date(page.observedAt).toLocaleTimeString(locale, { hour12: false })}</time><details><summary>{t('固定历史端点')} {page.tips.length}</summary>{page.tips.map(oid => <code key={oid}>{oid}</code>)}</details></div>
      {page.warnings.map(warning => <p className="investigation-limitation" key={warning}>{t(warning)}</p>)}
      <InvestigationList items={page.commits} itemKey={item => item.oid} label={t('搜索结果')} disabled={!fresh} onSelect={(item, activate) => { if (activate) onOpenCommit(item.oid); }} render={item => <><code title={item.oid}>{item.oid.slice(0, 10)}</code><span>{item.subject}</span><small>{item.author}</small>{item.boundary && <small>{t('浅历史边界')}</small>}</>}/>
      {!page.commits.length && fresh && <p className="panel-wait">{t('无匹配提交')}</p>}
      {page.nextCursor && <button className="load-more" disabled={!fresh} onClick={() => { if (applied.current) load(applied.current, false, page.nextCursor); }}>{t('继续加载')}</button>}
    </div>}
  </section>;
}
