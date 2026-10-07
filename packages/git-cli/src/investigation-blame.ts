import { fileSideSchema, type Blame, type FileSide, type RepositoryIdentity } from '@git-view/contracts';
import { decodePath, splitNul, utf8 } from './parse.js';
import { requireEntry } from './diff.js';
import { fullOid } from './immutable.js';
import { GitReadError } from './runner.js';
import type { ReadLimits } from './limits.js';
import type { ImmutableReader, createInvestigationHistory } from './investigation-history.js';

/** Git's quoted filenames are C byte strings, not JSON strings (octal UTF-8). */
function porcelainPath(value: string): string {
  if (!value.startsWith('"')) return decodePath(Buffer.from(value)).path;
  if (!value.endsWith('"')) throw new GitReadError('OBJECT_UNAVAILABLE', '行来源路径记录不完整。');
  const bytes: number[] = []; const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 1; i < value.length - 1; i++) {
    if (value[i] !== '\\') { const point = value.codePointAt(i)!; bytes.push(...Buffer.from(String.fromCodePoint(point))); if (point > 0xffff) i++; continue; }
    const octal = value.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
    if (octal) { bytes.push(parseInt(octal, 8)); i += octal.length; }
    else { const escape = escapes[value[++i]!]; if (escape === undefined) throw new GitReadError('OBJECT_UNAVAILABLE', '行来源路径记录不完整。'); bytes.push(escape); }
  }
  return decodePath(Buffer.from(bytes)).path;
}

