import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { listNavigationTarget } from '../navigation/list-navigation';

export function InvestigationList<T>({ items, itemKey, render, onSelect, disabled, selected, label }: { items: T[]; itemKey: (item: T) => string; render: (item: T) => ReactNode; onSelect: (item: T, activate: boolean) => void; disabled: boolean; selected?: string; label: string }) {
  const root = useRef<HTMLDivElement>(null);
  function keyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('.investigation-row:not(:disabled)') ?? []);
    const target = listNavigationTarget(event.key, buttons.indexOf(event.currentTarget), buttons.length);
    if (target === undefined) return;
    event.preventDefault(); const button = buttons[target]; const item = items.find(item => itemKey(item) === button?.dataset.itemId);
    if (item) onSelect(item, false); button?.focus({ preventScroll: true }); button?.scrollIntoView({ block: 'nearest' });
  }
  return <div className="investigation-list" ref={root} aria-label={label}>{items.map(item => <button key={itemKey(item)} data-item-id={itemKey(item)} className="investigation-row" disabled={disabled} aria-pressed={selected === itemKey(item)} onClick={() => onSelect(item, true)} onKeyDown={keyboard}>{render(item)}</button>)}</div>;
}
