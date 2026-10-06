import type { Diff } from '@git-view/contracts';
import { parseDiffLines, type DiffLine } from './diff-lines';

export interface DiffObject { label: string; value: string }
export interface PatchMetadata { label: string; value: string }

/** Labels describe the actual operands; an initial commit has no parent commit. */
export function comparisonObjects(diff: Diff): { before?: DiffObject; after: DiffObject } {
  const emptyTree = diff.base.startsWith('空树');
  switch (diff.comparison) {
    case 'head-index': return { before: { label: emptyTree ? '空树' : 'HEAD', value: diff.base }, after: { label: '暂存区', value: diff.target } };
    case 'index-worktree': return { before: { label: '暂存区', value: diff.base }, after: { label: '工作区', value: diff.target } };
    case 'commit-parent': return { before: { label: emptyTree ? '空树' : '父提交', value: diff.base }, after: { label: '所选提交', value: diff.target } };
    case 'untracked-preview': return { after: { label: '工作区 · 未跟踪文件', value: diff.target } };
  }
}

export function objectLabel(object: DiffObject): string {
  return /^[0-9a-f]{20,}$/i.test(object.value) ? `${object.label} ${object.value.slice(0, 10)}` : object.label;
}

/** Strip only redundant patch framing. Semantic metadata stays visible, unknown metadata stays verbatim. */
export function presentDiff(diff: Diff): { lines: DiffLine[]; metadata: PatchMetadata[]; additions: number; deletions: number } {
  const parsed = parseDiffLines(diff.text, diff.format);
  const lines: DiffLine[] = [];
  const metadata: PatchMetadata[] = [];
  let oldMode: string | undefined;
  let pathChange: { kind: 'rename' | 'copy'; from: string } | undefined;
  let pathRecorded = false;
  // The change entry remains authoritative even when binary/limited content has no patch.
  if (diff.entry.oldPath) {
    const kind = diff.entry.kind[0];
    metadata.push({ label: kind === 'R' ? '重命名' : kind === 'C' ? '复制' : '原路径', value: kind === 'R' || kind === 'C' ? `${diff.entry.oldPath} → ${diff.entry.path}` : diff.entry.oldPath });
    pathRecorded = true;
  }
  for (const line of parsed) {
    if (diff.format !== 'diff' || line.type !== 'meta') { lines.push(line); continue; }
    const value = line.text;
    if (/^(diff --git |index |--- |\+\+\+ )/.test(value)) continue;
    let match: RegExpExecArray | null;
    if ((match = /^old mode (\d+)$/.exec(value))) { oldMode = match[1]; continue; }
    if ((match = /^new mode (\d+)$/.exec(value))) { metadata.push({ label: '文件模式', value: oldMode ? `${oldMode} → ${match[1]}` : match[1]! }); oldMode = undefined; continue; }
    if ((match = /^(new|deleted) file mode (\d+)$/.exec(value))) { metadata.push({ label: match[1] === 'new' ? '新增文件' : '删除文件', value: `模式 ${match[2]}` }); continue; }
    if ((match = /^(rename|copy) from (.*)$/.exec(value))) { pathChange = { kind: match[1] as 'rename' | 'copy', from: match[2]! }; continue; }
    if ((match = /^(rename|copy) to (.*)$/.exec(value))) {
      const from = diff.entry.oldPath ?? (pathChange?.kind === match[1] ? pathChange.from : undefined);
      if (!pathRecorded) metadata.push({ label: match[1] === 'rename' ? '重命名' : '复制', value: from ? `${from} → ${diff.entry.path}` : diff.entry.path });
      pathRecorded = true;
      pathChange = undefined; continue;
    }
    if ((match = /^(similarity|dissimilarity) index (\d+%)$/.exec(value))) { metadata.push({ label: match[1] === 'similarity' ? '相似度' : '差异度', value: match[2]! }); continue; }
    lines.push(line);
  }
  // Keep incomplete metadata visible when only part of the patch was obtained.
  if (oldMode) metadata.push({ label: '原文件模式', value: oldMode });
  if (pathChange && !pathRecorded) metadata.push({ label: pathChange.kind === 'rename' ? '原路径' : '复制来源', value: pathChange.from });
  return { lines, metadata, additions: parsed.filter(line => line.type === 'added').length, deletions: parsed.filter(line => line.type === 'removed').length };
}
