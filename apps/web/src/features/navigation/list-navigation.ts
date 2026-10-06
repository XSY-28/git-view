/** Resolve navigation within the caller's visible, enabled items. Edges never wrap. */
export function listNavigationTarget(key: string, current: number, count: number): number | undefined {
  if (count === 0) return undefined;
  switch (key) {
    case 'ArrowDown': return Math.min(count - 1, Math.max(0, current + 1));
    case 'ArrowUp': return Math.max(0, current - 1);
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return undefined;
  }
}
