import { createHash } from 'node:crypto';
import type { ChangeEntry, Comparison, RawOverview } from '@git-view/contracts';
import { GitReadError } from './runner.js';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const utf8 = new TextDecoder('utf-8', { fatal: true });
export function splitNul(value: Buffer): Buffer[] {
  const result: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < value.length; i++) if (value[i] === 0) { result.push(value.subarray(start, i)); start = i + 1; }
  if (start < value.length) throw new GitReadError('INTERNAL_ERROR', 'Git 返回了不完整的路径记录。');
  return result;
}
export function decodePath(value: Buffer): { path: string; supported: boolean } {
  try {
    return { path: utf8.decode(value).replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`), supported: true };
  } catch {
    return { path: Array.from(value, (b) => b >= 32 && b < 127 && b !== 92 ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`).join(''), supported: false };
  }
}
/** rawPath is base64 of the exact bytes emitted by Git; display text is never used to address a file. */
export function entry(path: Buffer, kind: string, comparison: Comparison, oldPath?: Buffer): ChangeEntry {
  const rawPath = path.toString('base64');
  const display = decodePath(path);
  const oldDisplay = oldPath ? decodePath(oldPath) : undefined;
  return {
    id: hash(`${comparison}:${rawPath}:${oldPath?.toString('base64') ?? ''}`),
    ...display, rawPath, kind, comparison,
    ...(oldPath ? { oldPath: oldDisplay!.path, rawOldPath: oldPath.toString('base64'), supported: display.supported && oldDisplay!.supported } : {}),
  };
}
function fieldsBeforePath(record: Buffer, count: number): { fields: string[]; path: Buffer } {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const end = record.indexOf(32, start);
    if (end < 0) throw new GitReadError('INTERNAL_ERROR', 'Git 状态记录格式不完整。');
    fields.push(record.subarray(start, end).toString('ascii'));
    start = end + 1;
  }
  return { fields, path: record.subarray(start) };
}
export function parseStatus(value: Buffer): RawOverview['changes'] {
  const changes: RawOverview['changes'] = { staged: [], unstaged: [], untracked: [], conflicts: [] };
  const records = splitNul(value);
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const tag = record.subarray(0, 1).toString('ascii');
    if (tag === '#') continue;
    if (tag === '?') { changes.untracked.push(entry(record.subarray(2), '?', 'untracked-preview')); continue; }
    if (tag === '!') continue;
    if (tag === 'u') { changes.conflicts.push(entry(fieldsBeforePath(record, 10).path, 'U', 'index-worktree')); continue; }
    if (tag !== '1' && tag !== '2') throw new GitReadError('INTERNAL_ERROR', '无法识别 Git 状态记录。');
    const { fields, path } = fieldsBeforePath(record, tag === '1' ? 8 : 9);
    const xy = fields[1]!;
    const oldPath = tag === '2' ? records[++i] : undefined;
    if (tag === '2' && !oldPath) throw new GitReadError('INTERNAL_ERROR', 'Git 重命名记录不完整。');
    if (xy[0] !== '.') changes.staged.push(entry(path, xy[0]!, 'head-index', oldPath));
    if (xy[1] !== '.') changes.unstaged.push(entry(path, xy[1]!, 'index-worktree'));
  }
  return changes;
}

/** Parse --raw -z records, including the separate old/new fields used by renames. */
export function parseRawDiff(value: Buffer, comparison: Comparison): ChangeEntry[] {
  const records = splitNul(value);
  const result: ChangeEntry[] = [];
  for (let i = 0; i < records.length; i++) {
    const meta = records[i]!.toString('ascii');
    if (!meta.startsWith(':')) throw new GitReadError('INTERNAL_ERROR', 'Git 差异记录格式不完整。');
    const status = meta.split(' ').at(-1)!;
    const path = records[++i];
    if (!path) throw new GitReadError('INTERNAL_ERROR', 'Git 差异路径缺失。');
    if (status[0] === 'R' || status[0] === 'C') {
      const destination = records[++i];
      if (!destination) throw new GitReadError('INTERNAL_ERROR', 'Git 重命名目标缺失。');
      result.push(entry(destination, status[0], comparison, path));
    } else result.push(entry(path, status[0]!, comparison));
  }
  return result;
}
