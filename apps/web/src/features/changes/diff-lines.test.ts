import { describe, expect, it } from 'vitest';
import { parseDiffLines } from './diff-lines';

describe('rendering unified diff without confusing file headers and source code', () => {
  it('counts and numbers increment/decrement source lines inside hunks', () => {
    const lines = parseDiffLines('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -8,2 +8,2 @@\n---counter;\n+++counter;\n same;', 'diff');
    expect(lines[1]?.type).toBe('meta'); expect(lines[2]?.type).toBe('meta');
    expect(lines[4]).toMatchObject({ type: 'removed', oldLine: '8', newLine: '' });
    expect(lines[5]).toMatchObject({ type: 'added', oldLine: '', newLine: '8' });
    expect(lines[6]).toMatchObject({ type: 'context', oldLine: '9', newLine: '9' });
  });
  it('leaves an untracked preview as source text even if it resembles a diff', () => {
    const lines = parseDiffLines('--- title\n+++ heading\n@@ -1 +1 @@', 'text');
    expect(lines.every(line => line.type === 'context')).toBe(true);
    expect(lines.map(line => line.newLine)).toEqual(['1', '2', '3']);
  });
  it('resets hunk state at the next file header', () => {
    const lines = parseDiffLines('@@ -1 +1 @@\n+x\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -4 +5 @@\n+y', 'diff');
    expect(lines[3]?.type).toBe('meta'); expect(lines[4]?.type).toBe('meta'); expect(lines[6]?.newLine).toBe('5');
  });
  it('does not add a phantom source line for a final newline or an empty file', () => {
    expect(parseDiffLines('first\n', 'text').map(line => line.newLine)).toEqual(['1']);
    expect(parseDiffLines('first\n\n', 'text').map(line => line.newLine)).toEqual(['1', '2']);
    expect(parseDiffLines('', 'text')).toEqual([]);
    expect(parseDiffLines('\n', 'text')).toEqual([{ text: '', type: 'context', oldLine: '', newLine: '1' }]);
  });
  it('keeps EOF notes unnumbered without moving the following hunk line', () => {
    const lines = parseDiffLines('@@ -5 +8 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n', 'diff');
    expect(lines[2]).toEqual({ text: '\\ No newline at end of file', type: 'note', oldLine: '', newLine: '' });
    expect(lines[3]).toMatchObject({ type: 'added', newLine: '8' });
    expect(lines).toHaveLength(5);
  });
});
