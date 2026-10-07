import { useI18n } from '../../i18n/index';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Diff } from '@git-view/contracts';
import { comparisonObjects, objectLabel, presentDiff } from './diff-presentation';
import { alignDiffLines, SideBySideDiff } from '../comparison/SideBySideDiff';
import { readPreferences, rememberPosition, writePreferences, type DiffMode } from '../../state/repository-controller';

import './diff-view.css';

export function DiffView({ diff, observedAt, positionKey, actions }: { diff: Diff; observedAt?: string; positionKey: string; actions?: ReactNode }) {
  const { t, locale } = useI18n();
  const [preferences, setPreferences] = useState(readPreferences);
  const [rawOpen, setRawOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const [copyStatus, setCopyStatus] = useState('');
  const copySource = useRef({ positionKey, text: diff.text });
  copySource.current = { positionKey, text: diff.text };
  const scroll = useRef<HTMLDivElement>(null);
  const position = useRef(0);
  useEffect(() => {
    position.current = readPreferences().positions[positionKey] || 0;
    if (scroll.current) scroll.current.scrollTop = position.current;
    setRawOpen(false); setDetailsOpen(false); setCopyStatus('');
  }, [positionKey]);
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = position.current; }, [preferences.diffMode, preferences.wrap]);
  useEffect(() => { setCopyStatus(''); }, [diff.text]);
  function setMode(diffMode: DiffMode) { const next = { ...readPreferences(), diffMode }; writePreferences(next); setPreferences(next); }
  function setWrap(wrap: boolean) { const next = { ...readPreferences(), wrap }; writePreferences(next); setPreferences(next); }
  async function copyPatch() {
    const source = copySource.current;
    const stillCurrent = () => copySource.current.positionKey === source.positionKey && copySource.current.text === source.text;
    try { await navigator.clipboard.writeText(source.text); if (stillCurrent()) setCopyStatus(diff.complete ? '已复制补丁' : '已复制已获取部分'); }
    catch { if (stillCurrent()) setCopyStatus('无法访问剪贴板，请选择下方补丁手动复制。'); }
  }
  const { lines, metadata, additions, deletions } = useMemo(() => presentDiff(diff), [diff]);
  const objects = comparisonObjects(diff);
  const isPatch = diff.format === 'diff';
  const hasLines = lines.length > 0;
  const mode = isPatch ? preferences.diffMode : diff.format;
  const incompleteReason = !diff.complete && diff.format !== 'unavailable' ? `${diff.reason ? `${diff.reason} ` : ''}仅显示已获取内容。` : diff.reason;
  return <div className={`diff-view ${preferences.wrap ? 'wrap-lines' : 'nowrap-lines'}`} data-diff-mode={mode}>
    <div className="diff-header">
      <h2 title={diff.entry.path}>{diff.entry.path}</h2>
      <div className="diff-count">{isPatch ? <>{!diff.complete && <span>{t("已获取")}</span>}<span className="text-add">+{additions}</span><span className="text-remove">−{deletions}</span></> : <span className="muted">{diff.format === 'text' ? t('文本预览') : t('未展开')}</span>}</div>
      <div className="diff-header-controls">
        {actions && <div className="diff-file-actions">{actions}</div>}
        {hasLines && diff.format !== 'unavailable' && <div className="diff-toolbar" role="group" aria-label={isPatch ? t('差异展示') : t('文本展示')}>{isPatch && <><button aria-pressed={preferences.diffMode === 'unified'} onClick={() => setMode('unified')}>{t("单列")}</button><button aria-pressed={preferences.diffMode === 'split'} onClick={() => setMode('split')}>{t("并排")}</button></>}<label><input type="checkbox" checked={preferences.wrap} onChange={event => setWrap(event.target.checked)}/>{t("自动折行")}</label></div>}
      </div>
    </div>
    <div className="diff-baseline">
      {objects.before && <><span title={objects.before.value}>{objectLabel({ ...objects.before, label: t(objects.before.label) })}</span><span aria-hidden="true">→</span></>}
      <span title={objects.after.value}>{objectLabel({ ...objects.after, label: t(objects.after.label) })}</span>
      <button className="diff-details-toggle" aria-label={t('文件变化信息')} aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen(value => !value)}>{t('查看详情')} <span aria-hidden="true">{detailsOpen ? '▾' : '▸'}</span></button>
    </div>
    <dl id={detailsId} className="diff-object-details" hidden={!detailsOpen} aria-label={t('文件变化信息')}>
      <div><dt>{t('所选路径')}</dt><dd>{diff.entry.path}</dd></div>
      {objects.before && <div><dt>{t(objects.before.label)}</dt><dd>{objects.before.value}</dd></div>}
      <div><dt>{t(objects.after.label)}</dt><dd>{objects.after.value}</dd></div>
      {observedAt && <div><dt>{t('读取于 ')}</dt><dd><time dateTime={observedAt}>{new Date(observedAt).toLocaleString(locale, { hour12: false })}</time></dd></div>}
    </dl>
    {metadata.length > 0 && <dl className="patch-metadata" aria-label={t("文件变化信息")}>{metadata.map((item, index) => <div key={index}><dt>{t(item.label)}</dt><dd>{item.label === '新增文件' || item.label === '删除文件' ? t(item.value) : item.value}</dd></div>)}</dl>}
    {incompleteReason && <div className="notice warning" role="status">{t(incompleteReason)}</div>}
    {diff.format === 'unavailable' ? <div className="empty-inline"><span className="empty-glyph">▧</span><h3>{t("内容未展开")}</h3></div> : hasLines ? <div ref={scroll} className="code-scroll" onScroll={event => { position.current = event.currentTarget.scrollTop; rememberPosition(positionKey, position.current); }} tabIndex={0} aria-label={diff.format === 'text' ? t('未跟踪文件文本预览') : t('文件差异')}>
      {mode === 'split' ? <SideBySideDiff rows={alignDiffLines(lines)} beforeLabel={t(objects.before!.label)} afterLabel={t(objects.after.label)}/> : <div className={`code-table${isPatch ? '' : ' text-code-table'}`}>{lines.map((line, index) => <div key={index} className={`code-line ${line.type}`}>
        {isPatch && <span className="line-number" aria-hidden="true">{line.oldLine}</span>}<span className="line-number" aria-hidden="true">{line.newLine}</span><code>{line.text || ' '}</code>
      </div>)}</div>}
    </div> : <p className="diff-empty-content muted">{isPatch ? t('无文本行变化。') : t('空文件。')}</p>}
    {isPatch && diff.text && <details className="raw-patch" open={rawOpen} onToggle={event => setRawOpen(event.currentTarget.open)}>
      <summary>{t("原始补丁")}{!diff.complete && t(' · 已获取部分')}</summary>
      <div className="raw-patch-actions"><button onClick={() => void copyPatch()}>{diff.complete ? t('复制补丁') : t('复制已获取部分')}</button><span role="status">{t(copyStatus)}</span></div>
      <pre className="raw-patch-content" tabIndex={0} aria-label={diff.complete ? t('原始补丁内容') : t('已获取的补丁内容')}>{diff.text}</pre>
    </details>}
  </div>;
}
