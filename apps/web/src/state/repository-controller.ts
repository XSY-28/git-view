import { z } from 'zod';
import { REFRESH_TIMING } from '../../../shared/transport';
import type { ChangeEntry, ComparisonOptions, HistoryOrder } from '@git-view/contracts';
import type { InvestigationMemory } from '../features/investigation/options';

export type FileListScope = 'changes' | 'history';
export type MainView = FileListScope | 'comparison' | 'investigation';
export type HistoryScope = 'all' | 'head' | 'ref';
export type DiffMode = 'unified' | 'split';
const STORAGE_KEY = 'git-view.preferences.v1';
const preferencesSchema = z.object({ schemaVersion: z.literal(1), diffMode: z.enum(['unified', 'split']), wrap: z.boolean(), positions: z.record(z.string(), z.number().finite().nonnegative()) });
export type Preferences = z.infer<typeof preferencesSchema>;
export const DEFAULT_PREFERENCES: Preferences = { schemaVersion: 1, diffMode: 'unified', wrap: true, positions: {} };
export function readPreferences(): Preferences {
  try { const result = preferencesSchema.safeParse(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')); return result.success ? result.data : { ...DEFAULT_PREFERENCES, positions: {} }; }
  catch { return { ...DEFAULT_PREFERENCES, positions: {} }; }
}
export function writePreferences(value: Preferences) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferencesSchema.parse(value))); } catch { /* Storage denial never blocks reading a repository. */ }
}
export function rememberPosition(key: string, top: number) {
  const value = readPreferences();
  // Keep the local preference file bounded, retaining recently touched comparisons.
  const entries = Object.entries(value.positions).filter(([name]) => name !== key).slice(-99);
  writePreferences({ ...value, positions: { ...Object.fromEntries(entries), [key]: Math.max(0, top) } });
}
export interface ViewMemory {
  view: MainView; scope: HistoryScope; ref?: string; allHistoryOrder: HistoryOrder; selection?: ChangeEntry | null; commit?: string; commitFile?: ChangeEntry | null;
  scroll: Record<string, number>; search: string; fileFilters: Record<FileListScope, string>; comparison?: ComparisonOptions; investigation?: InvestigationMemory;
}
/** UI state belongs to a canonical worktree, never to a shared common Git directory. */
export class RepositoryController {
  private memories = new Map<string, ViewMemory>();
  private active?: string;
  pendingPath?: string;
  explicitOpen = false;
  activate(worktreeId: string): ViewMemory {
    this.active = worktreeId;
    let value = this.memories.get(worktreeId);
    if (!value) { value = { view: 'changes', scope: 'head', allHistoryOrder: 'date', scroll: {}, search: '', fileFilters: { changes: '', history: '' } }; this.memories.set(worktreeId, value); }
    return value;
  }
  save(value: Omit<ViewMemory, 'scroll' | 'search' | 'fileFilters'>) {
    if (!this.active) return;
    const previous = this.memories.get(this.active)!;
    this.memories.set(this.active, { ...previous, ...value, scroll: previous.scroll, search: previous.search, fileFilters: previous.fileFilters });
  }
  search(value?: string): string { const memory = this.active && this.memories.get(this.active); if (!memory) return ''; if (value !== undefined) memory.search = value; return memory.search; }
  fileFilter(view: FileListScope, value?: string): string { const memory = this.active && this.memories.get(this.active); if (!memory) return ''; if (value !== undefined) memory.fileFilters[view] = value; return memory.fileFilters[view]; }
  clearSelection(view: FileListScope) {
    const memory = this.active && this.memories.get(this.active);
    if (memory) memory[view === 'changes' ? 'selection' : 'commitFile'] = null;
  }
  comparison(options?: ComparisonOptions): ComparisonOptions | undefined { const memory = this.active && this.memories.get(this.active); if (!memory) return; if (options) memory.comparison = options; return memory.comparison; }
  investigation(options?: InvestigationMemory): InvestigationMemory { const memory = this.active && this.memories.get(this.active); if (!memory) return { tab: 'search' }; if (options) memory.investigation = options; return memory.investigation ?? { tab: 'search' }; }
  position(key: string) { return this.active ? this.memories.get(this.active)?.scroll[key] || 0 : 0; }
  scroll(key: string, top: number) { if (this.active) this.memories.get(this.active)!.scroll[key] = top; }
}

/** Coalesce bursts while guaranteeing that an invalidation inside the throttle window runs later. */
export class RefreshQueue {
  private last = -Infinity;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: () => void;
  request(run: () => void) {
    this.pending = run;
    const delay = Math.max(0, REFRESH_TIMING.minIntervalMs - (Date.now() - this.last));
    if (delay > 0) {
      if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, delay);
    } else { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.flush(); }
  }
  private flush() { const run = this.pending; this.pending = undefined; if (run) { this.last = Date.now(); run(); } }
  reset() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.pending = undefined; this.last = -Infinity; }
}
