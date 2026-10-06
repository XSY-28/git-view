import { useI18n } from '../../i18n/index';
import { useRef, type KeyboardEvent, type Ref, type ReactNode } from 'react';
import type { ChangeEntry, Overview } from '@git-view/contracts';
import { listNavigationTarget } from '../navigation/list-navigation';
import { matchesFileFilter } from './change-filter';
import { operationLabel, type OperationKind, type Operations } from '../operations/useOperations';
import './change-list.css';

const groups = [
  { key: 'conflicts', label: '未解决冲突', comparison: '冲突文件' },
  { key: 'staged', label: '已暂存', comparison: 'HEAD → 暂存区' },
  { key: 'unstaged', label: '未暂存', comparison: '暂存区 → 工作区' },
  { key: 'untracked', label: '未跟踪', comparison: '文本预览' },
] as const;
const kindLabel: Record<string, string> = { M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', T: '类型变化', U: '冲突', '?': '新文件' };

type ChangeListProps = {
  filter: string;
  disabled?: boolean;
  onFilter: (value: string) => void;
  selected?: string;
  onSelect: (entry: ChangeEntry, activate: boolean) => void;
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: (top: number) => void;
} & ({ scope: 'changes'; changes: Overview['changes']; operations?: Operations; actions?: ReactNode } | { scope: 'history'; entries: ChangeEntry[] });

export function ChangeList(props: ChangeListProps) {
  const { t, locale } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const entries = props.scope === 'changes' ? groups.flatMap(group => props.changes[group.key]) : props.entries;
  const visible = entries.filter(entry => matchesFileFilter(entry, props.filter));
  const filtering = Boolean(props.filter.trim());

  function keyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    // Collapsed groups and unavailable paths stay out of the navigation sequence.
    const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[data-entry-id]') || []).filter(button => !button.disabled && !button.closest('details:not([open])') && button.getClientRects().length > 0);
    const target = listNavigationTarget(event.key, buttons.indexOf(event.currentTarget), buttons.length);
    if (target === undefined) return;
    event.preventDefault();
    const button = buttons[target];
    const entry = visible.find(item => item.id === button?.dataset.entryId);
    if (!entry || !button) return;
    if (entry.id !== props.selected) props.onSelect(entry, false);
    button.focus({ preventScroll: true });
    button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function row(entry: ChangeEntry) {
    const kind: OperationKind = entry.comparison === 'head-index' ? 'unstage-files' : 'stage-files';
    const operations = props.scope === 'changes' ? props.operations : undefined;
    const checkable = operations && props.scope === 'changes' && entry.supported && !props.changes.conflicts.some(conflict => conflict.id === entry.id);
    const button = <button key={entry.id} data-entry-id={entry.id} className={`file-row ${props.selected === entry.id ? 'selected' : ''}`} onClick={() => props.onSelect(entry, true)} onKeyDown={keyboard} aria-pressed={props.selected === entry.id} disabled={props.disabled || !entry.supported} title={entry.supported ? entry.path : t('{0}：此路径无法可靠寻址，不能展开详情', [entry.path])}>
      <span className={`change-kind kind-${entry.kind[0]}`}>{entry.kind === '?' ? '+' : entry.kind[0]}</span>
      <span className="file-name">{entry.path}{entry.oldPath && <small>← {entry.oldPath}</small>}</span>
      <span className="file-kind-label">{entry.supported ? t(kindLabel[entry.kind[0]!] || entry.kind) : t('不支持路径')}</span>
    </button>;
    if (!checkable) return button;
    const checked = operations.state.entryIds.includes(entry.id);
    const disabled = props.disabled || operations.blocked || (operations.state.entryIds.length > 0 && operations.state.kind !== kind);
    return <div key={entry.id} className="file-operation-row"><label className="file-operation-checkbox" title={`${t(operationLabel(kind))} ${entry.path}`}><input type="checkbox" checked={checked} disabled={disabled} aria-label={t('选择{0} {1}', [t(operationLabel(kind)), entry.path])} onChange={() => operations.toggle(entry, kind)}/></label>{button}</div>;
  }

  return <div className={`change-list change-list-${props.scope}`} ref={root} aria-label={props.scope === 'changes' ? t('当前改动文件') : t('提交变化文件')}>
    <div className="change-list-filter">
      <input type="search" disabled={props.disabled} value={props.filter} onChange={event => props.onFilter(event.target.value)} placeholder={t("筛选文件")} aria-label={props.scope === 'changes' ? t('筛选当前改动文件') : t('筛选提交文件')}/>
      {filtering && <span aria-live="polite">{visible.length} / {entries.length}</span>}
    </div>
    {props.scope === 'changes' && props.actions}
    <div ref={props.scrollRef} className={props.scope === 'changes' ? 'file-groups' : 'filtered-commit-files'} onScroll={event => props.onScroll?.(event.currentTarget.scrollTop)}>
      {filtering && !visible.length ? <p className="file-filter-empty" role="status">{t("无匹配文件")}</p> : props.scope === 'history' ? (visible.length ? visible.map(row) : <p className="file-filter-empty">{t("无变化文件")}</p>) : groups.map(group => {
        const all = props.changes[group.key];
        const matching = all.filter(entry => matchesFileFilter(entry, props.filter));
        if ((!all.length && group.key === 'conflicts') || (filtering && !matching.length)) return null;
        return <details className={`file-group group-${group.key}`} key={group.key} open>
          <summary><span className="disclosure" aria-hidden="true">›</span><strong>{t(group.label)}</strong><span className="group-count">{matching.length}</span></summary>
          <div className="group-comparison">{t(group.comparison)}</div>
          {matching.length ? matching.map(row) : <p className="group-empty">{t("暂无")}{t(group.label)}{t("内容")}</p>}
        </details>;
      })}
    </div>
  </div>;
}