export function createInvestigationBlame(reader: ImmutableReader, history: Pick<ReturnType<typeof createInvestigationHistory>, 'fileEntry'>, limits: ReadLimits) {
  return async (repo: RepositoryIdentity, snapshotId: string, entryId: string, inputSide: FileSide, signal?: AbortSignal): Promise<Blame> => {
    const side = fileSideSchema.parse(inputSide); const { snapshot, item } = history.fileEntry(repo, snapshotId, entryId);
    await reader.assertHistory(repo, snapshot, signal);
    const paths = requireEntry(item.change); const file = side === 'before' ? paths[0]! : paths.at(-1)!;
    const oid = side === 'before' ? item.base : item.commit.oid;
    if (!oid || (side === 'after' && item.change.kind.startsWith('D'))) throw new GitReadError('OBJECT_UNAVAILABLE', '此侧没有已提交的文件版本。');
    const entries = splitNul(await reader.run(repo, ['ls-tree', '-z', '--full-tree', oid, '--', file], { signal }));
    const selected = entries.find(entry => entry.subarray(entry.indexOf(9) + 1).equals(Buffer.from(file)));
    const [mode, type, blob] = selected?.subarray(0, selected.indexOf(9)).toString('ascii').split(' ') ?? [];
    if (!blob || type !== 'blob' || !['100644', '100755'].includes(mode!)) throw new GitReadError('UNSUPPORTED_PATH', '行来源仅支持已提交的普通文本文件。');
    const size = (await reader.run(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { signal, input: Buffer.from(`${blob}\n`) })).toString('ascii').trim().split(' ');
    if (size[1] !== 'blob') throw new GitReadError('OBJECT_UNAVAILABLE', '所需的 Git blob 对象不在本机，未使用工作文件代替，也未联网获取。');
    if (!Number.isSafeInteger(Number(size[2])) || Number(size[2]) > limits.previewBytes) throw new GitReadError('OUTPUT_LIMIT', '文件超过行来源读取上限，未返回不完整结果。');
    const content = await reader.run(repo, ['cat-file', 'blob', blob], { signal });
    let text: string;
    try { if (content.includes(0)) throw new Error('binary'); text = utf8.decode(content); } catch { throw new GitReadError('UNSUPPORTED_PATH', '行来源仅支持已提交的普通文本文件。'); }
    const storedLines = text ? text.split('\n') : []; if (text.endsWith('\n')) storedLines.pop();
    if (storedLines.length > limits.previewLines) throw new GitReadError('OUTPUT_LIMIT', '文件超过行来源读取上限，未返回不完整结果。');
    const bytes = storedLines.length ? await reader.run(repo, ['blame', '--line-porcelain', '--root', '--no-textconv', '--encoding=UTF-8', '--ignore-revs-file', '', oid, '--', file], { signal }) : Buffer.alloc(0);
    let porcelain: string;
    try { porcelain = utf8.decode(bytes); } catch { throw new GitReadError('OBJECT_UNAVAILABLE', '行来源元数据不是有效的 UTF-8。'); }
    const lines: Blame['lines'] = []; let current: Blame['lines'][number] | undefined;
    for (const record of porcelain.split('\n')) {
      const header = record.match(/^([a-f0-9]{40}|[a-f0-9]{64}) ([0-9]+) ([0-9]+)(?: [0-9]+)?$/);
      if (header) {
        if (current || /^0+$/.test(header[1]!)) throw new GitReadError('OBJECT_UNAVAILABLE', '行来源记录不完整，未推断作者。');
        current = { oid: header[1]!, originalLine: Number(header[2]), line: Number(header[3]), author: '', email: '', authoredAt: '', subject: '', path: '', text: '', boundary: false }; continue;
      }
      if (!current) { if (record) throw new GitReadError('OBJECT_UNAVAILABLE', '行来源记录不完整，未推断作者。'); continue; }
      if (record.startsWith('\t')) { current.text = record.slice(1); lines.push(current); current = undefined; }
      else if (record === 'boundary') current.boundary = true;
      else if (record.startsWith('author ')) current.author = record.slice(7);
      else if (record.startsWith('author-mail ')) current.email = record.slice(12).replace(/^<|>$/g, '');
      else if (record.startsWith('author-time ')) {
        const time = Number(record.slice(12)) * 1000;
        if (!Number.isFinite(time) || Number.isNaN(new Date(time).getTime())) throw new GitReadError('OBJECT_UNAVAILABLE', '行来源时间记录不完整。');
        current.authoredAt = new Date(time).toISOString();
      }
      else if (record.startsWith('summary ')) current.subject = record.slice(8);
      else if (record.startsWith('filename ')) current.path = porcelainPath(record.slice(9));
    }
    if (current || lines.length !== storedLines.length || lines.some((line, index) => !fullOid.test(line.oid) || line.line !== index + 1 || line.originalLine < 1 || line.text !== storedLines[index] || !line.path || !line.authoredAt)) throw new GitReadError('OBJECT_UNAVAILABLE', '行来源记录与选定文件不一致，未推断作者。');
    // %an/%ae expose the stored identity; a mutable working-tree .mailmap must
    // not silently change authors in this immutable file observation.
    const origins = [...new Set(lines.map(line => line.oid))];
    const authors = new Map<string, { author: string; email: string }>();
    for (let offset = 0; offset < origins.length; offset += limits.metadataBatchSize) {
      const facts = splitNul(await reader.run(repo, ['log', '-z', '--no-walk=unsorted', '--format=%H%x00%an%x00%ae', ...origins.slice(offset, offset + limits.metadataBatchSize), '--'], { signal }));
      if (facts.length % 3) throw new GitReadError('OBJECT_UNAVAILABLE', '行来源记录不完整，未推断作者。');
      for (let i = 0; i < facts.length; i += 3) authors.set(facts[i]!.toString('ascii'), { author: utf8.decode(facts[i + 1]!), email: utf8.decode(facts[i + 2]!) });
    }
    for (const line of lines) { const identity = authors.get(line.oid); if (!identity) throw new GitReadError('OBJECT_UNAVAILABLE', '行来源记录不完整，未推断作者。'); Object.assign(line, identity); }
    await reader.assertHistory(repo, snapshot, signal);
    return { snapshotId, entryId, side, oid, path: decodePath(Buffer.from(file)).path, lines, complete: snapshot.complete && !lines.some(line => line.boundary), warnings: [...(snapshot.complete ? [] : ['浅历史或调查上限限制了行来源的完整性。']), ...(lines.some(line => line.boundary) ? ['部分行位于历史边界，更早来源未覆盖。'] : [])] };
  };
}
