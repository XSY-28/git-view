import { useI18n } from '../../i18n/index';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import './history-pane.css';

const SEPARATOR_WIDTH = 6;
const HISTORY_MIN = 320;
const DETAIL_MIN = 280;
const DEFAULT_DETAIL_WIDTH = 420;

interface Drag {
  element: HTMLDivElement;
  pointerId: number;
  originX: number;
  originWidth: number;
  pendingWidth: number;
}

function bounds(workspaceWidth: number) {
  const available = Math.max(0, workspaceWidth - SEPARATOR_WIDTH);
  const scale = Math.min(1, available / (HISTORY_MIN + DETAIL_MIN));
  return { available, min: DETAIL_MIN * scale, max: available - HISTORY_MIN * scale };
}

function release(drag: Drag) {
  if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
}

/** Keep the chosen width independent of temporary window constraints. */
export function useHistoryPaneLayout() {
  const { t, locale } = useI18n();
  const [workspace, setWorkspace] = useState<HTMLElement | null>(null);
  // The callback observes a main element that can mount after bootstrap; current
  // also lets the caller return focus to its selected row after closing details.
  const workspaceRef = useMemo(() => {
    const ref = Object.assign((node: HTMLElement | null) => {
      ref.current = node;
      setWorkspace(node);
    }, { current: null as HTMLElement | null });
    return ref;
  }, []);
  const [workspaceWidth, setWorkspaceWidth] = useState(HISTORY_MIN + DEFAULT_DETAIL_WIDTH + SEPARATOR_WIDTH);
  const [preferredWidth, setPreferredWidth] = useState(DEFAULT_DETAIL_WIDTH);
  const [previewWidth, setPreviewWidth] = useState<number>();
  const drag = useRef<Drag | undefined>(undefined);
  const limit = bounds(workspaceWidth);
  const clamp = (value: number) => Math.max(limit.min, Math.min(limit.max, value));
  const detailWidth = clamp(previewWidth ?? preferredWidth);
  const historyWidth = limit.available - detailWidth;

  const finish = useCallback((accept: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = undefined;
    // A click without movement must not replace a constrained preference.
    if (accept && current.pendingWidth !== current.originWidth) setPreferredWidth(current.pendingWidth);
    setPreviewWidth(undefined);
    release(current);
  }, []);

  const separatorRef = useCallback((node: HTMLDivElement | null) => {
    // Switching views or closing the pane can remove a captured pointer target.
    if (!node) finish(false);
  }, [finish]);

  useLayoutEffect(() => {
    if (!workspace) return;
    const measure = () => {
      const width = workspace.clientWidth;
      if (width > 0) setWorkspaceWidth(width);
      if (!width || window.innerWidth <= 720) finish(false);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); finish(false); };
  }, [workspace, finish]);

  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || drag.current) return;
    event.preventDefault();
    const element = event.currentTarget;
    element.focus({ preventScroll: true });
    drag.current = { element, pointerId: event.pointerId, originX: event.clientX, originWidth: detailWidth, pendingWidth: detailWidth };
    element.setPointerCapture(event.pointerId);
    setPreviewWidth(detailWidth);
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const next = clamp(current.originWidth - (event.clientX - current.originX));
    current.pendingWidth = next;
    setPreviewWidth(next);
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && drag.current) {
      event.preventDefault(); event.stopPropagation(); finish(false); return;
    }
    if (event.altKey || event.metaKey || event.ctrlKey || drag.current) return;
    const step = event.shiftKey ? 80 : 20;
    const next = event.key === 'ArrowLeft' ? detailWidth + step
      : event.key === 'ArrowRight' ? detailWidth - step
        : event.key === 'Home' ? limit.max
          : event.key === 'End' ? limit.min : undefined;
    if (next === undefined) return;
    event.preventDefault(); event.stopPropagation();
    const value = clamp(next);
    if (value !== detailWidth) setPreferredWidth(value);
  }

  const workspaceStyle = { '--history-detail-width': `${detailWidth}px` } as CSSProperties;
  const separator = <div
    ref={separatorRef}
    className="history-pane-resizer"
    role="separator"
    aria-label={t("调整历史与详情宽度")}
    aria-orientation="vertical"
    aria-valuemin={Math.round(limit.available - limit.max)}
    aria-valuemax={Math.round(limit.available - limit.min)}
    aria-valuenow={Math.round(historyWidth)}
    aria-valuetext={t(`历史区域宽度 ${Math.round(historyWidth)} 像素`)}
    tabIndex={0}
    title={t("拖动调整宽度；左右方向键微调，Shift 加速，Home / End 移到边界")}
    data-dragging={previewWidth !== undefined ? 'true' : undefined}
    onPointerDown={start}
    onPointerMove={move}
    onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) finish(true); }}
    onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) finish(false); }}
    onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) finish(false); }}
    onKeyDown={keyboard}
  />;
  return { workspaceRef, workspaceStyle, separator };
}
