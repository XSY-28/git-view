import { test, expect } from './fixtures';
import { resolve } from 'node:path';
import { createGitAdapter } from '../../packages/git-cli/src/index';
import { createRepositoryQueries } from '../../packages/core/src/index';
import { startLocalServer } from '../../apps/local/src/server';
import { cleanupFixtures, commit, fingerprint, fixtureGit, repository, temporaryDirectory, write } from '../fixtures/git';
import type { Page } from '@playwright/test';

let server: Awaited<ReturnType<typeof startLocalServer>>;
let root: string; let other: string; let base: string; let a: string; let b: string;
async function call(fields: Record<string, unknown>) {
  const response = await fetch(`${server.origin}/api`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${server.record.cliToken}` }, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...fields }) });
  const result = await response.json(); if (!result.ok) throw new Error(JSON.stringify(result)); return result.data;
}
test.beforeAll(async () => {
  root = repository(); write(root, 'old-name.txt', 'rename content\n'); write(root, 'shared.txt', 'base\n'); base = commit(root, 'comparison base'); fixtureGit(root, ['branch', 'topic']);
  write(root, 'main.txt', 'main branch contents\n'); a = commit(root, 'main unique');
  fixtureGit(root, ['switch', 'topic']); fixtureGit(root, ['mv', 'old-name.txt', 'new-name.txt']); write(root, 'topic.txt', 'topic version 0\n'); b = commit(root, 'topic unique 0');
  for (let n = 1; n <= 4; n++) { write(root, 'topic.txt', `topic version ${n}\n`); b = commit(root, `topic unique ${n}`); }
  fixtureGit(root, ['switch', 'main']);
  other = repository(); write(other, 'other.txt', 'second repository\n'); commit(other, 'other root');
  server = await startLocalServer({ directory: temporaryDirectory(), webDirectory: resolve('dist/web'), queries: createRepositoryQueries(createGitAdapter({ limits: { historyPageSize: 2 } })) });
});

test('discarded pages and repository switches cannot mix observations; each worktree restores its own endpoints', async ({ page }) => {
  await open(page); await page.getByRole('button', { name: '比较', exact: true }).click(); await expect(page.locator('.comparison-workspace .file-row')).toHaveCount(3);
  let releasePage!: () => void; let pageStarted!: () => void;
  const pageHold = new Promise<void>(resolve => { releasePage = resolve; }); const started = new Promise<void>(resolve => { pageStarted = resolve; }); let delayPage = true;
  await page.route('**/api', async route => {
    const fields = route.request().postDataJSON();
    if (fields.action !== 'comparison-commits' || !delayPage) { await route.fallback(); return; }
    delayPage = false; const response = await route.fetch(); pageStarted(); await pageHold; await route.fulfill({ response }).catch(() => {});
  });
  await page.getByRole('button', { name: 'B 独有提交 5', exact: true }).click(); await started;
  await page.getByRole('button', { name: '交换 A 与 B', exact: true }).click(); await expect(page.locator('.comparison-commit')).toHaveCount(1); await expect(page.locator('.comparison-commit')).toContainText('main unique');
  releasePage(); await page.waitForTimeout(100); await expect(page.locator('.comparison-history')).not.toContainText('topic unique');
  let releaseComparison!: () => void; let comparisonStarted!: () => void;
  const comparisonHold = new Promise<void>(resolve => { releaseComparison = resolve; }); const pending = new Promise<void>(resolve => { comparisonStarted = resolve; }); let delayComparison = true;
  await page.route('**/api', async route => {
    if (route.request().postDataJSON().action !== 'compare' || !delayComparison) { await route.fallback(); return; }
    delayComparison = false; const response = await route.fetch(); comparisonStarted(); await comparisonHold; await route.fulfill({ response }).catch(() => {});
  });
  await page.getByRole('button', { name: '比较', exact: true }).click(); await pending;
  await page.locator('.repository-switcher-trigger').click(); await page.getByText('手动输入路径', { exact: true }).click(); await page.getByLabel('本地仓库路径').fill(other); await page.getByRole('button', { name: '按路径打开', exact: true }).click();
  await expect(page.locator('.navigation-ref')).toHaveCount(1); await page.getByRole('button', { name: '版本比较', exact: true }).click(); await page.getByRole('button', { name: '比较', exact: true }).click();
  await expect(page.locator('.comparison-content-tabs')).toContainText('A 独有提交 0'); releaseComparison(); await page.waitForTimeout(100);
  await expect(page.locator('.comparison-fixed-endpoints')).not.toContainText(b.slice(0, 10));
  await page.locator('.repository-switcher-trigger').click(); await page.locator('.navigation-recent').filter({ hasText: root }).click();
  await expect(page.getByLabel('比较端点 A')).toHaveValue('refs/heads/topic'); await expect(page.getByLabel('比较端点 B')).toHaveValue('refs/heads/main');
  await expect(page.locator('.comparison-fixed-endpoints > span').first()).toContainText(b.slice(0, 10));
});
test.afterAll(async () => { await server?.close(); await cleanupFixtures(); });
async function open(page: Page) {
  const id = (await call({ action: 'open', path: root })).sessionId;
  const ticket = await call({ action: 'ticket', sessionId: id });
  await page.goto(`${server.origin}/?session=${id}#ticket=${ticket.ticket}`);
  await expect(page.locator('.navigation-ref')).toHaveCount(2);
  await page.getByRole('button', { name: '版本比较', exact: true }).click();
  await page.getByLabel('比较端点 A').selectOption('refs/heads/main');
  await page.getByLabel('比较端点 B').selectOption('refs/heads/topic');
}

test('compares both histories and trees, filters rename paths, swaps direction and opens exclusive commit details', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); const before = fingerprint(root);
  await open(page); await page.getByRole('button', { name: '比较', exact: true }).click();
  await expect(page.locator('.comparison-fixed-endpoints')).toContainText(a.slice(0, 10)); await expect(page.locator('.comparison-fixed-endpoints')).toContainText(b.slice(0, 10));
  await expect(page.locator('.comparison-base')).toContainText(base.slice(0, 10)); await expect(page.locator('.comparison-workspace .file-row')).toHaveCount(3);
  await page.getByRole('button', { name: '共同祖先 → B', exact: true }).click(); await expect(page.locator('.comparison-workspace .file-row')).toHaveCount(2);
  await page.locator('.comparison-workspace .file-row').filter({ hasText: 'topic.txt' }).click(); await expect(page.locator('.code-scroll')).toContainText('+topic version 4');
  await page.getByLabel('筛选比较文件').fill('old-name'); await expect(page.locator('.comparison-workspace .file-row')).toHaveCount(1); await expect(page.locator('.file-row')).toContainText('new-name.txt');
  await expect(page.locator('.diff-view')).toHaveCount(0);
  await page.getByRole('button', { name: '刷新仓库', exact: true }).click();
  await expect(page.locator('.comparison-read')).toHaveAttribute('data-phase', 'idle');
  await expect(page.locator('.comparison-workspace .file-row')).toHaveCount(1); await expect(page.locator('.diff-view')).toHaveCount(0);
  await page.getByLabel('筛选比较文件').fill(''); await page.locator('.comparison-workspace .file-row').first().focus(); await page.keyboard.press('End');
  await expect(page.locator('.comparison-workspace .file-row').last()).toBeFocused(); await expect(page.locator('.code-scroll')).toContainText('+topic version 4');
  await page.getByRole('button', { name: 'A 独有提交 1', exact: true }).click(); await expect(page.locator('.comparison-commit')).toHaveText(/main unique/);
  await page.getByRole('button', { name: 'B 独有提交 5', exact: true }).click(); await expect(page.locator('.comparison-commit')).toHaveCount(2);
  await page.getByRole('button', { name: '继续加载', exact: true }).click(); await expect(page.locator('.comparison-commit')).toHaveCount(4);
  await page.getByRole('button', { name: '继续加载', exact: true }).click(); await expect(page.locator('.comparison-commit')).toHaveCount(5);
  await page.getByRole('button', { name: /文件差异 2/ }).click(); await page.getByRole('button', { name: '交换 A 与 B', exact: true }).click();
  await expect(page.locator('.comparison-fixed-endpoints > span').first()).toContainText(b.slice(0, 10));
  await page.getByRole('button', { name: 'A → B', exact: true }).click(); await page.locator('.comparison-workspace .file-row').filter({ hasText: 'topic.txt' }).click();
  await expect(page.locator('.code-scroll')).toContainText('-topic version 4');
  await page.getByRole('button', { name: 'B 独有提交 1', exact: true }).click(); await page.locator('.comparison-commit').click();
  await expect(page.locator('.commit-detail')).toContainText('main unique');
  expect(fingerprint(root)).toBe(before); expect(errors).toEqual([]);
});

