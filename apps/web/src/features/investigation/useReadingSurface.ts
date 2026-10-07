import { useEffect, useLayoutEffect, useRef, type UIEvent } from 'react';
import type { ReadingPosition } from './reading-memory';

/** Save actual reading positions, including movement while replacement data loads. */
export function useReadingSurface(position: ReadingPosition, ready: boolean, interactive = true) {
  const root = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    const savePage = () => { position.pageTop = window.scrollY; };
    window.addEventListener('scroll', savePage);
    return () => window.removeEventListener('scroll', savePage);
  }, [position]);
  useLayoutEffect(() => {
    if (!ready || !root.current) return;
    for (const node of root.current.querySelectorAll<HTMLElement>('[data-reading-scroll]')) {
      const saved = position.scroll[node.dataset.readingScroll!];
      if (saved) { node.scrollTop = saved.top; node.scrollLeft = saved.left; }
    }
    if (interactive && position.restoreFocus) {
      const target = [...root.current.querySelectorAll<HTMLElement>('[data-reading-focus]')].find(node => node.dataset.readingFocus === position.restoreFocus);
      if (target && !target.matches(':disabled')) { target.focus({ preventScroll: true }); position.restoreFocus = undefined; }
    }
    if (!mounted.current) { window.scrollTo({ top: position.pageTop }); mounted.current = true; }
  }, [ready, interactive, position]);
  function onScrollCapture(event: UIEvent<HTMLElement>) {
    const node = event.target;
    if (node instanceof HTMLElement && node.dataset.readingScroll) position.scroll[node.dataset.readingScroll] = { top: node.scrollTop, left: node.scrollLeft };
  }
  return { ref: root, onScrollCapture };
}
