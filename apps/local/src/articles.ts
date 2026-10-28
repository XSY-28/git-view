import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ARTICLE_LIMITS, articleSchema, QueryError, type Article, type ArticleSource } from '@git-view/contracts';
import { articleStructure } from '../../shared/article-markdown';
import { ensurePrivateDirectory, writePrivateJson } from './storage';

const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);
const within = (root: string, path: string) => { const part = relative(root, path); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
const invalid = (message: string) => new QueryError('INVALID_REQUEST', message);
async function boundedFile(path: string, limit: number) {
  if (!(await lstat(path)).isFile()) throw invalid('只支持普通文件。');
  const handle = await open(path, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw invalid('只支持普通文件。');
    const buffer = Buffer.alloc(limit + 1); let size = 0;
    while (size <= limit) { const result = await handle.read(buffer, size, buffer.length - size, null); if (!result.bytesRead) break; size += result.bytesRead; }
    if (size > limit) throw new QueryError('OUTPUT_LIMIT', '文章或图片超过大小限制。');
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}
export async function inspectArticleSource(sourcePath: string): Promise<ArticleSource> {
  if (!isAbsolute(sourcePath) || sourcePath.includes('\0')) throw invalid('请输入文章或资料文件夹的绝对路径。');
  const source = await realpath(sourcePath); const info = await lstat(source);
  if (info.isFile() && isMarkdown(source)) return { sourcePath: source, files: [basename(source)] };
  if (!info.isDirectory()) throw invalid('请选择 Markdown 文件或资料文件夹。');
  const files: string[] = []; let visited = 0;
  async function walk(directory: string, depth: number) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 2000) throw new QueryError('OUTPUT_LIMIT', '资料文件夹过大，请直接选择主 Markdown 文件。');
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;
      const path = join(directory, item.name);
      if (item.isFile() && isMarkdown(path)) files.push(relative(source, path).split(sep).join('/'));
      else if (item.isDirectory() && depth < 3) await walk(path, depth + 1);
    }
  }
  await walk(source, 0);
  if (!files.length) throw invalid('所选文件夹中没有 Markdown 文章。');
  return { sourcePath: source, files: files.sort() };
}
export class ArticleStore {
  constructor(private directory: string) {}
  private folder() { return join(this.directory, 'articles'); }
  private file(repositoryId: string) { return join(this.folder(), `${createHash('sha256').update(repositoryId).digest('hex')}.json`); }
  async read(repositoryId: string): Promise<Article | null> {
    try { return articleSchema.parse(JSON.parse((await boundedFile(this.file(repositoryId), ARTICLE_LIMITS.savedBytes)).toString('utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw invalid('已保存的文章无法读取，请重新导入。'); }
  }
  async import(repositoryId: string, sourcePath: string, mainFile?: string, signal?: AbortSignal): Promise<Article> {
    signal?.throwIfAborted();
    const source = await inspectArticleSource(sourcePath);
    const selected = mainFile ?? (source.files.length === 1 ? source.files[0] : undefined);
    if (!selected || !source.files.includes(selected)) throw invalid('请选择资料文件夹中的主 Markdown 文章。');
    const root = (await lstat(source.sourcePath)).isDirectory() ? source.sourcePath : dirname(source.sourcePath);
    const path = await realpath(resolve(root, selected));
    if (!within(root, path)) throw invalid('文章必须位于所选资料文件夹内。');
    const bytes = await boundedFile(path, ARTICLE_LIMITS.markdownBytes);
    let markdown: string;
    try { markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalid('文章必须使用 UTF-8 编码。'); }
    if (!markdown.trim()) throw invalid('文章内容为空。');
    const structure = articleStructure(markdown);
    if (structure.images.length > ARTICLE_LIMITS.images) throw new QueryError('OUTPUT_LIMIT', '文章引用的图片过多。');
    const assets: Record<string, string> = Object.create(null); const warnings: string[] = [];
    const mime: Record<string, string> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.gif': 'gif', '.webp': 'webp', '.svg': 'svg+xml' };
    let total = 0;
    for (const url of structure.images) {
      signal?.throwIfAborted();
      try {
        if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(url)) throw invalid('请将图片保存到资料文件夹并使用相对路径。');
        const local = decodeURIComponent(url.split(/[?#]/)[0]!);
        if (local.includes('\0') || local.includes('\\')) throw invalid('图片路径无效。');
        const unresolved = resolve(dirname(path), local);
        if (!within(root, unresolved)) throw invalid('图片超出所选资料文件夹。');
        if ((await lstat(unresolved)).isSymbolicLink()) throw invalid('图片不能是符号链接。');
        const imagePath = await realpath(unresolved);
        if (!within(root, imagePath)) throw invalid('图片超出所选资料文件夹。');
        const type = mime[extname(imagePath).toLowerCase()];
        if (!type) throw invalid('不支持此图片格式。');
        const image = await boundedFile(imagePath, ARTICLE_LIMITS.imageBytes);
        total += image.length;
        if (total > ARTICLE_LIMITS.totalImageBytes) throw new QueryError('OUTPUT_LIMIT', '文章配图总大小超过 6 MiB。');
        assets[url] = `data:image/${type};base64,${image.toString('base64')}`;
      } catch (error) {
        if (error instanceof QueryError && error.code === 'OUTPUT_LIMIT') throw error;
        warnings.push(`${url}：${error instanceof QueryError ? error.message : '图片无法读取。'}`);
      }
    }
    const article = articleSchema.parse({ id: randomUUID(), title: structure.headings.find(h => h.depth === 1)?.text || basename(path, extname(path)), markdown, importedAt: new Date().toISOString(), sourceName: basename(path), assets, warnings });
    signal?.throwIfAborted();
    await ensurePrivateDirectory(this.folder()); await writePrivateJson(this.file(repositoryId), article);
    return article;
  }
}
