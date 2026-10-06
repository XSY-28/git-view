import type { HistoryScope } from '../../state/repository-controller';

export const historyScopes = [
  { value: 'head', label: '当前 HEAD' },
  { value: 'all', label: '全部引用' },
] as const;

export const referenceName = (ref: string) => ref.replace(/^refs\/(heads|tags|remotes)\//, '');

export function historyScopeLabel(scope: HistoryScope, ref?: string): string {
  return scope === 'ref' ? referenceName(ref || '') : historyScopes.find(option => option.value === scope)!.label;
}
