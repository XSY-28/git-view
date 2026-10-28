import { test, expect } from './fixtures';
import { resolve, join } from 'node:path';
import { rm } from 'node:fs/promises';
import { createGitAdapter } from '../../packages/git-cli/src/index';
import { createRepositoryQueries } from '../../packages/core/src/index';
import { startLocalServer } from '../../apps/local/src/server';
import { cleanupFixtures, commit, repository, temporaryDirectory, write, fingerprint } from '../fixtures/git';

let server: Awaited<ReturnType<typeof startLocalServer>>; let root: string; let other: string; let source: string;
async function call(fields: Record<string, unknown>) {
  const response = await fetch(`${server.origin}/api`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${server.record.cliToken}` }, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...fields }) });
  const result = await response.json(); if (!result.ok) throw new Error(JSON.stringify(result)); return result.data;
}
test.beforeAll(async () => {
  root = repository(); other = repository(); source = temporaryDirectory();
  write(root, 'a.txt', 'one'); commit(root, '长标题 '.repeat(40));
  write(other, 'b.txt', 'two'); commit(other);
  write(source, 'images/关系图.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120"><rect width="480" height="120" fill="#eee"/><text x="20" y="60">Offline diagram</text></svg>');
  write(source, 'DSH.md', '# DSH 演化学习\n\n## 2026-06-17 保存事实与上下文\n\n| 机制 | 作用 |\n| --- | --- |\n| Session | 保存事实 |\n\n![关系图](images/关系图.svg)\n\n```mermaid\nflowchart TD\nA[用户输入] --> B[模型循环]\nB --> C[会话日志]\n```\n\n' + '历史解释与设计代价。\n\n'.repeat(80) + '## 2026-09-02 流式记录\n\n实时输出与持久记录分离。\n\n```mermaid\ninvalid diagram !!!\n```\n\n末尾仍可阅读。');
  server = await startLocalServer({ directory: temporaryDirectory(), webDirectory: resolve('dist/web'), queries: createRepositoryQueries(createGitAdapter()) });
});
test.afterAll(async () => { await server?.close(); await cleanupFixtures(); });

test('imports a durable illustrated article, renders and enlarges diagrams, preserves reading and shows dates', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const before = fingerprint(root);
  const session = await call({ action: 'open', path: root }); const ticket = await call({ action: 'ticket', sessionId: session.sessionId });
  await page.goto(`${server.origin}/?session=${session.sessionId}#ticket=${ticket.ticket}`);
  const nav = page.getByRole('navigation', { name: '主视图', exact: true });
  await nav.getByRole('button', { name: '重大变更', exact: true }).click();
  await page.getByRole('button', { name: '导入文章', exact: true }).click();
  await page.getByLabel('文章或资料文件夹路径').fill(join(source, 'DSH.md'));
  await page.getByRole('button', { name: '读取并导入', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'DSH 演化学习', exact: true })).toBeVisible();
  await expect(page.locator('.article-prose table')).toContainText('保存事实');
  const diagram = page.getByRole('img', { name: 'Mermaid 图表', exact: true });
  await expect(diagram).toHaveCount(1);
  await expect.poll(() => diagram.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await page.evaluate(() => {
    Reflect.set(window, 'diagramReloads', 0);
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) if (node.textContent?.includes('正在绘制图表…')) Reflect.set(window, 'diagramReloads', Number(Reflect.get(window, 'diagramReloads')) + 1);
    });
    observer.observe(document.querySelector('.article-prose')!, { childList: true, subtree: true });
    Reflect.set(window, 'diagramObserver', observer);
  });
  await diagram.click(); await expect(page.getByRole('dialog', { name: '放大查看' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '放大查看' }).getByRole('img', { name: 'Mermaid 图表', exact: true })).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: '放大查看' })).toHaveCount(0);
  await page.getByRole('navigation', { name: '文章目录' }).getByRole('button', { name: '2026-09-02 流式记录' }).click();
  await expect(page.getByRole('heading', { name: '2026-09-02 流式记录' })).toBeInViewport();
  await expect(page.getByText('图表无法渲染，正文仍可阅读。')).toBeVisible();
  expect(await page.evaluate(() => { (Reflect.get(window, 'diagramObserver') as MutationObserver).disconnect(); return Reflect.get(window, 'diagramReloads'); })).toBe(0);
  const scroller = page.getByTestId('article-scroll'); const top = await scroller.evaluate(el => el.scrollTop);
  await nav.getByRole('button', { name: '历史', exact: true }).click();
  const date = page.getByTestId('commit-row').first().locator('time');
  await expect(date).toBeVisible(); await expect(date).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
  await page.setViewportSize({ width: 600, height: 800 }); await expect(date).toBeInViewport();
  await page.setViewportSize({ width: 1440, height: 960 });
  await nav.getByRole('button', { name: '重大变更', exact: true }).click();
  await expect.poll(async () => Math.abs((await scroller.evaluate(el => el.scrollTop)) - top)).toBeLessThan(5);
  await rm(source, { recursive: true }); await page.reload();
  await nav.getByRole('button', { name: '重大变更', exact: true }).click();
  const savedImage = page.getByRole('img', { name: '关系图', exact: true });
  await expect.poll(() => savedImage.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  const otherSession = await call({ action: 'open', path: other }); const otherTicket = await call({ action: 'ticket', sessionId: otherSession.sessionId });
  await page.goto(`${server.origin}/?session=${otherSession.sessionId}#ticket=${otherTicket.ticket}`);
  await nav.getByRole('button', { name: '重大变更', exact: true }).click();
  await expect(page.getByText('为这个仓库导入一篇演化文章')).toBeVisible();
  expect(fingerprint(root)).toBe(before);
  expect(errors).toEqual([]);
});

test('folder import selects the main document, failed replacement keeps it, and article markup cannot execute', async ({ page }) => {
  const folder = temporaryDirectory();
  write(folder, 'one.md', '# Wrong document');
  write(folder, 'two.md', '# Chosen document\n\n<script>window.articleInjected = true</script>\n\n[unsafe](javascript:alert(1))\n\n![remote](https://example.invalid/tracker.png)\n\nKept content.');
  write(folder, 'empty.md', '');
  const session = await call({ action: 'open', path: root }); const ticket = await call({ action: 'ticket', sessionId: session.sessionId });
  await page.goto(`${server.origin}/?session=${session.sessionId}#ticket=${ticket.ticket}`);
  await page.getByRole('navigation', { name: '主视图', exact: true }).getByRole('button', { name: '重大变更', exact: true }).click();
  await page.getByRole('button', { name: '替换文章', exact: true }).click();
  await page.getByLabel('文章或资料文件夹路径').fill(folder);
  await page.getByRole('button', { name: '读取并导入', exact: true }).click();
  await page.getByLabel('选择主文章', { exact: true }).selectOption('two.md');
  await page.getByRole('button', { name: '导入所选文章', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Chosen document' })).toBeVisible();
  await expect(page.locator('.article-prose a')).toHaveCount(0);
  await expect(page.locator('.article-prose img')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'articleInjected'))).toBeUndefined();
  await page.getByRole('button', { name: '替换文章', exact: true }).click();
  await page.getByLabel('文章或资料文件夹路径').fill(join(folder, 'empty.md'));
  await page.getByRole('button', { name: '读取并导入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('文章内容为空');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Chosen document' })).toBeVisible();
  await page.reload();
  await page.getByRole('navigation', { name: '主视图', exact: true }).getByRole('button', { name: '重大变更', exact: true }).click();
  await expect(page.getByText('Kept content.')).toBeVisible();
});