test('rejects late comparison success and error after swapping, and rejects old file results after changing the base', async ({ page }) => {
  await open(page);
  for (const failure of [false, true]) {
    let release!: () => void; let captured!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { captured = resolve; }); let first = true;
    const handler = async (route: import('@playwright/test').Route) => {
      const request = route.request().postDataJSON();
      if (request.action !== 'compare' || !first) { await route.fallback(); return; }
      first = false; const response = await route.fetch(); const result = await response.json(); captured(); await hold;
      await route.fulfill({ json: failure ? { schemaVersion: 1, ok: false, error: { code: 'TIMEOUT', message: 'obsolete comparison failure', retryable: true }, stamp: result.stamp, requestId: request.requestId, finishedAt: new Date().toISOString() } : result }).catch(() => {});
    };
    await page.route('**/api', handler);
    await page.getByRole('button', { name: '比较', exact: true }).click(); await started;
    await page.getByRole('button', { name: '交换 A 与 B', exact: true }).click();
    await expect(page.locator('.comparison-fixed-endpoints > span').first()).toContainText(failure ? a.slice(0, 10) : b.slice(0, 10));
    release(); await page.waitForTimeout(100);
    await expect(page.locator('.comparison-read')).not.toContainText('obsolete comparison failure'); await page.unroute('**/api', handler);
  }
  let release!: () => void; let captured!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { captured = resolve; }); let delay = true;
  await page.route('**/api', async route => {
    const request = route.request().postDataJSON();
    if (request.action !== 'comparison-change' || !delay) { await route.fallback(); return; }
    delay = false; const response = await route.fetch(); captured(); await hold; await route.fulfill({ response }).catch(() => {});
  });
  await page.locator('.comparison-workspace .file-row').filter({ hasText: 'main.txt' }).click(); await started;
  await page.getByRole('button', { name: '共同祖先 → B', exact: true }).click(); await expect(page.locator('.comparison-workspace .file-row')).toHaveCount(2);
  release(); await page.waitForTimeout(100); await expect(page.locator('.diff-view')).not.toContainText('main branch contents');
});

