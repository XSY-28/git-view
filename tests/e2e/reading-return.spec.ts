import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';
import { createGitAdapter } from '../../packages/git-cli/src/index';
import { createRepositoryQueries } from '../../packages/core/src/index';
import { startLocalServer } from '../../apps/local/src/server';
import { cleanupFixtures, commit, fingerprint, fixtureGit, repository, temporaryDirectory, write } from '../fixtures/git';

let server: Awaited<ReturnType<typeof startLocalServer>>; let root: string; let first: string;
async function call(fields: Record<string, unknown>) {
  const response = await fetch(`${server.origin}/api`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${server.record.cliToken}` }, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...fields }) });
  const result = await response.json(); if (!result.ok) throw new Error(JSON.stringify(result)); return result.data;
}
test.beforeAll(async () => {
  // All Git writes are confined to disposable fixtures; the UI remains read only.
  root = repository();
  for (let version = 0; version < 45; version++) {
    write(root, 'reading.txt', Array.from({ length: 160 }, (_, line) => `${line === 0 ? version : line} ${'wide reading content '.repeat(50)}`).join('\n') + '\n');
    const oid = commit(root, `reading change ${String(version).padStart(2, '0')}`); if (!version) first = oid;
  }
  server = await startLocalServer({ directory: temporaryDirectory(), webDirectory: resolve('dist/web'), queries: createRepositoryQueries(createGitAdapter({ limits: { historyPageSize: 20 } })) });
});
test.afterAll(async () => { await server?.close(); await cleanupFixtures(); });
async function open(page: Page) {
  await page.setViewportSize({ width: 1180, height: 560 });
  const session = await call({ action: 'open', path: root }); const ticket = await call({ action: 'ticket', sessionId: session.sessionId });
  await page.goto(`${server.origin}/?session=${session.sessionId}#ticket=${ticket.ticket}`);
  await expect(page.locator('.read-feedback[data-scope="仓库状态"]')).toHaveAttribute('data-phase', 'idle');
  await page.getByRole('navigation', { name: '主视图', exact: true }).getByRole('button', { name: '历史', exact: true }).click();
  await expect(page.getByTestId('navigation-ref')).toHaveCount(1);
}
async function search(page: Page) {
  await page.getByRole('navigation', { name: '历史内容', exact: true }).getByRole('button', { name: '提交搜索', exact: true }).click();
  await page.getByLabel('搜索提交', { exact: true }).fill('reading'); await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.locator('.investigation-row')).toHaveCount(20);
  await page.getByRole('button', { name: '继续加载', exact: true }).click(); await expect(page.locator('.investigation-row')).toHaveCount(40);
}
async function settleScroll(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function position(page: Page) {
  return page.evaluate(() => ({ pageTop: scrollY, list: document.querySelector<HTMLElement>('[data-reading-scroll="list"]')?.scrollTop, blameTop: document.querySelector<HTMLElement>('[data-reading-scroll="blame"]')?.scrollTop, blameLeft: document.querySelector<HTMLElement>('[data-reading-scroll="blame"]')?.scrollLeft }));
}
async function nativeClick(locator: ReturnType<Page['locator']>) { await locator.evaluate(node => (node as HTMLButtonElement).click()); }

test('search return restores two pages, selected row, scroll and keyboard focus without rereading', async ({ page }) => {
  const before = fingerprint(root); await open(page); await search(page);
  let reads = 0; page.on('request', request => { if (request.url().endsWith('/api') && request.postDataJSON().action === 'search') reads++; });
  await page.locator('[data-reading-scroll="list"]').evaluate(node => { node.scrollTop = 440; });
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight - innerHeight)); await settleScroll(page);
  const point = await position(page); expect(point.list).toBe(440); expect(point.pageTop).toBeGreaterThan(0);
  const row = page.locator('.investigation-row').nth(15); const key = await row.getAttribute('data-reading-focus');
  await nativeClick(row); await expect(page.locator('.commit-detail')).toContainText('reading change 29');
  await nativeClick(page.getByRole('button', { name: '返回搜索结果', exact: true }));
  await expect(page.locator('.investigation-row')).toHaveCount(40); await expect(page.locator(`.investigation-row[data-reading-focus="${key}"]`)).toBeFocused();
  await expect(page.locator('.investigation-row[aria-pressed=true]')).toHaveAttribute('data-reading-focus', key!);
  await settleScroll(page); expect(await position(page)).toEqual(point); expect(reads).toBe(0); expect(fingerprint(root)).toBe(before);
});

