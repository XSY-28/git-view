import { afterEach, describe, expect, it, vi } from 'vitest';
import { RefreshQueue, RepositoryController } from './repository-controller';
afterEach(() => vi.useRealTimers());
describe('refresh scheduling', () => {
  it('runs the latest invalidation after the throttle window instead of consuming and dropping it', () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const queue = new RefreshQueue(); const calls: string[] = [];
    queue.request(() => calls.push('focus'));
    vi.advanceTimersByTime(500); queue.request(() => calls.push('edit'));
    vi.advanceTimersByTime(100); queue.request(() => calls.push('latest edit'));
    expect(calls).toEqual(['focus']); vi.advanceTimersByTime(100); expect(calls).toEqual(['focus', 'latest edit']);
    vi.advanceTimersByTime(1000); expect(calls).toHaveLength(2);
  });
  it('discarding an old repository context cancels its scheduled refresh', () => {
    vi.useFakeTimers(); const queue = new RefreshQueue(); const run = vi.fn(); queue.request(run); queue.request(run); queue.reset(); vi.advanceTimersByTime(1000); expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('worktree view memory', () => {
  it('keeps comparison operands through normal view saves and isolates linked worktrees', () => {
    const controller = new RepositoryController(); controller.activate('main-worktree');
    const options = { a: { kind: 'head' as const }, b: { kind: 'ref' as const, name: 'refs/heads/topic' } };
    controller.comparison(options); controller.save({ view: 'comparison', scope: 'head', allHistoryOrder: 'date' });
    controller.save({ view: 'history', scope: 'head', allHistoryOrder: 'date' });
    controller.activate('linked-worktree'); expect(controller.comparison()).toBeUndefined();
    controller.activate('main-worktree'); expect(controller.comparison()).toEqual(options);
  });
  it('starts at HEAD and keeps all-reference ordering separate for each worktree', () => {
    const controller = new RepositoryController();
    expect(controller.activate('main-worktree')).toMatchObject({ scope: 'head', allHistoryOrder: 'date' });
    controller.save({ view: 'history', scope: 'all', allHistoryOrder: 'topo' });
    expect(controller.activate('linked-worktree')).toMatchObject({ scope: 'head', allHistoryOrder: 'date' });
    expect(controller.activate('main-worktree')).toMatchObject({ scope: 'all', allHistoryOrder: 'topo' });
  });
  it('records a cleared initial selection immediately without requiring a state save or render', () => {
    const controller = new RepositoryController();
    expect(controller.activate('main-worktree').selection).toBeUndefined();
    controller.clearSelection('changes'); controller.clearSelection('history');
    controller.fileFilter('history', 'no-match'); controller.fileFilter('history', '');
    expect(controller.activate('other-worktree').selection).toBeUndefined();
    expect(controller.activate('main-worktree')).toMatchObject({ selection: null, commitFile: null });
  });
  it('keeps each file filter separate from the other view and from linked worktrees', () => {
    const controller = new RepositoryController();
    controller.activate('main-worktree');
    controller.fileFilter('changes', 'src/'); controller.fileFilter('history', 'old-name');
    controller.save({ view: 'history', scope: 'head', allHistoryOrder: 'date', selection: null, commit: 'abc', commitFile: null });
    expect(controller.activate('linked-worktree').fileFilters).toEqual({ changes: '', history: '' });
    controller.fileFilter('changes', 'test/');
    const restored = controller.activate('main-worktree');
    expect(restored.fileFilters).toEqual({ changes: 'src/', history: 'old-name' });
    expect(restored.selection).toBeNull(); expect(restored.commitFile).toBeNull();
    expect(restored.view).toBe('history');
    expect(controller.activate('linked-worktree').fileFilters.changes).toBe('test/');
  });
});
