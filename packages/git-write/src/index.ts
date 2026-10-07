import { constants } from 'node:fs';
import { lstat, open, readlink, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { QueryError, repositorySchema, type ChangeEntry, type RepositoryIdentity } from '@git-view/contracts';
import { createGitAdapter } from '../../git-cli/src/index.js';
import { runPlumbing } from './runner.js';
import { requireIndexWrites } from './platform.js';
import { openRead, replaceFile, syncDirectory } from './filesystem.js';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_SELECTED_BYTES = 128 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const fail = (message: string): never => { throw new QueryError('UNSUPPORTED_REPOSITORY', message); };
const stale = (): never => { throw new QueryError('STALE_RESULT', '仓库、所选文件或配置已变化，请重新预览后确认。'); };
const nul = (bytes: Buffer) => {
  try { return utf8.decode(bytes).split('\0').filter(Boolean); }
  catch { throw new QueryError('UNSUPPORTED_PATH', '仓库含非 UTF-8 路径或配置，暂不支持写入。'); }
};
const operations = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'sequencer'];
const falseValue = (value: string) => ['false', '0', 'no', 'off'].includes(value.toLowerCase());

export interface IndexEntry { path: string; mode: string; oid: string }
export interface FileSnapshot { path: string; kind: 'missing' | 'file' | 'symlink'; hash: string; mode: number; identity: string; size: number }
export interface PreparedIndexOperation {
  schemaVersion: 1;
  repository: RepositoryIdentity;
  kind: 'stage-files' | 'unstage-files';
  paths: string[];
  expectedFingerprint: string;
  guard: string;
  indexHash: string;
  files: FileSnapshot[];
  headOid: string | null;
  indexEntries: IndexEntry[];
  headEntries: IndexEntry[];
}
export const indexWriteEvidenceSchema = z.object({ schemaVersion: z.literal(1), repository: repositorySchema.strict(), expectedIndexHash: z.string().regex(/^[a-f0-9]{64}$/), guard: z.string().regex(/^[a-f0-9]{64}$/), paths: z.array(z.string().min(1)).min(1).max(2000) }).strict();
export type IndexWriteEvidence = z.infer<typeof indexWriteEvidenceSchema>;

