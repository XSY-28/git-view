import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { requestSchema, type RepositorySession } from '@git-view/contracts';
import { createLocalService } from './service';

const directories: string[] = [];
const services: Awaited<ReturnType<typeof createLocalService>>[] = [];
afterEach(async () => { services.splice(0).forEach(s => s.close()); await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'git-view-article-')); directories.push(root);
  const source = join(root, '资料'); await mkdir(source); const directory = join(root, 'private');
  const create = async () => {
    const service = await createLocalService({
      open: async () => { throw new Error('unused'); },
      execute: async () => { throw new Error('Article requests must not reach Git'); },
      getSession: (id: string): RepositorySession => ({ sessionId: id, generation: 0, repository: { repositoryId: id, worktreeId: id, worktreeRoot: root, gitDir: root, commonGitDir: root } }),
    }, directory); services.push(service); return service;
  };
  const call = (service: Awaited<ReturnType<typeof create>>, action: string, fields: Record<string, unknown> = {}, sessionId = 'repo-a') => service.request(requestSchema.parse({ schemaVersion: 1, requestId: crypto.randomUUID(), sessionId, action, ...fields }));
  return { root, source, create, call, service: await create() };
}

it('keeps an imported article and referenced image after source removal and service restart, isolated by repository', async () => {
  const f = await setup();
  await mkdir(join(f.source, 'images'));
  await writeFile(join(f.source, 'images/图.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>离线</text></svg>');
  const markdown = '# DSH 演化\n\n## 2026-06-17\n\n![关系图][diagram]\n\n[diagram]: images/图.svg\n\n```mermaid\nflowchart TD\nA-->B\n```';
  await writeFile(join(f.source, 'article.md'), markdown);
  const imported = await f.call(f.service, 'article-import', { sourcePath: join(f.source, 'article.md') });
  expect(imported).toMatchObject({ ok: true, data: { article: { markdown, title: 'DSH 演化', assets: { 'images/图.svg': expect.stringMatching(/^data:image\/svg\+xml;base64,/) } } } });
  await rm(f.source, { recursive: true });
  const fresh = await f.create();
  expect(await f.call(fresh, 'article')).toEqual(imported);
  expect(await f.call(fresh, 'article', {}, 'repo-b')).toMatchObject({ data: { article: null } });
});

it('offers a main-document choice and rejects ambiguous or invalid replacements without losing the previous article', async () => {
  const f = await setup();
  await writeFile(join(f.source, 'one.md'), '# Original');
  await writeFile(join(f.source, 'two.md'), '# Second');
  expect(await f.call(f.service, 'article-source', { sourcePath: f.source })).toMatchObject({ data: { files: ['one.md', 'two.md'] } });
  const first = await f.call(f.service, 'article-import', { sourcePath: f.source, mainFile: 'one.md' });
  await expect(f.call(f.service, 'article-import', { sourcePath: f.source })).rejects.toThrow();
  await expect(f.call(f.service, 'article-import', { sourcePath: f.source, mainFile: '../outside.md' })).rejects.toThrow();
  await writeFile(join(f.source, 'bad.md'), Buffer.from([0xff, 0xfe]));
  await expect(f.call(f.service, 'article-import', { sourcePath: join(f.source, 'bad.md') })).rejects.toThrow();
  await writeFile(join(f.source, 'large.md'), 'a'.repeat(600_000));
  await expect(f.call(f.service, 'article-import', { sourcePath: join(f.source, 'large.md') })).rejects.toThrow();
  expect(await f.call(f.service, 'article')).toEqual(first);
});

it('reports missing, external and escaping images without copying files outside the selected directory', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'outside.svg'), '<svg>private</svg>');
  if (process.platform !== 'win32') await symlink(join(f.root, 'outside.svg'), join(f.source, 'alias.svg'));
  await writeFile(join(f.source, 'a.md'), '# Safe\n![missing](missing.png)\n![escape](../outside.svg)\n![remote](https://example.invalid/x.png)\n![alias](alias.svg)');
  const result = await f.call(f.service, 'article-import', { sourcePath: join(f.source, 'a.md') });
  expect(result).toMatchObject({ data: { article: { assets: {}, warnings: expect.arrayContaining([expect.stringContaining('missing.png'), expect.stringContaining('../outside.svg'), expect.stringContaining('https://example.invalid/x.png'), expect.stringContaining('alias.svg')]) } } });
});
