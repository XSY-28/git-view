import { useI18n } from '../../i18n/index';
import { useEffect, useMemo, useRef, useState } from 'react';
import { layoutHistory } from '@git-view/graph-layout';
import type { CommitNode } from '@git-view/contracts';
import { listNavigationTarget } from '../navigation/list-navigation';

const ROW = 56; const LANE = 17;
const LANE_COLORS = ['var(--graph-1)', 'var(--graph-2)', 'var(--graph-3)', 'var(--graph-4)', 'var(--graph-5)'];

export interface LocateRequest { version: number; targetOid: string }

export function HistoryGraph({ commits, selected, headOid, onSelect, locateRequest, onLocateConsumed, initialTop = 0, onScroll, fullWidth = false }: { fullWidth?: boolean; commits: CommitNode[]; selected?: string; headOid?: string; onSelect: (commit: CommitNode, activate?: boolean) => void; locateRequest?: LocateRequest; onLocateConsumed: (version: number) => void; initialTop?: number; onScroll?: (top: number) => void }) {
  const { t, locale } = useI18n();
  const layout = useMemo(() => layoutHistory(commits), [commits]);
  const scroll = useRef<HTMLDivElement>(null);
  const pan = useRef<HTMLDivElement>(null);
  const consumedLocateVersion = useRef<number | undefined>(undefined);
  const [top, setTop] = useState(0); const [height, setHeight] = useState(500); const [width, setWidth] = useState(400);
  const [left, setLeft] = useState(0);
  const start = Math.max(0, Math.floor(top / ROW) - 5);
  const end = Math.min(commits.length, Math.ceil((top + height) / ROW) + 5);
  const graphWidth = Math.max(44, layout.laneCount * LANE + 20);
  // Clip the graph within its own column; descriptions never sit on top of lanes.
  // With details closed, reserve a compact reading column and give wide graphs
  // the remaining space. Small graphs still stop at their natural width.
  const descriptionWidth = Math.min(360, Math.max(220, width * .35));
  const availableGraphWidth = fullWidth ? width - descriptionWidth : Math.min(width * .4, width - 220);
  const graphColumnWidth = Math.min(graphWidth, Math.max(44, availableGraphWidth));
  const maxPan = Math.max(0, graphWidth - graphColumnWidth);
  function panTo(value: number) {
    const next = Math.max(0, Math.min(maxPan, value));
    if (pan.current) pan.current.scrollLeft = next;
    setLeft(next);
  }
  function revealLane(index: number) {
    const x = 15 + layout.rows[index]!.lane * LANE;
    if (x < left + 12) panTo(x - 12);
    else if (x > left + graphColumnWidth - 12) panTo(x - graphColumnWidth + 12);
  }
  useEffect(() => {
    const node = scroll.current; if (!node) return;
    node.scrollTop = initialTop; setTop(node.scrollTop);
    const observer = new ResizeObserver(([entry]) => { if (entry) { setHeight(entry.contentRect.height); setWidth(entry.contentRect.width); } });
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => { panTo(Math.min(left, maxPan)); }, [maxPan]);
  useEffect(() => {
    const node = scroll.current;
    if (!node || !locateRequest || consumedLocateVersion.current === locateRequest.version) return;
    const index = commits.findIndex(commit => commit.oid === locateRequest.targetOid);
    if (index < 0) return;
    consumedLocateVersion.current = locateRequest.version;
    node.scrollTo({ top: Math.max(0, index * ROW - node.clientHeight / 3), behavior: 'smooth' });
    revealLane(index);
    // The parent clears the request so remounting this graph cannot replay an old locate.
    onLocateConsumed(locateRequest.version);
  }, [locateRequest, commits, onLocateConsumed]);
  function keyboard(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const target = listNavigationTarget(event.key, index, commits.length);
    if (target === undefined) return;
    event.preventDefault(); const commit = commits[target]; if (!commit) return;
    const node = scroll.current; if (!node) return;
    const nextTop = target * ROW < node.scrollTop ? target * ROW : (target + 1) * ROW > node.scrollTop + node.clientHeight ? (target + 1) * ROW - node.clientHeight : node.scrollTop;
    if (commit.oid !== selected) onSelect(commit, false);
    revealLane(target);
    setTop(nextTop); node.scrollTo({ top: nextTop });
    requestAnimationFrame(() => scroll.current?.querySelector<HTMLButtonElement>(`[data-row="${target}"]`)?.focus({ preventScroll: true }));
  }
  return <div className="history-chart">
    <div ref={scroll} data-testid="history-scroll" className="history-scroll" tabIndex={-1} onScroll={event => { setTop(event.currentTarget.scrollTop); onScroll?.(event.currentTarget.scrollTop); }} aria-label={t("提交历史，方向键切换提交")}>
    <div className="history-virtual" style={{ height: commits.length * ROW + (layout.continuations.length ? 36 : 0) }}>
      {commits.slice(start, end).map((commit, offset) => {
        const index = start + offset; const row = layout.rows[index]!;
        return <button key={commit.oid} data-testid="commit-row" data-row={index} className={`commit-row ${selected === commit.oid ? 'selected' : ''}`} style={{ top: index * ROW, height: ROW }} onClick={() => onSelect(commit)} onKeyDown={event => keyboard(event, index)} aria-pressed={selected === commit.oid} title={`${commit.subject}\n${commit.author} · ${new Date(commit.authoredAt).toLocaleString(locale)}\n${commit.oid}${commit.refs.length ? `\n${commit.refs.join(', ')}` : ''}`}>
          <span className="history-graph-viewport" style={{ width: graphColumnWidth }} onWheel={event => {
            const delta = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
            if (delta) panTo(left + delta);
          }}>
          <svg className="commit-graph" width={graphWidth} height={ROW} style={{ transform: `translateX(${-left}px)` }} aria-hidden="true">
            {row.segments.map((segment, i) => {
              const x1 = 15 + segment.fromLane * LANE; const x2 = 15 + segment.toLane * LANE;
              const y1 = segment.from === 'top' ? 0 : ROW / 2; const y2 = segment.to === 'node' ? ROW / 2 : ROW;
              return <path key={i} d={`M ${x1} ${y1} C ${x1} ${(y1+y2)/2} ${x2} ${(y1+y2)/2} ${x2} ${y2}`} fill="none" stroke={LANE_COLORS[segment.toLane % LANE_COLORS.length]} strokeWidth="1.6" />;
            })}
            {headOid === commit.oid && <circle cx={15 + row.lane * LANE} cy={ROW / 2} r="9" fill="none" stroke={LANE_COLORS[row.lane % LANE_COLORS.length]} opacity=".4" />}
            {row.boundary ? <rect x={11 + row.lane * LANE} y={ROW / 2 - 4} width="8" height="8" fill="var(--paper)" stroke={LANE_COLORS[row.lane % LANE_COLORS.length]} strokeWidth="2" /> : <circle cx={15 + row.lane * LANE} cy={ROW / 2} r="4.5" fill={selected === commit.oid ? LANE_COLORS[row.lane % LANE_COLORS.length] : 'var(--paper)'} stroke={LANE_COLORS[row.lane % LANE_COLORS.length]} strokeWidth="2" />}
          </svg>
          </span>
          <span className="commit-copy"><span className="commit-subject">{headOid === commit.oid && <span className="ref-label head-label">HEAD</span>}{commit.subject || t('（无提交说明）')}</span><span className="commit-meta"><span className="commit-author">{commit.author}</span>{commit.boundary && <span className="boundary-label">{t("浅克隆边界")}</span>}{commit.refs.length > 0 && <span className="commit-refs">{commit.refs.map(ref => <span className="ref-label" key={ref} title={ref}>{ref}</span>)}</span>}</span></span>
        </button>;
      })}
      {layout.continuations.length > 0 && <div className="graph-continuation" style={{ top: commits.length * ROW }}><span aria-hidden="true">┆</span> {t(" 父提交尚未加载 · 继续加载可展开关系")}</div>}
    </div>
    </div>
    {maxPan > 0 && <div ref={pan} className="history-graph-pan" tabIndex={0} role="region" aria-label={t("横向滚动提交关系图")} title={t("横向滚动仅移动左侧关系图")} onScroll={event => setLeft(event.currentTarget.scrollLeft)}>
      <div style={{ width: `calc(100% + ${maxPan}px)`, height: 1 }} />
    </div>}
  </div>;
}
