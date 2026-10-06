import { useI18n } from '../../i18n/index';
import { useState } from 'react';
import type { Navigation } from '@git-view/contracts';
import type { HistoryScope } from '../../state/repository-controller';
import { historyScopes, referenceName } from './history-scope';
import { ReadFeedback, type ReadState } from '../feedback/ReadFeedback';

const groups = { local: '本地分支', remote: '远程跟踪引用', tag: '标签' } as const;

export function RepositorySidebar({ navigation, scope, selectedRef, readState, onFilter, onRetry, onCancel, initialSearch, onSearch }: {
  navigation?: Navigation; scope: HistoryScope; selectedRef?: string; readState: ReadState;
  onFilter: (scope: HistoryScope, ref?: string) => void; onRetry: () => void; onCancel: () => void;
  initialSearch: string; onSearch: (value: string) => void;
}) {
  const { t, locale } = useI18n();
  const [filter, setFilter] = useState(initialSearch);
  const refs = navigation?.refs.filter(ref => referenceName(ref.name).toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  return <aside className="repository-sidebar" aria-label={t("历史范围")}>
    <div className="sidebar-title"><h2>{t("历史范围")}</h2></div>
    <label className="sr-only" htmlFor="reference-filter">{t("筛选引用")}</label>
    <input id="reference-filter" value={filter} onChange={event => { setFilter(event.target.value); onSearch(event.target.value); }} placeholder={t("筛选分支或标签")} spellCheck={false}/>
    <div className="scope-options">{historyScopes.map(option => <button key={option.value} aria-pressed={scope === option.value} onClick={() => onFilter(option.value)}>{t(option.label)}</button>)}</div>
    <ReadFeedback state={readState} hasValue={Boolean(navigation)} scope={t("引用")} compact className="navigation-read-state" onRetry={onRetry} onCancel={onCancel}/>
    {Object.entries(groups).map(([kind, label]) => {
      const entries = refs?.filter(ref => ref.kind === kind);
      if (!entries?.length) return null;
      return <details key={kind} open><summary>{t(label)}</summary>{entries.map(ref => <button className="navigation-ref" key={ref.name}
        aria-pressed={scope === 'ref' && selectedRef === ref.name} title={t('查看 {0} 的提交历史\n{1}', [referenceName(ref.name), ref.oid])} onClick={() => onFilter('ref', ref.name)}>
        <span>{referenceName(ref.name)}</span>{ref.current && <small className="current-branch-marker">{t("当前分支")}</small>}
      </button>)}</details>;
    })}
    {filter && refs?.length === 0 && !readState.loading && !readState.error && <p className="reference-empty">{t("无匹配引用")}</p>}
  </aside>;
}
