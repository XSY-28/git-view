import { describe, expect, it } from 'vitest';
import { alignDiffLines } from './SideBySideDiff';
import { parseDiffLines } from '../changes/diff-lines';
describe('side by side alignment', () => {
  it('pairs replacement runs, keeps gaps unnumbered and attaches no-newline metadata to the source side', () => {
    const rows = alignDiffLines(parseDiffLines('@@ -4,3 +4,2 @@\n same\n-old\n-extra\n+新\n\\ No newline at end of file', 'diff'));
    expect(rows[0]?.wide?.type).toBe('hunk');
    expect(rows[1]?.left?.oldLine).toBe('4'); expect(rows[1]?.right?.newLine).toBe('4');
    expect(rows[2]?.left?.oldLine).toBe('5'); expect(rows[2]?.right?.newLine).toBe('5');
    expect(rows[3]?.left?.oldLine).toBe('6'); expect(rows[3]?.right).toBeUndefined();
    expect(rows[2]?.rightNotes).toEqual(['\\ No newline at end of file']); expect(rows).toHaveLength(4);
  });
  it('aligns a real replacement when neither side has a final newline', () => {
    const rows = alignDiffLines(parseDiffLines('@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file', 'diff'));
    expect(rows).toHaveLength(2); expect(rows[1]?.left?.oldLine).toBe('1'); expect(rows[1]?.right?.newLine).toBe('1');
    expect(rows[1]?.leftNotes).toEqual(['\\ No newline at end of file']); expect(rows[1]?.rightNotes).toEqual(['\\ No newline at end of file']);
  });
  it('keeps a literal EOF-marker-looking line in untracked text numbered as real content', () => {
    const rows = alignDiffLines(parseDiffLines('first\n\\ No newline at end of file', 'text'));
    expect(rows).toHaveLength(2); expect(rows[1]?.right?.newLine).toBe('2');
    expect(rows[1]?.right?.text).toBe('\\ No newline at end of file'); expect(rows[0]?.rightNotes).toBeUndefined();
  });

});
