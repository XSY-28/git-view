import { Children, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Article } from '@git-view/contracts';
import { useI18n } from '../../i18n';

type Picture = { src: string; alt: string };
let renderer: Promise<typeof import('mermaid')['default']> | undefined;
function mermaidRenderer() {
  return renderer ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, suppressErrorRendering: true, maxTextSize: 30000, theme: 'base',
      secure: ['securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering'],
      themeVariables: { primaryColor: '#eee7d9', primaryTextColor: '#39372f', primaryBorderColor: '#b85b3c', lineColor: '#9a7751', secondaryColor: '#f4f0e7', fontFamily: 'system-ui, sans-serif', fontSize: '16px' },
      flowchart: { htmlLabels: false, useMaxWidth: true },
    }); return mermaid;
  });
}
function MermaidDiagram({ source, onZoom }: { source: string; onZoom: (picture: Picture) => void }) {
  const { t } = useI18n(); const [src, setSrc] = useState<string>(); const [error, setError] = useState(false);
  useEffect(() => {
    let active = true; const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden'; document.body.append(container);
    void (async () => {
      try {
        const mermaid = await mermaidRenderer();
        if (!active) return;
        const { svg } = await mermaid.render(`article-${crypto.randomUUID()}`, source, container);
        // An SVG image is inert; diagram markup never enters the app's DOM.
        const base64 = btoa(Array.from(new TextEncoder().encode(svg), byte => String.fromCharCode(byte)).join(''));
        if (active) setSrc(`data:image/svg+xml;base64,${base64}`);
      } catch { if (active) setError(true); }
      finally { container.remove(); }
    })();
    return () => { active = false; container.remove(); };
  }, [source]);
  if (error) return <div className="article-diagram-error" role="status"><p>{t('图表无法渲染，正文仍可阅读。')}</p><details><summary>{t('查看图表源码')}</summary><pre>{source}</pre></details></div>;
  if (!src) return <div className="article-diagram-loading" role="status">{t('正在绘制图表…')}</div>;
  return <figure className="article-diagram"><button className="article-media" aria-label={t('放大 Mermaid 图表')} onClick={() => onZoom({ src, alt: t('Mermaid 图表') })}><img src={src} alt={t('Mermaid 图表')} /></button><figcaption>{t('点击图表放大查看')}</figcaption></figure>;
}
function ImageZoom({ picture, onClose }: { picture: Picture; onClose: () => void }) {
  const { t } = useI18n(); const dialog = useRef<HTMLDialogElement>(null); const [scale, setScale] = useState(1);
  const viewport = useRef<HTMLDivElement>(null); const image = useRef<HTMLImageElement>(null); const [fitWidth, setFitWidth] = useState<number>();
  function fit() {
    const node = image.current; const area = viewport.current;
    if (node?.naturalWidth && node.naturalHeight && area) setFitWidth(Math.max(1, Math.min(area.clientWidth - 48, (area.clientHeight - 48) * node.naturalWidth / node.naturalHeight)));
  }
  useEffect(() => { dialog.current?.showModal(); const observer = new ResizeObserver(fit); if (viewport.current) observer.observe(viewport.current); return () => observer.disconnect(); }, []);
  return <dialog ref={dialog} className="article-zoom" aria-label={t('放大查看')} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="article-zoom-toolbar"><span>{picture.alt}</span><button aria-label={t('缩小')} onClick={() => setScale(Math.max(.5, scale - .25))}>−</button><button onClick={() => setScale(1)}>{Math.round(scale * 100)}%</button><button aria-label={t('放大')} onClick={() => setScale(Math.min(4, scale + .25))}>+</button><button onClick={onClose} autoFocus>{t('关闭')}</button></div>
    <div ref={viewport} className="article-zoom-scroll"><img ref={image} onLoad={fit} src={picture.src} alt={picture.alt} style={{ width: fitWidth ? `${fitWidth * scale}px` : '100%' }} /></div>
  </dialog>;
}
export function ArticleContent({ article }: { article: Article }) {
  const { t } = useI18n(); const [zoom, setZoom] = useState<Picture>();
  const [linkError, setLinkError] = useState(false);
  // ReactMarkdown uses these functions as component types. Keep them stable so
  // scrolling the outline or opening a zoom dialog cannot remount diagrams.
  const components = useMemo<Components>(() => {
    const result: Components = {
      a: ({ href, children }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noreferrer noopener" onClick={event => {
        if (!window.__TAURI__) return;
        event.preventDefault(); setLinkError(false);
        void window.__TAURI__.core.invoke('open_article_link', { url: href }).catch(() => setLinkError(true));
      }}>{children}</a> : <span>{children}</span>,
      img: ({ src, alt }) => {
        let decoded = src;
        try { if (src) decoded = decodeURI(src); } catch { /* Invalid URL remains an unavailable image. */ }
        const key = src && Object.hasOwn(article.assets, src) ? src : decoded;
        const saved = key && Object.hasOwn(article.assets, key) ? article.assets[key] : undefined;
        return saved ? <button className="article-media" aria-label={t('放大图片：{0}', [alt || t('图片')])} onClick={() => setZoom({ src: saved, alt: alt || t('图片') })}><img src={saved} alt={alt || t('图片')} /></button> : <span className="article-missing-image">{t('图片不可用：{0}', [alt || src || ''])}</span>;
      },
      pre: ({ children }) => {
        const child = Children.toArray(children)[0];
        if (isValidElement<{ className?: string; children?: ReactNode }>(child) && child.props.className === 'language-mermaid') return <MermaidDiagram source={String(child.props.children).trim()} onZoom={setZoom} />;
        return <pre>{children}</pre>;
      },
    };
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const) {
      const Tag = tag;
      result[tag] = ({ node, children }) => <Tag id={`section-${node?.position?.start.offset ?? 0}`}>{children}</Tag>;
    }
    return result;
  }, [article.assets, t]);
  return <>{linkError && <p role="alert">{t('无法打开链接，可以复制链接后在浏览器中打开。')}</p>}<div className="article-prose"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={(url, key) => key === 'src' ? url : /^https?:\/\//i.test(url) ? url : ''} components={components}>{article.markdown}</Markdown></div>{zoom && <ImageZoom picture={zoom} onClose={() => setZoom(undefined)} />}</>;
}
