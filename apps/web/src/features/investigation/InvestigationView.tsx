import { type ComparisonOptions, type Navigation, type RepositorySession } from '@git-view/contracts';
import { useI18n } from '../../i18n';
import { SearchPanel } from './SearchPanel';
import { FileHistoryPanel } from './FileHistoryPanel';
import { RecordsPanel } from './RecordsPanel';
import type { InvestigationMemory, InvestigationTab } from './options';
import './investigation.css';

const tabs: { tab: InvestigationTab; label: string }[] = [{ tab: 'search', label: '提交搜索' }, { tab: 'file', label: '文件历史' }, { tab: 'stash', label: 'stash' }, { tab: 'reflog', label: 'reflog' }];
export function InvestigationView({ session, navigation, options, blocked, mobilePanel, onChange, onShowDetail, onOpenCommit, onCompare, onCancellation }: { session: RepositorySession; navigation?: Navigation; options: InvestigationMemory; blocked: boolean; mobilePanel: 'navigation' | 'list' | 'diff'; onChange: (options: InvestigationMemory) => void; onShowDetail: () => void; onOpenCommit: (oid: string) => void; onCompare: (options: ComparisonOptions) => void; onCancellation: (cancelled: boolean) => void }) {
  const { t } = useI18n(); const props = { session, navigation, blocked, mobilePanel, onShowDetail, onOpenCommit, onCancellation };
  return <div className="investigation-view">
    <nav className="investigation-tabs" aria-label={t('历史调查内容')}>{tabs.map(item => <button key={item.tab} aria-pressed={options.tab === item.tab} disabled={blocked} onClick={() => onChange({ ...options, tab: item.tab })}>{t(item.label)}</button>)}</nav>
    {options.tab === 'search' ? <SearchPanel {...props} initial={options.search} onChange={search => onChange({ ...options, search })}/> : options.tab === 'file' ? <FileHistoryPanel {...props} initial={options.file} onChange={file => onChange({ ...options, file })}/> : <RecordsPanel key={options.tab} {...props} kind={options.tab} initialRef={options.reflogRef} onChangeRef={reflogRef => onChange({ ...options, reflogRef })} onCompare={onCompare}/>}
  </div>;
}
