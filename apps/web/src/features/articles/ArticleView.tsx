import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { articleResultSchema, articleSourceSchema, folderChoiceSchema, type Article, type ArticleSource, type RepositorySession } from '@git-view/contracts';
import { articleStructure } from '../../../../shared/article-markdown';
import { api, errorMessage } from '../../state/api';
import { readPreferences, rememberPosition } from '../../state/repository-controller';
import { useI18n } from '../../i18n';
import { ArticleContent } from './ArticleContent';
import './articles.css';

const request = () => ({ schemaVersion: 1 as const, requestId: crypto.randomUUID() });
export function ArticleView({ session, blocked }: { session: RepositorySession; blocked: boolean }) {
  const { t, locale } = useI18n();
  const [article, setArticle] = useState<Article | null>(); const [error, setError] = useState('');
  const [importing, setImporting] = useState(false); const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<ArticleSource>(); const [path, setPath] = useState(''); const [mainFile, setMainFile] = useState('');
  const [importError, setImportError] = useState(''); const [activeHeading, setActiveHeading] = useState('');
  const scroll = useRef<HTMLDivElement>(null); const content = useRef<HTMLDivElement>(null); const dialog = useRef<HTMLDialogElement>(null);
  const lifetime = useRef(new AbortController()); const positionTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const headings = useMemo(() => article ? articleStructure(article.markdown).headings : [], [article]);
  const positionKey = article ? `article:${session.repository.repositoryId}:${article.id}` : '';
  const restoring = useRef(false); const savedTop = useRef(0);
  async function read() {
    setError('');
    try { const result = await api({ ...request(), sessionId: session.sessionId, action: 'article' }, articleResultSchema, lifetime.current.signal); setArticle(result.data.article); }
    catch (failure) { if (!lifetime.current.signal.aborted) setError(errorMessage(failure)); }
  }
  useEffect(() => {
    lifetime.current = new AbortController(); void read();
    return () => { lifetime.current.abort(); clearTimeout(positionTimer.current); };
  }, [session.sessionId]);
  useEffect(() => { if (importing) dialog.current?.showModal(); }, [importing]);
  useLayoutEffect(() => {
    const node = scroll.current; const body = content.current;
    if (!article || !node || !body) return;
    const key = `article:${session.repository.repositoryId}:${article.id}`;
    savedTop.current = readPreferences().positions[key] ?? 0; restoring.current = true;
    const restore = () => { if (restoring.current) node.scrollTop = savedTop.current; };
    const observer = new ResizeObserver(restore); observer.observe(body); restore();
    return () => { observer.disconnect(); rememberPosition(key, restoring.current ? savedTop.current : node.scrollTop); };
  }, [article?.id, session.repository.repositoryId]);
  function onScroll() {
    const node = scroll.current; if (!node) return;
    const top = node.scrollTop;
    const current = headings.filter(h => { const el = document.getElementById(h.id); return el && el.getBoundingClientRect().top <= node.getBoundingClientRect().top + 100; }).at(-1);
    setActiveHeading(current?.id ?? headings[0]?.id ?? '');
    if (positionKey && !restoring.current) { clearTimeout(positionTimer.current); positionTimer.current = setTimeout(() => rememberPosition(positionKey, top), 150); }
  }
  function navigate(id: string) { restoring.current = false; document.getElementById(id)?.scrollIntoView({ block: 'start' }); setActiveHeading(id); }
  async function importArticle(selected: ArticleSource, main?: string) {
    const result = await api({ ...request(), sessionId: session.sessionId, action: 'article-import', sourcePath: selected.sourcePath, mainFile: main }, articleResultSchema, lifetime.current.signal);
    if (!lifetime.current.signal.aborted) { setArticle(result.data.article); setImporting(false); setError(''); }
  }
  async function inspect(sourcePath: string) {
    const result = await api({ ...request(), sessionId: session.sessionId, action: 'article-source', sourcePath }, articleSourceSchema, lifetime.current.signal);
    if (result.data.files.length === 1) await importArticle(result.data, result.data.files[0]);
    else { setSource(result.data); setMainFile(result.data.files[0]!); }
  }
  async function run(action: () => Promise<void>) {
    if (busy || blocked) return;
    setBusy(true); setImportError('');
    try { await action(); } catch (failure) { if (!lifetime.current.signal.aborted) setImportError(errorMessage(failure)); }
    finally { if (!lifetime.current.signal.aborted) setBusy(false); }
  }
  async function pick(kind: 'file' | 'folder') {
    const result = await api({ ...request(), action: 'pick-article', kind }, folderChoiceSchema, lifetime.current.signal);
    if (!result.data.cancelled) { setPath(result.data.path); await inspect(result.data.path); }
  }
  return <section className="article-view" aria-label={t('重大变更文章')}>
    <header className="article-toolbar"><div><span className="article-eyebrow">{t('项目演化')}</span><span className="article-source">{article ? t('已保存到本机 · {0}', [article.sourceName]) : t('理解每一次设计选择')}</span></div><button className="article-import-button" disabled={blocked} onClick={() => { setSource(undefined); setPath(''); setImportError(''); setImporting(true); }}>{t(article ? '替换文章' : '导入文章')}</button></header>
    {error && <div className="article-notice" role="alert">{t(error)} <button onClick={() => void read()}>{t('重试')}</button></div>}
    {article === undefined && !error && <p className="article-empty">{t('正在读取文章…')}</p>}
    {article === null && <div className="article-empty"><span aria-hidden="true">§</span><h1>{t('为这个仓库导入一篇演化文章')}</h1><p>{t('从简单的起点，读懂每一次重要的设计变化。')}</p><p>{t('支持 Markdown、表格、Mermaid 图表和本地配图。')}</p></div>}
    {article && <div className="article-layout">
      <aside className="article-toc"><details open><summary>{t('文章目录')}</summary><nav aria-label={t('文章目录')}>{headings.map(h => <button key={h.id} className={activeHeading === h.id ? 'active' : ''} data-depth={h.depth} aria-current={activeHeading === h.id ? 'location' : undefined} onClick={() => navigate(h.id)}>{h.text}</button>)}{!headings.length && <p>{t('文章没有章节标题。')}</p>}</nav></details><p className="article-imported-at">{t('导入于 {0}', [new Date(article.importedAt).toLocaleDateString(locale)])}</p></aside>
      <div ref={scroll} data-testid="article-scroll" className="article-scroll" tabIndex={0} aria-label={t('文章正文')} onScroll={onScroll} onWheel={() => { restoring.current = false; }} onPointerDown={() => { restoring.current = false; }} onKeyDown={() => { restoring.current = false; }}>
        <div ref={content} className="article-content">
          {article.warnings.length > 0 && <details className="article-notice"><summary>{t('部分图片未导入（{0}）', [article.warnings.length])}</summary><ul>{article.warnings.map(warning => <li key={warning}>{t(warning)}</li>)}</ul></details>}
          <ArticleContent key={article.id} article={article} />
        </div>
      </div>
    </div>}
    {importing && <dialog ref={dialog} className="article-import-dialog" aria-labelledby="article-import-title" onCancel={event => { if (busy) event.preventDefault(); else setImporting(false); }}>
      <h2 id="article-import-title">{t(article ? '替换重大变更文章' : '导入重大变更文章')}</h2><p>{t('文章和配图将保存到当前仓库的本机阅读资料中。')}</p>
      <div className="article-picker-buttons"><button disabled={busy || blocked} onClick={() => void run(() => pick('file'))}>{t('选择 Markdown')}</button><button disabled={busy || blocked} onClick={() => void run(() => pick('folder'))}>{t('选择资料文件夹')}</button></div>
      <form onSubmit={event => { event.preventDefault(); void run(() => inspect(path.trim())); }}><label htmlFor="article-path">{t('文章或资料文件夹路径')}</label><div className="article-path-row"><input id="article-path" value={path} disabled={busy} placeholder={t('也可直接输入绝对路径')} onChange={event => { setPath(event.target.value); setSource(undefined); }} /><button disabled={busy || blocked || !path.trim()}>{t('读取并导入')}</button></div></form>
      {source && <div className="article-main-choice"><label htmlFor="article-main">{t('选择主文章')}</label><select id="article-main" value={mainFile} onChange={event => setMainFile(event.target.value)} disabled={busy}>{source.files.map(file => <option key={file} value={file}>{file}</option>)}</select><button disabled={busy || blocked} onClick={() => void run(() => importArticle(source, mainFile))}>{t('导入所选文章')}</button></div>}
      {busy && <p role="status">{t('正在导入，请稍候…')}</p>}{importError && <p className="article-import-error" role="alert">{t(importError)}</p>}
      <div className="article-dialog-footer"><small>{t('支持 UTF-8 Markdown；本地图片使用相对路径。')}</small><button disabled={busy} onClick={() => setImporting(false)}>{t('取消')}</button></div>
    </dialog>}
  </section>;
}
