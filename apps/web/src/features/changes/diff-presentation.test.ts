import { describe, expect, it } from 'vitest';
import type { Diff } from '@git-view/contracts';
import { comparisonObjects, objectLabel, presentDiff } from './diff-presentation';

const patch = (text: string, overrides: Partial<Diff> = {}): Diff => ({
  entry: { id: 'a', path: 'new file.txt', rawPath: 'bmV3IGZpbGUudHh0', kind: 'M', comparison: 'index-worktree', supported: true },
  comparison: 'index-worktree', text, format: 'diff', complete: true, base: 'index', target: 'worktree', ...overrides,
});

describe('patch presentation', () => {
  it('removes only redundant framing while preserving hunks, actual source and EOF notes', () => {
    const text = 'diff --git a/new file.txt b/new file.txt\nindex 1111111..2222222 100644\n--- a/new file.txt\n+++ b/new file.txt\n@@ -7 +9 @@\n---old\n+++new\n\\ No newline at end of file\n';
    const diff = patch(text);
    const result = presentDiff(diff);
    expect(result.lines.map(line => line.text)).toEqual(['@@ -7 +9 @@', '---old', '+++new', '\\ No newline at end of file']);
    expect(result.lines[1]).toMatchObject({ oldLine: '7', type: 'removed' });
    expect(result.lines[2]).toMatchObject({ newLine: '9', type: 'added' });
    expect(result.lines[3]?.type).toBe('note');
    expect(result.additions).toBe(1); expect(result.deletions).toBe(1);
    expect(diff.text).toBe(text);
  });
  it('keeps a mode-only change visible without manufacturing changed source lines', () => {
    const result = presentDiff(patch('diff --git a/run b/run\nold mode 100644\nnew mode 100755\n'));
    expect(result.metadata).toEqual([{ label: '文件模式', value: '100644 → 100755' }]);
    expect(result.lines).toEqual([]); expect(result.additions + result.deletions).toBe(0);
  });
  it('presents pure rename paths from the decoded entry rather than splitting on spaces or Git quoting', () => {
    const entry = { ...patch('').entry, path: '新 目录/new name.txt', oldPath: '旧 目录/old name.txt', kind: 'R100' };
    const result = presentDiff(patch('diff --git "a/old path" "b/new path"\nsimilarity index 100%\nrename from "old path"\nrename to "new path"\n', { entry }));
    expect(result.metadata).toContainEqual({ label: '重命名', value: '旧 目录/old name.txt → 新 目录/new name.txt' });
    expect(result.metadata).toContainEqual({ label: '相似度', value: '100%' });
    expect(result.metadata.filter(item => item.label === '重命名')).toHaveLength(1);
    expect(result.lines).toEqual([]);
  });
  it('retains confirmed path changes when binary contents are unavailable or patch metadata is truncated', () => {
    for (const [kind, label] of [['R', '重命名'], ['C', '复制']] as const) {
      const entry = { ...patch('').entry, path: 'new binary.dat', oldPath: 'old binary.dat', kind };
      const unavailable = presentDiff(patch('', { entry, format: 'unavailable', complete: false }));
      expect(unavailable.metadata).toEqual([{ label, value: 'old binary.dat → new binary.dat' }]);
      const partial = presentDiff(patch(`${kind === 'R' ? 'rename' : 'copy'} from old binary.dat\n`, { entry, complete: false }));
      expect(partial.metadata).toEqual(unavailable.metadata);
    }
  });
  it('keeps file creation, deletion and copy metadata visible', () => {
    expect(presentDiff(patch('new file mode 100644\n')).metadata).toEqual([{ label: '新增文件', value: '模式 100644' }]);
    expect(presentDiff(patch('deleted file mode 120000\n')).metadata).toEqual([{ label: '删除文件', value: '模式 120000' }]);
    expect(presentDiff(patch('copy from source name.txt\ncopy to new file.txt\n')).metadata).toEqual([{ label: '复制', value: 'source name.txt → new file.txt' }]);
  });
  it('preserves partial and unrecognized metadata instead of silently discarding facts', () => {
    const result = presentDiff(patch('old mode 100644\nrename from source name.txt\ncustom extension header\n', { complete: false }));
    expect(result.metadata).toEqual([{ label: '原文件模式', value: '100644' }, { label: '原路径', value: 'source name.txt' }]);
    expect(result.lines[0]?.text).toBe('custom extension header');
  });
  it('does not interpret patch-like text in an untracked file', () => {
    const text = 'diff --git a/file b/file\n--- old\n+++ new\n@@ -1 +1 @@\nold mode 100644\n\\ No newline at end of file\n';
    const result = presentDiff(patch(text, { format: 'text', comparison: 'untracked-preview' }));
    expect(result.metadata).toEqual([]); expect(result.lines.map(line => line.newLine)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(result.lines.every(line => line.type === 'context')).toBe(true);
    expect(result.lines.map(line => line.text).join('\n')).toBe(text.slice(0, -1));
  });
});

describe('comparison operand labels', () => {
  it('distinguishes working tree, staged contents and the selected commit', () => {
    expect(comparisonObjects(patch(''))).toEqual({ before: { label: '暂存区', value: 'index' }, after: { label: '工作区', value: 'worktree' } });
    expect(comparisonObjects(patch('', { comparison: 'head-index', base: 'a'.repeat(40), target: 'index' })).before?.label).toBe('HEAD');
    const commit = comparisonObjects(patch('', { comparison: 'commit-parent', base: 'a'.repeat(40), target: 'b'.repeat(40) }));
    expect(objectLabel(commit.before!)).toBe('父提交 aaaaaaaaaa'); expect(objectLabel(commit.after)).toBe('所选提交 bbbbbbbbbb');
  });
  it('labels the empty tree for initial commits, unborn staged comparisons and untracked stash snapshots', () => {
    for (const comparison of ['commit-parent', 'head-index', 'revision-pair'] as const) {
      const objects = comparisonObjects(patch('', { comparison, base: '空树（首次提交）' }));
      expect(objects.before?.label).toBe('空树'); expect(objectLabel(objects.before!)).toBe('空树');
    }
  });
  it('does not invent a comparison source for an untracked preview', () => {
    expect(comparisonObjects(patch('', { comparison: 'untracked-preview', format: 'text' }))).toEqual({ after: { label: '工作区 · 未跟踪文件', value: 'worktree' } });
  });
});
