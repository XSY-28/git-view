import { describe, expect, it } from 'vitest';
import { layoutHistory } from './index';

describe('history drawing is independent of Git facts', () => {
  it('keeps linear history on one lane and distinguishes unloaded parents', () => {
    const result = layoutHistory([{ oid: 'b', parents: ['a'] }]);
    expect(result.laneCount).toBe(1);
    expect(result.continuations).toEqual([{ oid: 'a', lane: 0 }]);
    expect(layoutHistory([{ oid: 'b', parents: ['a'] }, { oid: 'a', parents: [] }]).continuations).toEqual([]);
  });
  it('draws both merge parents, converges once, and retains unrelated lanes', () => {
    const source = [{ oid: 'merge', parents: ['left', 'right'] }, { oid: 'right', parents: ['base'] }, { oid: 'left', parents: ['base'] }, { oid: 'base', parents: [] }];
    const result = layoutHistory(source);
    expect(result.rows[0]?.segments.filter(segment => segment.from === 'node')).toHaveLength(2);
    expect(result.rows[1]?.segments.some(segment => segment.from === 'top' && segment.to === 'bottom')).toBe(true);
    expect(result.continuations).toEqual([]);
    expect(result.laneCount).toBe(2);
    expect(source[0]?.parents).toEqual(['left', 'right']);
  });
  it('has stable row geometry when another page is appended', () => {
    const first = [{ oid: 'm', parents: ['a', 'b'] }, { oid: 'a', parents: ['c'] }];
    expect(layoutHistory([...first, { oid: 'b', parents: ['c'] }, { oid: 'c', parents: [] }]).rows.slice(0, 2)).toEqual(layoutHistory(first).rows);
  });
  it('marks shallow boundaries without pretending the missing parent is available', () => {
    const result = layoutHistory([{ oid: 'edge', parents: ['missing'], boundary: true }]);
    expect(result.rows[0]?.boundary).toBe(true);
    expect(result.continuations).toEqual([]);
  });
  it('supports octopus merges and disconnected histories', () => {
    const result = layoutHistory([{ oid: 'm', parents: ['a', 'b', 'c'] }, { oid: 'other', parents: [] }, { oid: 'a', parents: [] }, { oid: 'b', parents: [] }, { oid: 'c', parents: [] }]);
    expect(result.rows[0]?.segments).toHaveLength(3);
    expect(result.continuations).toEqual([]);
  });
});
