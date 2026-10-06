import path from 'node:path';
import type { ChangeEntry, Diff, RepositoryIdentity } from '@git-view/contracts';
import { GitReadError, type RunOptions } from './runner.js';
import { splitNul, utf8 } from './parse.js';
import type { ReadLimits } from './limits.js';

export const diffFlags = ['--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=dirty', '--no-renames'];
export const rawFlags = ['--raw', '-z', '--no-abbrev', '--find-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty'];

export function createBlobVerifier(read: (repository: RepositoryIdentity, args: string[], options?: RunOptions) => Promise<Buffer>) {
  return async (repository: RepositoryIdentity, trees: string[], paths: string[], includeIndex: boolean, signal?: AbortSignal) => {
    const oids = new Set<string>();
    for (const tree of trees) {
      const records = splitNul(await read(repository, ['ls-tree', '-r', '-z', '--full-tree', tree, '--', ...paths], { signal }));
      for (const record of records) {
        const fields = record.subarray(0, record.indexOf(9)).toString('ascii').split(' ');
        if (fields[1] === 'blob') oids.add(fields[2]!);
      }
    }
    if (includeIndex) {
      const records = splitNul(await read(repository, ['ls-files', '--stage', '-z', '--', ...paths], { signal }));
      for (const record of records) {
        const fields = record.subarray(0, record.indexOf(9)).toString('ascii').split(' ');
        if (fields[0] !== '160000') oids.add(fields[1]!);
      }
    }
    if (!oids.size) return;
    // Git diff may reuse a matching work file even when its stored blob is missing.
    const checked = await read(repository, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { signal, input: Buffer.from(`${[...oids].join('\n')}\n`) });
    if (checked.toString('ascii').trim().split('\n').some(line => !line.endsWith(' blob'))) throw new GitReadError('OBJECT_UNAVAILABLE', '所需的 Git blob 对象不在本机，未使用工作文件代替，也未联网获取。');
  };
}

function rawName(encoded: string): string {
  let name: string;
  try { name = utf8.decode(Buffer.from(encoded, 'base64')); } catch { throw new GitReadError('UNSUPPORTED_PATH', '非 UTF-8 路径仅能查看转义名称，暂不能展开详情。'); }
  if (!name || name.includes('\0') || path.isAbsolute(name) || name.split('/').some((part) => part === '..' || part === '.')) throw new GitReadError('UNSUPPORTED_PATH', '文件路径无效。');
  return name;
}
export function requireEntry(entry: ChangeEntry): string[] {
  if (!entry.supported) throw new GitReadError('UNSUPPORTED_PATH', '非 UTF-8 路径仅能查看转义名称，暂不能展开详情。');
  return [...(entry.rawOldPath ? [rawName(entry.rawOldPath)] : []), rawName(entry.rawPath)];
}
export function renderPreview(entry: ChangeEntry, bytes: Buffer, base: string, target: string, limits: ReadLimits, format: 'diff' | 'text' = 'diff'): Diff {
  const unavailable = (reason: string): Diff => ({ entry, comparison: entry.comparison, text: '', format: 'unavailable', complete: false, reason, base, target });
  if (bytes.includes(0) || /(?:^|\n)Binary files .* differ(?:\n|$)/.test(bytes.toString('utf8'))) return unavailable('二进制内容不展开为文本。');
  if (bytes.length > limits.previewBytes) return unavailable(`文本预览超过 ${limits.previewBytes} 字节，未展开。`);
  let text: string;
  try { text = utf8.decode(bytes); } catch { return unavailable('内容不是有效的 UTF-8 文本，未展开。'); }
  if (text.split('\n').length > limits.previewLines) return unavailable(`文本预览超过 ${limits.previewLines} 行，未展开。`);
  const reason = /(?:^|\n)[+-]Subproject commit /.test(text) ? '仅展示 submodule 的 gitlink，没有展开嵌套仓库。'
    : /version https:\/\/git-lfs.github.com\/spec\/v1/.test(text) ? '仅展示已存储的 Git LFS 指针，没有下载实际对象。' : undefined;
  return { entry, comparison: entry.comparison, text, format, complete: true, ...(reason ? { reason } : {}), base, target };
}