test('cancels a comparison, retries and keeps language, commit input and narrow window controls functional', async ({ page }) => {
  await open(page); let release!: () => void; let delay = true;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api', async route => {
    if (route.request().postDataJSON().action !== 'compare' || !delay) { await route.fallback(); return; }
    delay = false; const response = await route.fetch(); await hold; await route.fulfill({ response }).catch(() => {});
  });
  await page.getByRole('button', { name: '比较', exact: true }).click(); await page.getByRole('button', { name: '取消版本比较读取', exact: true }).click();
  release(); await page.getByRole('button', { name: '重新读取版本比较', exact: true }).click(); await expect(page.locator('.comparison-workspace .file-row')).toHaveCount(3);
  await page.getByLabel('比较端点 A').selectOption('commit'); await page.getByLabel('A 提交 ID').fill('HEAD~1'); await expect(page.getByRole('button', { name: '比较', exact: true })).toBeDisabled();
  await page.getByLabel('A 提交 ID').fill(base.slice(0, 10)); await page.getByRole('button', { name: '比较', exact: true }).click(); await expect(page.locator('.comparison-workspace .file-row')).toHaveCount(2);
  await page.getByLabel('界面语言').selectOption('en'); await expect(page.getByLabel('Comparison endpoint A')).toBeVisible(); await expect(page.getByRole('button', { name: 'Merge base → B', exact: true })).toBeVisible();
  expect(await page.locator('.comparison-view').innerText()).not.toMatch(/[\u4e00-\u9fff]/);
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'File list', exact: true }).click(); await page.locator('.comparison-workspace .file-row').filter({ hasText: 'topic.txt' }).click();
  await expect(page.locator('.diff-toolbar')).toBeVisible(); await expect(page.locator('.code-scroll')).toContainText('+topic version 4');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
