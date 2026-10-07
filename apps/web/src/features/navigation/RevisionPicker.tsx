import { type Navigation, type RevisionEndpoint } from '@git-view/contracts';
import { useI18n } from '../../i18n';

const displayRef = (value: string) => value.replace(/^refs\/(heads|remotes|tags)\//, '');
export function RevisionPicker({ id, label, caption, commitLabel, value, navigation, disabled, onChange }: { id: string; label: string; caption?: string; commitLabel: string; value: RevisionEndpoint; navigation?: Navigation; disabled: boolean; onChange: (value: RevisionEndpoint) => void }) {
  const { t } = useI18n();
  return <div className="comparison-endpoint"><label htmlFor={id}>{caption ?? label}</label><div className="comparison-endpoint-fields">
    <select id={id} aria-label={label} value={value.kind === 'ref' ? value.name : value.kind} disabled={disabled} onChange={event => onChange(event.target.value === 'head' ? { kind: 'head' } : event.target.value === 'commit' ? { kind: 'commit', oid: '' } : { kind: 'ref', name: event.target.value })}>
      <option value="head">HEAD</option>
      {(['local', 'remote', 'tag'] as const).map(kind => <optgroup key={kind} label={t(kind === 'local' ? '本地分支' : kind === 'remote' ? '远程引用' : '标签')}>{navigation?.refs.filter(ref => ref.kind === kind).map(ref => <option key={ref.name} value={ref.name}>{displayRef(ref.name)}</option>)}</optgroup>)}
      {value.kind === 'ref' && !navigation?.refs.some(ref => ref.name === value.name) && <option value={value.name}>{displayRef(value.name)}</option>}
      <option value="commit">{t('提交 ID…')}</option>
    </select>
    {value.kind === 'commit' && <input aria-label={commitLabel} placeholder={t('完整或短提交 ID')} value={value.oid} spellCheck={false} autoComplete="off" maxLength={64} disabled={disabled} onChange={event => onChange({ kind: 'commit', oid: event.target.value.trim() })}/>}
  </div></div>;
}
