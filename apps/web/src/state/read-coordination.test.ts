import { describe, expect, it } from 'vitest';
import { ReadCancellation, type ReadSlot } from './read-coordination';

const dependentPairs: [ReadSlot, ReadSlot][] = [['overview', 'diff'], ['commit', 'commit-diff']];

describe('explicit read cancellation', () => {
  it.each(dependentPairs)('cancelling %s also stops its dependent %s read', (parent, child) => {
    const cancellation = new ReadCancellation();
    expect(cancellation.hasCancelled()).toBe(false);
    expect(cancellation.cancel(parent)).toEqual([parent, child]);
    expect(cancellation.isCancelled(parent)).toBe(true);
    expect(cancellation.isCancelled(child)).toBe(true);
    expect(cancellation.isCancelled('history')).toBe(false);
    expect(cancellation.hasCancelled()).toBe(true);
    cancellation.resume(parent);
    expect(cancellation.isCancelled(child)).toBe(false);
    expect(cancellation.hasCancelled()).toBe(false);
  });

  it.each(dependentPairs)('cancelling child %s/%s does not stop its parent', (parent, child) => {
    const cancellation = new ReadCancellation();
    expect(cancellation.cancel(child)).toEqual([child]);
    expect(cancellation.isCancelled(parent)).toBe(false);
    expect(cancellation.isCancelled(child)).toBe(true);
  });

  it('resuming one scope preserves unrelated cancellations', () => {
    const cancellation = new ReadCancellation();
    cancellation.cancel('overview');
    cancellation.cancel('commit');
    cancellation.cancel('navigation');
    cancellation.resume('overview');
    expect(cancellation.isCancelled('overview')).toBe(false);
    expect(cancellation.isCancelled('diff')).toBe(false);
    expect(cancellation.isCancelled('commit')).toBe(true);
    expect(cancellation.isCancelled('commit-diff')).toBe(true);
    expect(cancellation.isCancelled('navigation')).toBe(true);
    expect(cancellation.hasCancelled()).toBe(true);
  });

  it('resuming a selected child does not clear a cancelled parent', () => {
    const cancellation = new ReadCancellation();
    cancellation.cancel('overview');
    cancellation.resume('diff');
    expect(cancellation.isCancelled('diff')).toBe(false);
    expect(cancellation.isCancelled('overview')).toBe(true);
  });

  it('a new generation can reset every cancellation', () => {
    const cancellation = new ReadCancellation();
    cancellation.cancel('overview');
    cancellation.cancel('commit');
    cancellation.cancel('history');
    cancellation.cancel('navigation');
    cancellation.reset();
    const slots: ReadSlot[] = ['overview', 'navigation', 'history', 'commit', 'diff', 'commit-diff'];
    for (const slot of slots) expect(cancellation.isCancelled(slot)).toBe(false);
    expect(cancellation.hasCancelled()).toBe(false);
  });
});