test('file and blame return restores loaded history, chosen side, both scroll axes and the origin line focus', async ({ page }) => {
  const before = fingerprint(root); await open(page);
  await page.locator('.history-more > summary').click(); await page.locator('.history-more-panel').getByRole('button', { name: '文件历史', exact: true }).click();
  await page.getByLabel('文件历史路径').fill('reading.txt'); await page.getByRole('button', { name: '查看历史', exact: true }).click();
  await expect(page.locator('.investigation-row')).toHaveCount(20); await page.getByRole('button', { name: '继续加载', exact: true }).click(); await expect(page.locator('.investigation-row')).toHaveCount(40);
  await nativeClick(page.locator('.investigation-row').nth(15)); await page.getByRole('button', { name: '比较后行来源', exact: true }).click(); await expect(page.locator('.blame-line')).toHaveCount(160);
  const selected = await page.locator('.investigation-row[aria-pressed=true]').getAttribute('data-reading-focus');
  let reads = 0; page.on('request', request => { if (request.url().endsWith('/api') && ['file-history', 'file-history-change', 'blame'].includes(request.postDataJSON().action)) reads++; });
  await page.locator('[data-reading-scroll="list"]').evaluate(node => { node.scrollTop = 440; });
  await page.locator('.blame-scroll').evaluate(node => { node.scrollTop = 630; node.scrollLeft = 220; });
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight - innerHeight)); await settleScroll(page);
  const point = await position(page); expect(point.blameTop).toBe(630); expect(point.blameLeft).toBe(220);
  await nativeClick(page.locator('[data-reading-focus="blame:30"]')); await expect(page.locator('.commit-detail')).toContainText('reading change 00');
  await nativeClick(page.getByRole('button', { name: '返回文件历史', exact: true }));
  await expect(page.locator('.investigation-row')).toHaveCount(40); await expect(page.getByRole('button', { name: '比较后行来源', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.investigation-row[aria-pressed=true]')).toHaveAttribute('data-reading-focus', selected!); await expect(page.locator('[data-reading-focus="blame:30"]')).toBeFocused();
  await settleScroll(page); expect(await position(page)).toEqual(point); expect(reads).toBe(0); expect(fingerprint(root)).toBe(before);
  await nativeClick(page.getByRole('button', { name: '查看提交', exact: true })); await expect(page.locator('.commit-detail')).toContainText('reading change 29');
  await nativeClick(page.getByRole('button', { name: '返回文件历史', exact: true })); await expect(page.locator('[data-reading-focus="commit"]')).toBeFocused();
});

test('return after a generation change reloads the whole loaded window before restoring focus', async ({ page }) => {
  await open(page); await search(page); await nativeClick(page.locator('.investigation-row').nth(15)); await expect(page.locator('.commit-detail')).toBeVisible();
  await page.getByRole('button', { name: '刷新仓库', exact: true }).click(); await expect(page.locator('.read-feedback[data-scope="仓库状态"]')).toHaveAttribute('data-phase', 'idle');
  let reads = 0; page.on('request', request => { if (request.url().endsWith('/api') && request.postDataJSON().action === 'search') reads++; });
  await nativeClick(page.getByRole('button', { name: '返回搜索结果', exact: true }));
  await expect(page.locator('.investigation-row')).toHaveCount(40); await expect(page.locator('.investigation-row[aria-pressed=true]')).toBeFocused();
  await expect(page.locator('.investigation-read')).toHaveAttribute('data-phase', 'idle'); expect(reads).toBe(2);
});

test('unchanged focus retains comparison identity, expanded endpoints and exclusive commit pages', async ({ page }) => {
  await open(page); await page.getByRole('navigation', { name: '主视图', exact: true }).getByRole('button', { name: '版本比较', exact: true }).click();
  await page.getByLabel('比较端点 B', { exact: true }).selectOption('commit'); await page.getByLabel('B 提交 ID', { exact: true }).fill(first); await page.getByRole('button', { name: '比较', exact: true }).click();
  await expect(page.locator('.comparison-resolved-details')).toBeVisible(); await page.locator('.comparison-resolved-details > summary').click();
  await page.getByRole('button', { name: /^A 独有提交/ }).click(); await expect(page.locator('.comparison-commit')).toHaveCount(20);
  await page.getByRole('button', { name: '继续加载', exact: true }).click(); await expect(page.locator('.comparison-commit')).toHaveCount(40);
  await page.locator('.comparison-resolved-details').evaluate(node => { (node as HTMLElement).dataset.identityProbe = 'original'; });
  const reads: { action: string; generation: number }[] = []; page.on('request', request => { if (request.url().endsWith('/api')) reads.push(request.postDataJSON()); });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => reads.filter(read => read.action === 'overview').length).toBe(1); await page.waitForTimeout(1000);
  expect(reads.filter(read => ['compare', 'comparison-commits', 'comparison-change', 'history', 'commit'].includes(read.action))).toEqual([]);
  await expect(page.locator('.comparison-resolved-details')).toHaveAttribute('open'); await expect(page.locator('.comparison-resolved-details')).toHaveAttribute('data-identity-probe', 'original'); await expect(page.locator('.comparison-commit')).toHaveCount(40);
  await nativeClick(page.getByRole('button', { name: '刷新仓库', exact: true })); await expect(page.locator('.comparison-read')).toHaveAttribute('data-phase', 'idle');
  await expect(page.locator('.comparison-resolved-details')).toHaveAttribute('open');
});

