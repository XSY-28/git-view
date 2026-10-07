import { type Blame } from '@git-view/contracts';
import { useI18n } from '../../i18n';

export function BlameView({ blame, disabled, onOpenCommit }: { blame: Blame; disabled: boolean; onOpenCommit: (oid: string) => void }) {
  const { t, locale } = useI18n();
  return <div className="blame-view">
    <div className="investigation-summary"><strong>{blame.path}</strong><code title={blame.oid}>{blame.oid.slice(0, 10)}</code><span>{t(blame.side === 'before' ? '比较前' : '比较后')}</span></div>
    {blame.warnings.map(warning => <p className="investigation-limitation" key={warning}>{t(warning)}</p>)}
    <div className="blame-scroll" tabIndex={0} aria-label={t('文件行来源')}>{blame.lines.map(line => <div className="blame-line" key={line.line}>
      <button className="blame-origin" disabled={disabled} onClick={() => onOpenCommit(line.oid)} title={`${line.oid}\n${line.author} <${line.email}>\n${new Date(line.authoredAt).toLocaleString(locale)}\n${line.path}:${line.originalLine}\n${line.subject}`}><code>{line.oid.slice(0, 8)}</code><span>{line.author}</span>{line.boundary && <small>{t('历史边界')}</small>}</button>
      <span className="blame-line-number">{line.line}</span><code className="blame-text">{line.text || ' '}</code>
    </div>)}</div>
    {!blame.lines.length && <p className="panel-wait">{t('空文件。')}</p>}
  </div>;
}
