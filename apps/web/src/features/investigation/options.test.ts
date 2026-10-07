import { describe, expect, it } from 'vitest';
import type { Diff } from '@git-view/contracts';
import { fileHistoryLocation } from './options';

const base = 'a'.repeat(40); const target = 'b'.repeat(40);
function diff(kind: string, after: string, old?: string): Diff {
  return { entry: { id: 'entry', path: 'new.ts', rawPath: btoa('new.ts'), ...(old ? { oldPath: old, rawOldPath: btoa(old) } : {}), kind, supported: true, comparison: 'revision-pair' }, comparison: 'revision-pair', text: '', format: 'diff', complete: true, base, target: after };
}
describe('file history entry points', () => {
  it('includes the selected deletion commit in history instead of starting before it', () => {
    expect(fileHistoryLocation(diff('D', target))).toEqual({ endpoint: { kind: 'commit', oid: target }, path: 'new.ts' });
  });
  it('uses the committed new path for a committed rename and the old path for an uncommitted rename', () => {
    expect(fileHistoryLocation(diff('R100', target, 'old.ts'))).toEqual({ endpoint: { kind: 'commit', oid: target }, path: 'new.ts' });
    expect(fileHistoryLocation(diff('R100', 'index', 'old.ts'), target)).toEqual({ endpoint: { kind: 'commit', oid: base }, path: 'old.ts' });
  });
  it('falls back to the observed HEAD for worktree comparisons and never addresses files by escaped display text', () => {
    const value = diff('M', 'worktree'); value.base = 'index'; value.entry.path = 'escaped-display'; value.entry.rawPath = Buffer.from('中文\n原路径.ts').toString('base64');
    expect(fileHistoryLocation(value, target)).toEqual({ endpoint: { kind: 'commit', oid: target }, path: '中文\n原路径.ts' });
    expect(fileHistoryLocation({ ...value, entry: { ...value.entry, supported: false } }, target)).toBeUndefined();
  });
});