export async function optional(file: string, limit = MAX_INDEX_BYTES): Promise<Buffer | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) fail('仓库元数据不是普通文件，暂不支持写入。');
    if (info.size > limit) throw new QueryError('OUTPUT_LIMIT', '仓库元数据超过安全上限。');
    const handle = await openRead(file);
    try {
      const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1));
      let total = 0;
      while (total < bytes.length) { const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total); if (!bytesRead) break; total += bytesRead; }
      if (total > info.size) stale();
      return bytes.subarray(0, total);
    } finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export function validPath(value: string): string {
  if (!value || value.includes('\0') || path.isAbsolute(value) || value.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new QueryError('UNSUPPORTED_PATH', '路径无法安全寻址，未执行暂存操作。');
  return value;
}
function entryPaths(entry: ChangeEntry): string[] {
  if (!entry.supported) throw new QueryError('UNSUPPORTED_PATH', '非 UTF-8 路径暂不支持写入。');
  // A rename moves both index paths. A copy's old path is only comparison
  // evidence: selecting its destination must not also unstage the source.
  try { return [...(entry.kind === 'R' && entry.rawOldPath ? [entry.rawOldPath] : []), entry.rawPath].map((raw) => validPath(utf8.decode(Buffer.from(raw, 'base64')))); }
  catch (error) { if (error instanceof QueryError) throw error; throw new QueryError('UNSUPPORTED_PATH', '路径不是有效的 UTF-8。'); }
}
async function safeParent(repository: RepositoryIdentity, name: string) {
  const parts = validPath(name).split('/');
  let current = repository.worktreeRoot;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try { const stat = await lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new QueryError('UNSUPPORTED_PATH', '父路径不是普通目录，未读取链接目标。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
}
async function fileSnapshot(repository: RepositoryIdentity, name: string): Promise<{ snapshot: FileSnapshot; bytes?: Buffer }> {
  await safeParent(repository, name);
  const full = path.join(repository.worktreeRoot, name);
  try {
    const before = await lstat(full, { bigint: true });
    const identity = [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(':');
    let bytes: Buffer, kind: 'file' | 'symlink';
    if (before.isSymbolicLink()) { bytes = await readlink(full, { encoding: 'buffer' }); kind = 'symlink'; }
    else if (before.isFile()) {
      if (before.size > BigInt(MAX_FILE_BYTES)) throw new QueryError('OUTPUT_LIMIT', '单个暂存文件超过 64 MiB，暂不支持。');
      const handle = await openRead(full);
      try {
        const opened = await handle.stat({ bigint: true });
        if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) stale();
        const chunks: Buffer[] = []; let total = 0;
        while (true) { const chunk = Buffer.alloc(Math.min(1024 * 1024, MAX_FILE_BYTES + 1 - total)); const { bytesRead } = await handle.read(chunk, 0, chunk.length, total); if (!bytesRead) break; chunks.push(chunk.subarray(0, bytesRead)); total += bytesRead; if (total > MAX_FILE_BYTES) throw new QueryError('OUTPUT_LIMIT', '单个暂存文件超过 64 MiB，暂不支持。'); }
        bytes = Buffer.concat(chunks); kind = 'file';
      } finally { await handle.close(); }
    } else throw new QueryError('UNSUPPORTED_PATH', '仅支持普通文件、符号链接本身及删除的文件；目录和 submodule 暂不支持。');
    const after = await lstat(full, { bigint: true });
    if ([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(':') !== identity) stale();
    await safeParent(repository, name);
    return { snapshot: { path: name, kind, hash: digest(bytes), mode: Number(before.mode), identity, size: bytes.length }, bytes };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { snapshot: { path: name, kind: 'missing', hash: digest(''), mode: 0, identity: 'missing', size: 0 } }; throw error; }
}
function inspectIndex(bytes: Buffer | null, oidBytes: number) {
  if (!bytes) return;
  if (bytes.subarray(0, 4).toString() !== 'DIRC' || ![2, 3].includes(bytes.readUInt32BE(4))) fail('首批写入只支持常规 v2/v3 index，尚不支持此 index 格式。');
  let cursor = 12;
  for (let i = 0; i < bytes.readUInt32BE(8); i++) {
    const start = cursor;
    if (cursor + 42 + oidBytes > bytes.length) fail('index 内容不完整。');
    const flags = bytes.readUInt16BE(cursor + 40 + oidBytes);
    if (flags & 0x8000) fail('暂不支持带 assume-unchanged 标志的 index。');
    cursor += 42 + oidBytes;
    if (flags & 0x4000) { if (bytes.readUInt16BE(cursor) !== 0) fail('暂不支持 intent-to-add、skip-worktree 或稀疏 index。'); cursor += 2; }
    const end = bytes.indexOf(0, cursor);
    if (end < 0) fail('index 路径不完整。');
    cursor = start + Math.ceil((end + 1 - start) / 8) * 8;
  }
  while (cursor + 8 <= bytes.length - oidBytes) {
    const signature = bytes.subarray(cursor, cursor + 4).toString('ascii');
    if (signature === 'link' || signature === 'sdir' || /^[a-z]/.test(signature)) fail('暂不支持 split index、稀疏 index 或未知必要扩展。');
    cursor += 8 + bytes.readUInt32BE(cursor + 4);
  }
  if (cursor !== bytes.length - oidBytes) fail('index 扩展内容不完整。');
}
export function parseEntries(value: Buffer, tree = false): IndexEntry[] {
  return nul(value).map((record) => {
    const tab = record.indexOf('\t'), header = record.slice(0, tab).split(' '), name = record.slice(tab + 1);
    if (tab < 0 || (tree ? header[1] !== 'blob' : header[2] !== '0')) fail('暂不支持冲突、目录项或 submodule index。');
    if (!['100644', '100755', '120000'].includes(header[0]!)) fail('暂不支持 submodule 或特殊文件模式。');
    validPath(name);
    return { path: name, mode: header[0]!, oid: header[tree ? 2 : 1]! };
  });
}
async function configGuard(repository: RepositoryIdentity, signal?: AbortSignal) {
  const raw = await runPlumbing(repository, ['config', '--null', '--list', '--show-origin', '--includes'], { signal });
  const records = nul(raw), values = new Map<string, string>(), origins = new Set<string>();
  for (let i = 0; i < records.length; i += 2) {
    const origin = records[i]!, record = records[i + 1] ?? '', split = record.indexOf('\n');
    values.set(split < 0 ? record : record.slice(0, split), split < 0 ? '' : record.slice(split + 1));
    if (origin.startsWith('file:')) origins.add(path.resolve(repository.worktreeRoot, origin.slice(5)));
  }
  for (const [key, value] of values) {
    if (/^(extensions\.partialclone|remote\..*\.promisor|core\.sparsecheckout|core\.sparsecheckoutcone|index\.sparse)$/.test(key) && !falseValue(value)) fail('暂不支持 partial clone 或稀疏检出写入。');
  }
  const originHashes: string[] = [];
  for (const file of [...origins].sort()) originHashes.push(`${file}:${digest(await optional(file) ?? 'missing')}`);
  const filters = new Set([...values].filter(([key, value]) => /^filter\..*\.(clean|smudge|process)$/.test(key) && value.trim()).map(([key]) => key.slice(7, key.lastIndexOf('.'))));
  return { hash: digest(Buffer.concat([raw, Buffer.from(JSON.stringify(originHashes))])), values, filters };
}
export async function readWriteState(repository: RepositoryIdentity, paths: string[], kind: PreparedIndexOperation['kind'], signal?: AbortSignal) {
  const resolved = await createGitAdapter().resolveRepository(repository.worktreeRoot, signal);
  if (JSON.stringify(resolved) !== JSON.stringify(repository)) stale();
  const identities: string[] = [];
  for (const directory of [repository.worktreeRoot, repository.gitDir, repository.commonGitDir]) { const info = await lstat(directory, { bigint: true }); identities.push(`${directory}:${info.dev}:${info.ino}`); }
  for (const operation of operations) { try { await lstat(path.join(repository.gitDir, operation)); fail('合并、变基、挑选等进行中的操作必须先结束，暂不修改 index。'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  const config = await configGuard(repository, signal);
  const headOid = (await runPlumbing(repository, ['rev-parse', '--verify', '--quiet', 'HEAD'], { signal, allowMissing: true })).toString('ascii').trim() || null;
  const head = await optional(path.join(repository.gitDir, 'HEAD'));
  const objectFormat = (await runPlumbing(repository, ['rev-parse', '--show-object-format'], { signal })).toString('ascii').trim();
  const index = await optional(path.join(repository.gitDir, 'index'));
  inspectIndex(index, objectFormat === 'sha256' ? 32 : 20);
  const indexEntries = parseEntries(await runPlumbing(repository, ['ls-files', '--stage', '-z'], { signal }));
  const headEntries = headOid ? parseEntries(await runPlumbing(repository, ['ls-tree', '-r', '-z', '--full-tree', headOid], { signal }), true) : [];
  if (falseValue(config.values.get('core.symlinks') ?? 'true') && [...indexEntries, ...headEntries].some(entry => entry.mode === '120000')) fail('core.symlinks=false 的仓库含符号链接条目，暂不支持写入。');
  const attrs: string[] = [];
  const normalization = new Map<string, { text: string; eol: string }>();
  const allFiles = await runPlumbing(repository, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { signal });
  for (const cached of [false, true]) {
    if (allFiles.length && config.filters.size) {
      const globalAttrs = nul(await runPlumbing(repository, ['check-attr', '-z', ...(cached ? ['--cached'] : []), '--stdin', 'filter'], { signal, input: allFiles }));
      for (let i = 2; i < globalAttrs.length; i += 3) if (config.filters.has(globalAttrs[i]!)) throw new QueryError('UNSUPPORTED_FILTER', '仓库路径使用外部 clean/smudge/process 过滤器；首批暂存操作不执行外部程序。');
    }
    if (!paths.length) continue;
    const result = await runPlumbing(repository, ['check-attr', '-z', ...(cached ? ['--cached'] : []), '--stdin', 'filter', 'text', 'eol', 'ident', 'working-tree-encoding'], { signal, input: Buffer.from(`${paths.join('\0')}\0`) });
    attrs.push(result.toString('base64'));
    const triples = nul(result);
    if (triples.length % 3) fail('无法可靠读取文件属性。');
    for (let i = 0; i < triples.length; i += 3) {
      const attribute = triples[i + 1], value = triples[i + 2];
      if (!cached && (attribute === 'text' || attribute === 'eol')) {
        const settings = normalization.get(triples[i]!) ?? { text: 'unspecified', eol: 'unspecified' };
        settings[attribute] = value!; normalization.set(triples[i]!, settings);
      }
      if (!['unspecified', 'unset'].includes(value!) && (attribute === 'filter' || (kind === 'stage-files' && !['text', 'eol'].includes(attribute!)))) throw new QueryError('UNSUPPORTED_FILTER', `首批整文件暂存不支持 ${attribute}=${value} 内容转换；请使用 Git 完成此类暂存。`);
    }
  }
  const identityGuard = { identities, config: config.hash, head: head?.toString('base64'), headOid };
  const guard = digest(JSON.stringify({ ...identityGuard, attrs }));
  // A receipt verifies the resulting index, HEAD and identity. Working-tree attribute
  // edits may legitimately change cached attributes as part of the installed index.
  const evidenceGuard = digest(JSON.stringify(identityGuard));
  return { guard, evidenceGuard, indexHash: digest(index ?? 'missing'), index, indexEntries, headEntries, headOid, normalization, conversionConfig: { autocrlf: config.values.get('core.autocrlf') ?? 'false', safecrlf: config.values.get('core.safecrlf') ?? 'false', eol: config.values.get('core.eol') ?? 'native' }, symlinks: !falseValue(config.values.get('core.symlinks') ?? 'true'), filemode: !falseValue(config.values.get('core.filemode') ?? 'true') };
}
function same(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right); }

export function createGitWriteAdapter() {
  const reader = createGitAdapter();
  return {
    async prepare(repository: RepositoryIdentity, kind: PreparedIndexOperation['kind'], entries: ChangeEntry[], expectedFingerprint: string, signal?: AbortSignal): Promise<PreparedIndexOperation> {
      requireIndexWrites();
      if (!['stage-files', 'unstage-files'].includes(kind) || !entries.length || entries.length > 1000) throw new QueryError('INVALID_REQUEST', '请选择 1 至 1000 个文件。');
      const paths = [...new Set(entries.flatMap(entryPaths))].sort();
      // Reject filters before status can inspect content; prepare remains entirely read-only.
      const before = await readWriteState(repository, paths, kind, signal);
      const overview = await reader.readOverview(repository, signal);
      if (overview.fingerprint !== expectedFingerprint) stale();
      if (!overview.complete || overview.operation.length || overview.changes.conflicts.length) fail('不完整概览、冲突或进行中的 Git 操作不支持暂存写入。');
      const choices = kind === 'stage-files' ? [...overview.changes.unstaged, ...overview.changes.untracked] : overview.changes.staged;
      for (const entry of entries) { const current = choices.find((item) => item.id === entry.id); if (!current || !same(current, entry)) stale(); }
      const files: FileSnapshot[] = [];
      let selectedBytes = 0;
      for (const name of paths) {
        const { snapshot } = await fileSnapshot(repository, name);
        selectedBytes += snapshot.size;
        if (selectedBytes > MAX_SELECTED_BYTES) throw new QueryError('OUTPUT_LIMIT', '所选文件总大小超过 128 MiB，请分批暂存。');
        if (snapshot.kind === 'symlink' && (process.platform === 'win32' || !before.symlinks)) fail('core.symlinks=false 时不暂存符号链接。');
        files.push(snapshot);
      }
      const after = await readWriteState(repository, paths, kind, signal);
      if (before.guard !== after.guard || before.indexHash !== after.indexHash || (await reader.readOverview(repository, signal)).fingerprint !== expectedFingerprint) stale();
      return { schemaVersion: 1, repository, kind, paths, expectedFingerprint, guard: after.guard, indexHash: after.indexHash, files, headOid: after.headOid, indexEntries: after.indexEntries, headEntries: after.headEntries };
    },
    async execute(prepared: PreparedIndexOperation, beforeInstall: (evidence: IndexWriteEvidence) => Promise<void>): Promise<void> {
      requireIndexWrites();
      const { repository, paths, kind } = prepared;
      paths.forEach(validPath);
      const lockPath = path.join(repository.gitDir, 'index.lock');
      let lock;
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new QueryError('REPOSITORY_BUSY', 'index.lock 已存在；未触碰其他 Git 操作的锁。'); throw error; }
      const owned = await lock.stat({ bigint: true });
      let temporary: string | undefined, installed = false;
      const assertLock = async () => { const current = await lstat(lockPath, { bigint: true }); if (!current.isFile() || current.dev !== owned.dev || current.ino !== owned.ino) throw new QueryError('REPOSITORY_BUSY', 'index 锁的所有权已变化，未安装结果。'); };
      const validate = async (includeBytes = false) => {
        await assertLock();
        const state = await readWriteState(repository, paths, kind);
        if (state.guard !== prepared.guard || state.indexHash !== prepared.indexHash || !same(state.indexEntries, prepared.indexEntries) || !same(state.headEntries, prepared.headEntries) || state.headOid !== prepared.headOid) stale();
        const files: { snapshot: FileSnapshot; bytes?: Buffer }[] = [];
        let selectedBytes = 0;
        for (const name of paths) {
          const file = await fileSnapshot(repository, name);
          selectedBytes += file.snapshot.size;
          if (selectedBytes > MAX_SELECTED_BYTES) throw new QueryError('OUTPUT_LIMIT', '所选文件总大小超过 128 MiB，请分批暂存。');
          files.push(includeBytes ? file : { snapshot: file.snapshot });
        }
        if (!same(files.map((file) => file.snapshot), prepared.files)) stale();
        return { state, files };
      };
      try {
        const { state, files } = await validate(true);
        temporary = await mkdtemp(path.join(tmpdir(), 'git-view-index-'));
        const alternate = path.join(temporary, 'index');
        const canonicalDir = path.join(temporary, 'canonical');
        const canonicalWork = path.join(temporary, 'worktree');
        await mkdir(canonicalWork);
        await mkdir(path.join(canonicalDir, 'info'), { recursive: true });
        await mkdir(path.join(canonicalDir, 'objects'), { recursive: true });
        await mkdir(path.join(canonicalDir, 'refs'));
        await writeFile(path.join(canonicalDir, 'HEAD'), 'ref: refs/heads/main\n');
        if (state.index) {
          await writeFile(alternate, state.index, { mode: 0o600 });
          await writeFile(path.join(canonicalDir, 'index'), state.index, { mode: 0o600 });
        }
        const oidLength = state.headOid?.length ?? state.indexEntries[0]?.oid.length ?? ((await runPlumbing(repository, ['rev-parse', '--show-object-format'])).toString().trim() === 'sha256' ? 64 : 40);
        const zero = '0'.repeat(oidLength);
        const updates: string[] = [];
        for (let i = 0; i < paths.length; i++) {
          const name = paths[i]!, file = files[i]!;
          if (kind === 'unstage-files') {
            const head = state.headEntries.find((entry) => entry.path === name);
            updates.push(head ? `${head.mode} ${head.oid}\t${name}\0` : `0 ${zero}\t${name}\0`);
          } else if (file.snapshot.kind === 'missing') updates.push(`0 ${zero}\t${name}\0`);
          else {
            // Only built-in conversion is allowed. Use captured attributes/config in
            // isolated Git metadata: concurrent .gitattributes or info/attributes
            // edits in the real repository can never launch a clean/process filter.
            const settings = state.normalization.get(name) ?? { text: 'unspecified', eol: 'unspecified' };
            if (!['unspecified', 'unset', 'set', 'auto'].includes(settings.text) || !['unspecified', 'unset', 'lf', 'crlf'].includes(settings.eol)) fail('不支持此换行属性值。');
            const conversion = state.conversionConfig;
            if (!['false', 'true', 'input', '0', '1', 'yes', 'no', 'on', 'off'].includes(conversion.autocrlf.toLowerCase()) || !['false', 'true', 'warn', '0', '1', 'yes', 'no', 'on', 'off'].includes(conversion.safecrlf.toLowerCase()) || !['native', 'lf', 'crlf'].includes(conversion.eol.toLowerCase())) fail('不支持此换行配置值。');
            const objectFormat = oidLength === 64 ? 'sha256' : 'sha1';
            await writeFile(path.join(canonicalDir, 'config'), `[core]\nrepositoryformatversion = ${objectFormat === 'sha256' ? 1 : 0}\nbare = false\nautocrlf = ${conversion.autocrlf}\nsafecrlf = ${conversion.safecrlf}\neol = ${conversion.eol}\n${objectFormat === 'sha256' ? '[extensions]\nobjectformat = sha256\n' : ''}`);
            await writeFile(path.join(canonicalDir, 'info', 'attributes'), `* ${settings.text === 'unset' ? '-text' : settings.text === 'set' ? 'text' : settings.text === 'auto' ? 'text=auto' : '!text'} ${['lf', 'crlf'].includes(settings.eol) ? `eol=${settings.eol}` : '!eol'} !filter !ident !working-tree-encoding\n`);
            let oid: string;
            if (file.snapshot.kind === 'symlink') oid = (await runPlumbing(repository, ['hash-object', '-w', '--stdin', '--no-filters'], { input: file.bytes })).toString('ascii').trim();
            else {
              // Ordinary Git add consults the original index before autocrlf/text=auto
              // conversion (e.g. legacy CRLF blobs). Keep that behavior in isolation.
              const selectedFile = path.join(canonicalWork, name);
              await mkdir(path.dirname(selectedFile), { recursive: true });
              await writeFile(selectedFile, file.bytes!);
              const normalization = { gitDir: canonicalDir, worktree: canonicalWork };
              await runPlumbing(repository, ['add', '--force', '--', name], { normalization });
              const entry = parseEntries(await runPlumbing(repository, ['ls-files', '--stage', '-z', '--', name], { normalization })).find(entry => entry.path === name);
              if (!entry) throw new QueryError('INTERNAL_ERROR', '隔离转换未生成所选文件。');
              oid = entry.oid;
            }
            const prior = state.indexEntries.find((entry) => entry.path === name);
            const mode = file.snapshot.kind === 'symlink' ? '120000' : !state.filemode ? (prior?.mode.startsWith('100') ? prior.mode : '100644') : file.snapshot.mode & 0o100 ? '100755' : '100644';
            updates.push(`${mode} ${oid}\t${name}\0`);
          }
        }
        await runPlumbing(repository, ['update-index', '--add', '--remove', '-z', '--index-info'], { index: alternate, input: Buffer.from(updates.join('')) });
        const resulting = parseEntries(await runPlumbing(repository, ['ls-files', '--stage', '-z'], { index: alternate }));
        const selected = new Set(paths);
        if (!same(resulting.filter((entry) => !selected.has(entry.path)), state.indexEntries.filter((entry) => !selected.has(entry.path)))) throw new QueryError('INTERNAL_ERROR', '未选文件的 index 发生变化，已放弃安装。');
        const bytes = await optional(alternate);
        if (!bytes) throw new QueryError('INTERNAL_ERROR', '暂存结果 index 缺失。');
        await validate();
        const evidence: IndexWriteEvidence = { schemaVersion: 1, repository, expectedIndexHash: digest(bytes), guard: state.evidenceGuard, paths };
        await beforeInstall(evidence);
        await validate();
        await lock.writeFile(bytes);
        await lock.sync();
        await validate();
        await assertLock();
        await replaceFile(lockPath, path.join(repository.gitDir, 'index'));
        installed = true;
        await syncDirectory(repository.gitDir);
      } finally {
        await lock.close();
        if (!installed) { try { const current = await lstat(lockPath, { bigint: true }); if (current.dev === owned.dev && current.ino === owned.ino) await rm(lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
        if (temporary) await rm(temporary, { recursive: true, force: true });
      }
    },
    async verify(repository: RepositoryIdentity, evidence: IndexWriteEvidence): Promise<boolean> {
      requireIndexWrites();
      try {
        const parsed = indexWriteEvidenceSchema.parse(evidence);
        if (!same(repository, parsed.repository)) return false;
        try { await lstat(path.join(repository.gitDir, 'index.lock')); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
        const state = await readWriteState(repository, parsed.paths, 'unstage-files');
        return state.evidenceGuard === parsed.guard && state.indexHash === parsed.expectedIndexHash;
      } catch { return false; }
    },
  };
}