for (const failure of ['error', 'wrong-stamp'] as const) {
  test(`focus ${failure} cannot establish freshness and falls back to a full read`, async ({ page }) => {
    await open(page); await nativeClick(page.getByTestId('commit-row').first()); await expect(page.locator('.commit-detail')).toBeVisible();
    const reads: { action: string; generation: number }[] = []; let intercepted = false;
    await page.route('**/api', async route => {
      const request = route.request().postDataJSON(); reads.push(request);
      if (request.action !== 'overview' || intercepted) return route.fallback();
      intercepted = true; const response = await route.fetch(); const body = await response.json();
      await route.fulfill({ response, json: failure === 'wrong-stamp' ? { ...body, stamp: { ...body.stamp, generation: body.stamp.generation + 1 } } : { schemaVersion: 1, ok: false, stamp: body.stamp, requestId: request.requestId, finishedAt: body.stamp.finishedAt, error: { code: 'TIMEOUT', message: 'focus check failed', retryable: true } } });
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => reads.filter(read => read.action === 'overview').length).toBe(2);
    const overviews = reads.filter(read => read.action === 'overview'); expect(overviews[1].generation).toBe(overviews[0].generation + 1);
    await expect(page.locator('.read-feedback[data-scope="仓库状态"]')).toHaveAttribute('data-phase', 'idle'); await expect(page.locator('.commit-detail')).toContainText('reading change 44');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test('focus detects a changed non-HEAD reference even when polling has not reported it', async ({ page }) => {
  // Hold the watcher observation constant to exercise the independent ref check.
  await page.route('**/api/watch', route => route.fulfill({ json: { schemaVersion: 1, ok: true, data: { revision: 0, watching: true } } }));
  await open(page); await expect(page.getByTestId('navigation-ref')).toHaveCount(1);
  const reads: { action: string; generation: number }[] = []; page.on('request', request => { if (request.url().endsWith('/api')) reads.push(request.postDataJSON()); });
  try {
    fixtureGit(root, ['update-ref', 'refs/heads/focus-probe', first]);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByTestId('navigation-ref')).toHaveCount(2); await expect(page.getByTestId('navigation-ref')).toContainText(['focus-probe', 'main']);
    const overviews = reads.filter(read => read.action === 'overview'); expect(overviews).toHaveLength(2); expect(overviews[1].generation).toBe(overviews[0].generation + 1);
  } finally { fixtureGit(root, ['update-ref', '-d', 'refs/heads/focus-probe']); }
});

test('cancelled search stays cancelled across tab return and focus until an explicit retry', async ({ page }) => {
  await open(page); await search(page);
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; }); let intercepted = false; let reads = 0;
  await page.route('**/api', async route => {
    if (route.request().postDataJSON().action !== 'search') return route.fallback();
    reads++; if (intercepted) return route.fallback(); intercepted = true;
    const response = await route.fetch(); await barrier; await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.getByRole('button', { name: '继续加载', exact: true }).click(); await page.getByRole('button', { name: '取消提交搜索读取', exact: true }).click(); release();
    const tabs = page.getByRole('navigation', { name: '历史内容', exact: true });
    await tabs.getByRole('button', { name: '提交列表', exact: true }).click(); await tabs.getByRole('button', { name: '提交搜索', exact: true }).click();
    await expect(page.locator('.investigation-read')).toHaveAttribute('data-phase', 'cancelled');
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); }); await page.waitForTimeout(1000);
    expect(reads).toBe(1); await expect(page.locator('.investigation-read')).toHaveAttribute('data-phase', 'cancelled');
    await page.getByRole('button', { name: '重新读取提交搜索', exact: true }).click(); await expect(page.locator('.investigation-read')).toHaveAttribute('data-phase', 'idle'); await expect(page.locator('.investigation-row')).toHaveCount(40); expect(reads).toBe(3);
  } finally { release(); }
});
