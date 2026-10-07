import { type ComparisonOptions, type Navigation, type RepositorySession } from '@git-view/contracts';
import { useEffect, useRef, type MouseEvent } from 'react';
import { useI18n } from '../../i18n';
import { SearchPanel } from './SearchPanel';
import { FileHistoryPanel } from './FileHistoryPanel';
import { RecordsPanel } from './RecordsPanel';
import type { InvestigationMemory, InvestigationTab } from './options';
import type { InvestigationReadingMemory, OpenInvestigationCommit } from './reading-memory';
import './investigation.css';

export function HistoryNavigation({ options, commits, blocked, onSelect }: { options: InvestigationMemory; commits: boolean; blocked: boolean; onSelect: (tab: InvestigationTab | 'commits') => void }) {
  const { t } = useI18n();
  const more = useRef<HTMLDetailsElement>(null);
  const fileAvailable = Boolean(options.file) || (!commits && options.tab === 'file');
  useEffect(() => {
    function outside(event: PointerEvent) { if (event.target instanceof Node && !more.current?.contains(event.target) && more.current) more.current.open = false; }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || !more.current?.open) return;
      event.preventDefault(); more.current.open = false; more.current.querySelector('summary')?.focus();
    }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);
  function choose(tab: InvestigationTab, event: MouseEvent<HTMLButtonElement>) {
    const disclosure = event.currentTarget.closest('details');
    if (disclosure) { disclosure.open = false; disclosure.querySelector('summary')?.focus(); }
    onSelect(tab);
  }
  return <nav className="investigation-tabs" aria-label={t('历史内容')}>
    <button aria-pressed={commits} disabled={blocked} onClick={() => onSelect('commits')}>{t('提交列表')}</button>
    <button aria-pressed={!commits && options.tab === 'search'} disabled={blocked} onClick={() => onSelect('search')}>{t('提交搜索')}</button>
    {fileAvailable && <button aria-pressed={!commits && options.tab === 'file'} disabled={blocked} onClick={() => onSelect('file')}>{t('文件历史')}</button>}
    <details ref={more} className="history-more">
      <summary aria-label={t('更多历史工具')}>{t('更多')}{!commits && (options.tab === 'stash' || options.tab === 'reflog') && <span> · {options.tab}</span>}</summary>
      <div className="history-more-panel">
        {!fileAvailable && <button disabled={blocked} onClick={event => choose('file', event)}>{t('文件历史')}</button>}
        <button aria-pressed={!commits && options.tab === 'stash'} disabled={blocked} onClick={event => choose('stash', event)}>stash</button>
        <button aria-pressed={!commits && options.tab === 'reflog'} disabled={blocked} onClick={event => choose('reflog', event)}>reflog</button>
      </div>
    </details>
  </nav>;
}
export function InvestigationView({ session, navigation, options, blocked, memory, mobilePanel, onChange, onShowDetail, onOpenCommit, onCompare, onCancellation }: { session: RepositorySession; navigation?: Navigation; options: InvestigationMemory; blocked: boolean; memory: InvestigationReadingMemory; mobilePanel: 'navigation' | 'list' | 'diff'; onChange: (options: InvestigationMemory) => void; onShowDetail: () => void; onOpenCommit: OpenInvestigationCommit; onCompare: (options: ComparisonOptions) => void; onCancellation: (cancelled: boolean) => void }) {
  const props = { session, navigation, blocked, mobilePanel, onShowDetail, onOpenCommit, onCancellation };
  return <div data-testid="investigation-view" className="investigation-view">
    {options.tab === 'search' ? <SearchPanel {...props} memory={memory} initial={options.search} onChange={search => onChange({ ...options, search })}/> : options.tab === 'file' ? <FileHistoryPanel {...props} memory={memory} initial={options.file} onChange={file => onChange({ ...options, file })}/> : <RecordsPanel key={options.tab} {...props} kind={options.tab} initialRef={options.reflogRef} onChangeRef={reflogRef => onChange({ ...options, reflogRef })} onCompare={onCompare}/>}
  </div>;
}
