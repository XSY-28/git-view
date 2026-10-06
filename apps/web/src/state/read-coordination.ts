export type ReadSlot = 'overview' | 'navigation' | 'history' | 'commit' | 'diff' | 'commit-diff';

const dependentReads: Partial<Record<ReadSlot, readonly ReadSlot[]>> = {
  overview: ['diff'],
  commit: ['commit-diff'],
};

const readScope = (slot: ReadSlot): ReadSlot[] => [slot, ...(dependentReads[slot] ?? [])];

/** Keep an explicit cancellation effective when a parent later starts its child read. */
export class ReadCancellation {
  private cancelled = new Set<ReadSlot>();

  cancel(slot: ReadSlot): ReadSlot[] {
    const scope = readScope(slot);
    for (const item of scope) this.cancelled.add(item);
    return scope;
  }

  resume(slot: ReadSlot): void {
    for (const item of readScope(slot)) this.cancelled.delete(item);
  }

  isCancelled(slot: ReadSlot): boolean { return this.cancelled.has(slot); }
  hasCancelled(): boolean { return this.cancelled.size > 0; }
  reset(): void { this.cancelled.clear(); }
}
