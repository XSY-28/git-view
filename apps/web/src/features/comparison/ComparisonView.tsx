import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { comparisonOptionsSchema, type ComparisonOptions, type Navigation, type RepositorySession, type CommitNode, type Diff } from '@git-view/contracts';
import { useI18n } from '../../i18n';
import { ChangeList } from '../changes/ChangeList';
import { RevisionPicker } from '../navigation/RevisionPicker';
import { DiffView } from '../changes/DiffView';
import { ReadFeedback } from '../feedback/ReadFeedback';
import { listNavigationTarget } from '../navigation/list-navigation';
import { useComparison } from './useComparison';
import './comparison.css';

const displayRef = (value: string) => value.replace(/^refs\/(heads|remotes|tags)\//, '');
function defaultOptions(navigation?: Navigation, commit?: string): ComparisonOptions {
  const ref = navigation?.refs.find(ref => !ref.current && ref.kind === 'local');
  return { a: { kind: 'head' }, b: commit ? { kind: 'commit', oid: commit } : ref ? { kind: 'ref', name: ref.name } : { kind: 'head' } };
}

export function ComparisonView({ session, navigation, initialOptions, initialCommit, blocked, mobilePanel, onShowDiff, onSelectCommit, onOptionsChange, onCancellation, onFileHistory }: {
  session: RepositorySession; navigation?: Navigation; initialOptions?: ComparisonOptions; initialCommit?: string; blocked: boolean;
  mobilePanel: 'navigation' | 'list' | 'diff'; onShowDiff: () => void; onSelectCommit: (node: CommitNode) => void;
  onOptionsChange: (options: ComparisonOptions) => void; onCancellation: (cancelled: boolean) => void;
  onFileHistory?: (diff: Diff) => void;
}) {
  const { t } = useI18n();
  const [options, setOptions] = useState<ComparisonOptions>(() => initialOptions ?? defaultOptions(navigation, initialCommit));
  const [content, setContent] = useState<'files' | 'a' | 'b'>('files');
  const [filter, setFilter] = useState('');
  const read = useComparison(session, blocked, onCancellation);
  const list = useRef<HTMLDivElement>(null);
  const result = read.comparison.value;
  const tree = read.mode === 'endpoints' ? result?.endpoints : result?.fromMergeBase;
  const valid = comparisonOptionsSchema.safeParse(options).success;
  const page = content === 'files' ? undefined : read.pages[content];
  function change(value: ComparisonOptions) { read.invalidate(); setOptions(value); onOptionsChange(value); }
  function compare() { if (valid) { onOptionsChange(options); read.compare(options); } }
  useEffect(() => {
    // Returning to this worktree restores its operands; IDs are re-resolved as a
    // fresh comparison rather than presenting a previous session's observation.
    if (initialOptions && comparisonOptionsSchema.safeParse(initialOptions).success) read.compare(initialOptions);
  }, []);
  useEffect(() => {
    if (content !== 'files' && read.fresh && result && !page?.loading && !page?.error && !page?.cancelled && page?.value?.comparisonId !== result.comparisonId) read.loadPage(content);
  }, [content, result?.comparisonId, read.fresh]);
  function keyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.comparison-commit') ?? []);
    const index = listNavigationTarget(event.key, buttons.indexOf(event.currentTarget), buttons.length);
    if (index === undefined) return;
    event.preventDefault(); buttons[index]?.focus(); buttons[index]?.scrollIntoView({ block: 'nearest' });
  }
  return <div className="comparison-view">
    <form className="comparison-form" aria-label={t('版本比较')} onSubmit={event => { event.preventDefault(); compare(); }}>
      <RevisionPicker id="comparison-A" caption="A" label={t('比较端点 {0}', ['A'])} commitLabel={t('{0} 提交 ID', ['A'])} value={options.a} navigation={navigation} disabled={blocked} onChange={a => change({ ...options, a })}/>
      <button className="comparison-swap" type="button" title={t('交换 A 与 B')} aria-label={t('交换 A 与 B')} disabled={blocked} onClick={() => { const next = { a: options.b, b: options.a }; change(next); if (comparisonOptionsSchema.safeParse(next).success) read.compare(next); }}>⇄</button>
      <RevisionPicker id="comparison-B" caption="B" label={t('比较端点 {0}', ['B'])} commitLabel={t('{0} 提交 ID', ['B'])} value={options.b} navigation={navigation} disabled={blocked} onChange={b => change({ ...options, b })}/>
      <button className="button comparison-submit" type="submit" disabled={!valid || blocked || read.comparison.loading}>{t('比较')}</button>
    </form>
    <ReadFeedback state={read.comparison} hasValue={Boolean(result)} scope={t('版本比较')} className="comparison-read" onCancel={() => read.cancel('compare')} onRetry={() => { if (valid) read.compare(options, true); }}/>
    {result && <div className={`comparison-snapshot ${!read.fresh ? 'stale-content' : ''}`}>
      <div className="comparison-fixed-endpoints">{(['a', 'b'] as const).map(side => <span key={side}><strong>{side.toUpperCase()}</strong><span>{displayRef(result[side].label)}</span><code title={result[side].oid}>{result[side].oid.slice(0, 10)}</code></span>)}</div>
      <div className="comparison-base"><span>{t('共同祖先')}</span>{result.mergeBases.oids.map(oid => <code key={oid} title={oid}>{oid.slice(0, 10)}</code>)}{result.mergeBases.reason && <span className="comparison-limitation">{t(result.mergeBases.reason)}</span>}</div>
      {result.warnings.map(warning => <p className="comparison-limitation" key={warning}>{t(warning)}</p>)}
    </div>}
    {result && <nav className="comparison-content-tabs" aria-label={t('比较内容')}>
      <button aria-pressed={content === 'files'} onClick={() => setContent('files')}>{t('文件差异')} <span>{tree?.changes.length ?? '·'}</span></button>
      {(['a', 'b'] as const).map(side => <button key={side} aria-pressed={content === side} onClick={() => setContent(side)}>{t('{0} 独有提交', [side.toUpperCase()])} <span>{result.exclusive[side]}{!result.exclusive.complete && '*'}</span></button>)}
    </nav>}
    {result && content === 'files' ? <>
      <div className="comparison-modes" aria-label={t('文件比较基准')}>
        <button aria-pressed={read.mode === 'endpoints'} disabled={!read.fresh} onClick={() => read.changeMode('endpoints')}>A → B</button>
        <button aria-pressed={read.mode === 'merge-base'} disabled={!read.fresh || !result.fromMergeBase} title={result.mergeBases.reason ? t(result.mergeBases.reason) : undefined} onClick={() => read.changeMode('merge-base')}>{t('共同祖先 → B')}</button>
        {tree && <span className="comparison-tree-direction"><code title={tree.base}>{tree.base.slice(0, 10)}</code> → <code title={tree.target}>{tree.target.slice(0, 10)}</code></span>}
      </div>
      <main className={`workspace comparison-workspace mobile-${mobilePanel}`}>
        <aside className="list-panel"><ChangeList scope="comparison" entries={tree?.changes ?? []} selected={read.selectedId} disabled={!read.fresh} filter={filter} onFilter={value => { setFilter(value); read.filterFiles(value); }} onSelect={(entry, activate) => { read.selectFile(entry); if (activate) onShowDiff(); }}/></aside>
        <section className="detail-panel" aria-label={t('比较文件详情')}>
          <ReadFeedback state={read.diff} hasValue={Boolean(read.diff.value)} scope={t('比较文件差异')} className="diff-read-state" onCancel={() => read.cancel('diff')} onRetry={() => { if (read.fresh) read.retryDiff(); else if (valid) read.compare(options, true); }}/>
          {read.diff.value ? <div className={!read.fresh || read.diff.stale ? 'stale-content' : ''}><DiffView diff={read.diff.value} actions={onFileHistory && <button className="file-history-action" disabled={!read.fresh || read.diff.stale || read.diff.loading} onClick={() => onFileHistory(read.diff.value!)}>{t('文件历史')}</button>} observedAt={read.diff.stamp?.finishedAt} positionKey={JSON.stringify([session.repository.worktreeId, 'comparison', read.mode, read.diff.value.base, read.diff.value.target, read.diff.value.entry.id])}/></div> : !read.diff.loading && <div className="empty-state"><h2>{t('未选择文件')}</h2></div>}
        </section>
      </main>
    </> : result && content !== 'files' ? <section className="comparison-history" aria-label={t('{0} 独有提交', [content.toUpperCase()])}>
      <ReadFeedback state={page!} hasValue={Boolean(page?.value)} scope={t('独有提交')} onCancel={() => read.cancel(content)} onRetry={() => { if (read.fresh) read.loadPage(content); else if (valid) read.compare(options, true); }}/>
      <div className={!read.fresh || page?.stale ? 'stale-content' : ''} ref={list}>
        {page?.value?.commits.map(node => <button className="comparison-commit" key={node.oid} disabled={!read.fresh || page.stale} title={node.oid} onClick={() => onSelectCommit(node)} onKeyDown={keyboard}><code>{node.oid.slice(0, 10)}</code><span>{node.subject}</span><small>{node.author}</small>{node.boundary && <small>{t('浅历史边界')}</small>}</button>)}
        {page?.value && !page.loading && !page.error && !page.stale && !page.value.commits.length && <p className="panel-wait">{t('无独有提交')}</p>}
      </div>
      {page?.value?.nextCursor && <button className="load-more" disabled={!read.fresh || page.loading} onClick={() => read.loadPage(content, page.value?.nextCursor)}>{t('继续加载')}</button>}
    </section> : !read.comparison.loading && !read.comparison.error && !read.comparison.cancelled && <div className="empty-state"><h2>{t('选择比较端点')}</h2></div>}
  </div>;
}
