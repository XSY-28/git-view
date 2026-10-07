import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';
import { resolve } from 'node:path';
import { createGitAdapter } from '../../packages/git-cli/src/index';
import { createRepositoryQueries } from '../../packages/core/src/index';
import { startLocalServer } from '../../apps/local/src/server';
import { cleanupFixtures, commit, fingerprint, fixtureGit, repository, temporaryDirectory, write } from '../fixtures/git';

let server: Awaited<ReturnType<typeof startLocalServer>>; let root: string; let other: string; let initial: string; let beforeRename: string; let renamed: string; let latest: string;
async function call(fields: Record<string, unknown>) {
  const response = await fetch(`${server.origin}/api`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${server.record.cliToken}` }, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...fields }) });
  const result = await response.json(); if (!result.ok) throw new Error(JSON.stringify(result)); return result.data;
}
test.beforeAll(async () => {
  root = repository(); write(root, 'old-file.txt', 'first\nsecond\n'); initial = commit(root, 'alpha root');
  write(root, 'old-file.txt', 'first\nedited\n'); beforeRename = commit(root, 'alpha edit'); fixtureGit(root, ['mv', 'old-file.txt', 'code.txt']); renamed = commit(root, 'alpha rename');
  write(root, 'code.txt', 'first\nedited\nthird\n'); commit(root, 'alpha third'); write(root, 'code.txt', 'first\nedited\nthird\nfourth\n'); latest = commit(root, 'alpha fourth');
  fixtureGit(root, ['branch', 'topic']);
  // A commit reachable only through topic proves the integrated search retains
  // its all-reference semantics without changing HEAD or its reflog sequence.
  const branchTree = fixtureGit(root, ['rev-parse', 'HEAD^{tree}']).trim();
  const branchOnly = fixtureGit(root, ['commit-tree', branchTree, '-p', latest, '-m', 'topic-only history']).trim();
  fixtureGit(root, ['update-ref', 'refs/heads/topic', branchOnly]);
  write(root, 'code.txt', 'index snapshot\n'); fixtureGit(root, ['add', '--', 'code.txt']); write(root, 'code.txt', 'working snapshot\n'); write(root, 'untracked.txt', 'untracked snapshot\n'); fixtureGit(root, ['stash', 'push', '-u', '-m', 'saved local work']);
  other = repository(); write(other, 'second.txt', 'second repository\n'); commit(other, 'second root');
  server = await startLocalServer({ directory: temporaryDirectory(), webDirectory: resolve('dist/web'), queries: createRepositoryQueries(createGitAdapter({ limits: { historyPageSize: 2 } })) });
});
test.afterAll(async () => { await server?.close(); await cleanupFixtures(); });
async function open(page: Page) {
  const session = await call({ action: 'open', path: root }); const ticket = await call({ action: 'ticket', sessionId: session.sessionId });
  await page.goto(`${server.origin}/?session=${session.sessionId}#ticket=${ticket.ticket}`);
  await page.getByRole('navigation', { name: '主视图', exact: true }).getByRole('button', { name: '历史', exact: true }).click();
  await expect(page.locator('.navigation-ref')).toHaveCount(2);
  await page.getByRole('navigation', { name: '历史内容', exact: true }).getByRole('button', { name: '提交搜索', exact: true }).click();
}
async function more(page: Page, name: string) {
  await page.locator('.history-more > summary').click();
  await page.locator('.history-more-panel').getByRole('button', { name, exact: true }).click();
  await expect(page.locator('.history-more')).not.toHaveAttribute('open');
}
async function fileHistory(page: Page) {
  const contextTab = page.getByRole('navigation', { name: '历史内容', exact: true }).getByRole('button', { name: '文件历史', exact: true });
  if (await contextTab.isVisible()) await contextTab.click();
  else await more(page, '文件历史');
  await page.getByLabel('文件历史路径').fill('code.txt'); await page.getByRole('button', { name: '查看历史', exact: true }).click();
  await expect(page.locator('.investigation-file .investigation-row')).toHaveCount(2); await expect(page.locator('.investigation-file .code-scroll')).toContainText('+fourth');
}
test('three main entries integrate history tools with an explicit list scope and all-reference search', async ({ page }) => {
  const before = fingerprint(root); await open(page);
  const main = page.getByRole('navigation', { name: '主视图', exact: true });
  const contents = page.getByRole('navigation', { name: '历史内容', exact: true });
  const sidebar = page.getByRole('complementary', { name: '历史范围', exact: true });
  await expect(main.getByRole('button')).toHaveCount(3);
  await expect(main.getByRole('button')).toHaveText([/^当前改动\s*0$/, '历史', '版本比较']);
  await expect(page.getByRole('button', { name: '历史调查', exact: true })).toHaveCount(0);
  await expect(contents.getByRole('button')).toHaveText(['提交列表', '提交搜索']);
  await expect(sidebar).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'stash', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'reflog', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('搜索历史范围')).toHaveValue('all');
  await expect(page.getByLabel('搜索字段')).toHaveValue('subject');

  await contents.getByRole('button', { name: '提交列表', exact: true }).click();
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByRole('button', { name: '当前 HEAD', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await sidebar.locator('.navigation-ref').filter({ hasText: /^topic/ }).click();
  await expect(contents.getByRole('button', { name: '提交列表', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.history-range-label')).toContainText('topic');
  await expect(page.locator('.commit-row').first()).toContainText('topic-only history');
  await contents.getByRole('button', { name: '提交搜索', exact: true }).click();
  await expect(sidebar).toHaveCount(0);
  await expect(page.getByLabel('搜索历史范围')).toHaveValue('all');
  await page.getByLabel('搜索提交', { exact: true }).fill('topic-only history');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.locator('.investigation-search .investigation-row')).toHaveCount(1);
  await page.getByLabel('搜索历史范围').selectOption('head');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByText('无匹配提交', { exact: true })).toBeVisible();
  await page.getByLabel('搜索历史范围').selectOption('refs/heads/topic');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.locator('.investigation-search .investigation-row').click();
  await expect(contents.getByRole('button', { name: '提交列表', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sidebar).toBeVisible();
  await expect(page.locator('.commit-detail')).toContainText('topic-only history');
  await contents.getByRole('button', { name: '提交搜索', exact: true }).click();
  await expect(page.getByLabel('搜索历史范围')).toHaveValue('refs/heads/topic');
  await expect(page.getByLabel('搜索字段')).toHaveValue('subject');
  await expect(page.getByLabel('搜索提交', { exact: true })).toHaveValue('topic-only history');
  await main.getByRole('button', { name: '版本比较', exact: true }).click();
  await expect(sidebar).toHaveCount(0);
  await expect(contents).toHaveCount(0);
  await main.getByRole('button', { name: '历史', exact: true }).click();
  await expect(contents.getByRole('button', { name: '提交搜索', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('搜索历史范围')).toHaveValue('refs/heads/topic');
  await expect(page.getByLabel('搜索提交', { exact: true })).toHaveValue('topic-only history');
  await main.getByRole('button', { name: /^当前改动/ }).click();
  await expect(sidebar).toHaveCount(0);
  await main.getByRole('button', { name: '历史', exact: true }).click();
  await expect(contents.getByRole('button', { name: '提交搜索', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('搜索历史范围')).toHaveValue('refs/heads/topic');
  await expect(page.getByLabel('搜索字段')).toHaveValue('subject');
  await expect(page.getByLabel('搜索提交', { exact: true })).toHaveValue('topic-only history');
  await expect(sidebar).toHaveCount(0);
  expect(fingerprint(root)).toBe(before);
});

test('file-history and line-origin commits open the main list while the prior file context stays reachable', async ({ page }) => {
  const before = fingerprint(root); await open(page); await fileHistory(page);
  const contents = page.getByRole('navigation', { name: '历史内容', exact: true });
  const sidebar = page.getByRole('complementary', { name: '历史范围', exact: true });
  await expect(contents.getByRole('button', { name: '文件历史', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sidebar).toHaveCount(0);
  await page.getByRole('button', { name: '查看提交', exact: true }).click();
  await expect(contents.getByRole('button', { name: '提交列表', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sidebar).toBeVisible();
  await expect(page.locator('.commit-detail')).toContainText('alpha fourth');
  await contents.getByRole('button', { name: '文件历史', exact: true }).click();
  await expect(page.getByLabel('文件历史路径')).toHaveValue('code.txt');
  await expect(page.locator('.investigation-file .investigation-row')).toHaveCount(2);
  await page.getByRole('button', { name: '比较后行来源', exact: true }).click();
  await expect(page.locator('.blame-line')).toHaveCount(4);
  await page.locator('.blame-origin').first().click();
  await expect(contents.getByRole('button', { name: '提交列表', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sidebar).toBeVisible();
  await expect(page.locator('.commit-detail')).toContainText('alpha root');
  await contents.getByRole('button', { name: '提交搜索', exact: true }).click();
  await expect(sidebar).toHaveCount(0);
  await contents.getByRole('button', { name: '文件历史', exact: true }).click();
  await expect(page.getByLabel('文件历史路径')).toHaveValue('code.txt');
  await expect(page.locator('.investigation-file .code-scroll')).toContainText('+fourth');
  expect(fingerprint(root)).toBe(before);
});

test('searches all fields and fixed pages, then opens the real commit detail', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); const before = fingerprint(root);
  await open(page); await page.getByLabel('搜索提交', { exact: true }).fill('alpha'); await page.getByRole('button', { name: '搜索', exact: true }).click(); await expect(page.locator('.investigation-search .investigation-row')).toHaveCount(2);
  await page.getByRole('button', { name: '继续加载', exact: true }).click(); await expect(page.locator('.investigation-search .investigation-row')).toHaveCount(4); await page.getByRole('button', { name: '继续加载', exact: true }).click(); await expect(page.locator('.investigation-search .investigation-row')).toHaveCount(5);
  await page.getByRole('button', { name: '刷新仓库', exact: true }).click(); await expect(page.locator('.investigation-search .investigation-row')).toHaveCount(5); await expect(page.locator('.investigation-read')).toHaveAttribute('data-phase', 'idle');
  await page.getByLabel('搜索字段').selectOption('oid'); await page.getByLabel('搜索提交', { exact: true }).fill(initial.slice(0, 9)); await page.getByRole('button', { name: '搜索', exact: true }).click(); await expect(page.locator('.investigation-row')).toHaveCount(1); await expect(page.locator('.investigation-row')).toContainText('alpha root');
  await page.getByLabel('搜索字段').selectOption('author'); await page.getByLabel('搜索提交', { exact: true }).fill('fixture@example'); await page.getByRole('button', { name: '搜索', exact: true }).click(); await expect(page.locator('.investigation-row')).toHaveCount(2);
  await page.getByLabel('搜索字段').selectOption('path'); await page.getByLabel('搜索提交', { exact: true }).fill('old-file.txt'); await page.getByRole('button', { name: '搜索', exact: true }).click(); await expect(page.locator('.investigation-row')).toHaveCount(2); await expect(page.locator('.investigation-row').first()).toContainText('alpha rename');
  await page.locator('.investigation-row').first().click();
  await expect(page.getByRole('navigation', { name: '历史内容', exact: true }).getByRole('button', { name: '提交列表', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('complementary', { name: '历史范围', exact: true })).toBeVisible();
  await expect(page.locator('.commit-detail')).toContainText('alpha rename'); await expect(page.locator('.file-history-action')).toBeVisible(); await page.locator('.file-history-action').click(); await expect(page.getByLabel('文件历史路径')).toHaveValue('code.txt'); await expect(page.locator('.investigation-file .investigation-row').first()).toContainText('alpha rename');
  await page.getByRole('navigation', { name: '历史内容', exact: true }).getByRole('button', { name: '提交搜索', exact: true }).click();
  await expect(page.getByLabel('搜索字段')).toHaveValue('path');
  await expect(page.getByLabel('搜索提交', { exact: true })).toHaveValue('old-file.txt');
  await expect(page.getByLabel('搜索历史范围')).toHaveValue('all');
  expect(errors).toEqual([]); expect(fingerprint(root)).toBe(before);
});
test('shows rename paths and correct before/after line origins, with keyboard selection and refresh retention', async ({ page }) => {
  const before = fingerprint(root); await open(page); await fileHistory(page);
  await page.getByRole('button', { name: '比较后行来源', exact: true }).click(); await expect(page.locator('.blame-line')).toHaveCount(4); await expect(page.locator('.blame-line').first()).toContainText(initial.slice(0, 8)); await expect(page.locator('.blame-line').last()).toContainText(latest.slice(0, 8));
  await page.getByRole('button', { name: '比较前行来源', exact: true }).click(); await expect(page.locator('.blame-line')).toHaveCount(3); await expect(page.locator('.blame-view')).not.toContainText('fourth');
  await page.getByRole('button', { name: '继续加载', exact: true }).click(); await expect(page.locator('.investigation-file .investigation-row')).toHaveCount(4);
  await page.locator('.investigation-file .investigation-row').filter({ hasText: 'alpha rename' }).click(); await expect(page.locator('.blame-view .investigation-summary')).toContainText('old-file.txt'); await expect(page.locator('.blame-view .investigation-summary')).toContainText(beforeRename.slice(0, 10));
  await page.getByRole('button', { name: '比较后行来源', exact: true }).click(); await expect(page.locator('.blame-view .investigation-summary')).toContainText('code.txt'); await expect(page.locator('.blame-view .investigation-summary')).toContainText(renamed.slice(0, 10));
  await page.getByRole('button', { name: '刷新仓库', exact: true }).click(); await expect(page.locator('.investigation-read')).toHaveAttribute('data-phase', 'idle'); await expect(page.locator('.investigation-file .investigation-row')).toHaveCount(4); await expect(page.locator('.investigation-row[aria-pressed=true]')).toContainText('alpha rename');
  await expect(page.getByRole('button', { name: '继续加载', exact: true })).toBeEnabled(); await page.getByRole('button', { name: '继续加载', exact: true }).click(); await expect(page.locator('.investigation-file .investigation-row')).toHaveCount(5);
  await expect(page.locator('.investigation-file .investigation-row').first()).toBeEnabled(); await page.locator('.investigation-file .investigation-row').first().focus(); await page.keyboard.press('End'); await expect(page.locator('.investigation-file .investigation-row').last()).toBeFocused(); await expect(page.locator('.blame-line')).toHaveCount(2); await expect(page.getByRole('button', { name: '比较前行来源', exact: true })).toBeDisabled();
  expect(fingerprint(root)).toBe(before);
});
test('reads separate stash snapshots and reflog transitions, then compares a recorded move', async ({ page }) => {
  const before = fingerprint(root); await open(page); await more(page, 'stash'); await expect(page.locator('.stash-snapshot .code-scroll')).toContainText('+working snapshot');
  await page.getByRole('button', { name: '暂存区快照', exact: true }).click(); await expect(page.locator('.stash-snapshot .code-scroll')).toContainText('+index snapshot');
  await page.getByRole('button', { name: '未跟踪快照', exact: true }).click(); await expect(page.locator('.stash-snapshot .code-scroll')).toContainText('+untracked snapshot'); await expect(page.locator('.stash-snapshot .file-row')).toContainText('untracked.txt');
  await page.getByLabel('筛选 stash 文件').fill('absent'); await expect(page.locator('.stash-snapshot .diff-view')).toHaveCount(0); await page.getByRole('button', { name: '刷新仓库', exact: true }).click(); await expect(page.locator('.investigation-read')).toHaveAttribute('data-phase', 'idle'); await expect(page.locator('.stash-snapshot .diff-view')).toHaveCount(0);
  await more(page, 'reflog'); await expect(page.locator('.investigation-records .investigation-row')).toHaveCount(2); await expect(page.locator('.record-detail')).toContainText('HEAD@{0}');
  await page.locator('.investigation-records .investigation-row').filter({ hasText: 'commit: alpha fourth' }).click(); await expect(page.locator('.record-detail')).toContainText(latest.slice(0, 10)); await page.getByRole('button', { name: '查看新提交', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '历史内容', exact: true }).getByRole('button', { name: '提交列表', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.commit-detail')).toContainText('alpha fourth');
  await more(page, 'reflog');
  await page.locator('.investigation-records .investigation-row').filter({ hasText: 'commit: alpha fourth' }).click();
  await page.getByRole('button', { name: '比较前后', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '主视图', exact: true }).getByRole('button', { name: '版本比较', exact: true })).toHaveClass(/active/);
  await expect(page.getByRole('complementary', { name: '历史范围', exact: true })).toHaveCount(0);
  await expect(page.locator('.comparison-workspace .code-scroll')).toContainText('+fourth'); expect(fingerprint(root)).toBe(before);
});
test('rejects obsolete search success/error and a blame result after changing its side', async ({ page }) => {
  await open(page);
  for (const failure of [false, true]) {
    let release!: () => void; let captured!: () => void; const hold = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { captured = resolve; }); let once = true;
    const handler = async (route: Route) => { const request = route.request().postDataJSON(); if (request.action !== 'search' || !once) { await route.fallback(); return; } once = false; const response = await route.fetch(); const result = await response.json(); captured(); await hold; await route.fulfill({ json: failure ? { schemaVersion: 1, ok: false, error: { code: 'TIMEOUT', message: 'obsolete investigation failure', retryable: true }, stamp: result.stamp, requestId: request.requestId, finishedAt: new Date().toISOString() } : result }).catch(() => {}); };
    await page.route('**/api', handler); await page.getByLabel('搜索提交', { exact: true }).fill('alpha'); await page.getByRole('button', { name: '搜索', exact: true }).click(); await started;
    await page.getByLabel('搜索提交', { exact: true }).fill('no match'); await page.getByRole('button', { name: '搜索', exact: true }).click(); await expect(page.getByText('无匹配提交', { exact: true })).toBeVisible(); release(); await page.waitForTimeout(100); await expect(page.locator('.investigation-view')).not.toContainText('obsolete investigation failure'); await expect(page.locator('.investigation-row')).toHaveCount(0); await page.unroute('**/api', handler);
  }
  await fileHistory(page); let release!: () => void; let captured!: () => void; const hold = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { captured = resolve; }); let once = true;
  await page.route('**/api', async route => { if (route.request().postDataJSON().action !== 'blame' || !once) { await route.fallback(); return; } once = false; const response = await route.fetch(); captured(); await hold; await route.fulfill({ response }).catch(() => {}); });
  await page.getByRole('button', { name: '比较后行来源', exact: true }).click(); await started; await page.getByRole('button', { name: '比较前行来源', exact: true }).click(); await expect(page.locator('.blame-line')).toHaveCount(3); release(); await page.waitForTimeout(100); await expect(page.locator('.blame-line')).toHaveCount(3); await expect(page.locator('.blame-view')).not.toContainText('fourth');
});
test('cancels and retries, switches language and keeps narrow file/blame and stash views usable', async ({ page }) => {
  await open(page); let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; }); let once = true;
  await page.route('**/api', async route => { if (route.request().postDataJSON().action !== 'search' || !once) { await route.fallback(); return; } once = false; const response = await route.fetch(); await hold; await route.fulfill({ response }).catch(() => {}); });
  await page.getByLabel('搜索提交', { exact: true }).fill('alpha'); await page.getByRole('button', { name: '搜索', exact: true }).click(); await page.getByRole('button', { name: '取消提交搜索读取', exact: true }).click(); release(); await page.getByRole('button', { name: '重新读取提交搜索', exact: true }).click(); await expect(page.locator('.investigation-row')).toHaveCount(2);
  await page.getByLabel('界面语言').selectOption('en'); await expect(page.getByLabel('Search scope')).toBeVisible(); expect(await page.getByLabel('Search scope').textContent()).not.toMatch(/[\u4e00-\u9fff]/); await page.getByLabel('Interface language').selectOption('zh-CN');
  await fileHistory(page); await page.getByRole('button', { name: '比较后行来源', exact: true }).click(); await expect(page.locator('.blame-line')).toHaveCount(4); await page.getByLabel('界面语言').selectOption('en'); await expect(page.getByRole('button', { name: 'View history', exact: true })).toBeVisible(); expect(await page.locator('.investigation-view').innerText()).not.toMatch(/[\u4e00-\u9fff]/);
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'View details', exact: true }).click(); await expect(page.locator('.blame-scroll')).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await more(page, 'stash');
  // Entering a history tool starts with its records in a narrow window;
  // snapshot controls belong to the explicitly opened detail panel.
  await page.getByRole('navigation', { name: 'Panels for narrow windows', exact: true }).getByRole('button', { name: 'View details', exact: true }).click();
  await expect(page.locator('.stash-snapshot .code-scroll')).toBeVisible();
  await expect(page.locator('.stash-snapshot .code-scroll')).toContainText('+working snapshot'); await page.getByRole('button', { name: 'Index snapshot', exact: true }).click(); await expect(page.locator('.stash-snapshot .code-scroll')).toContainText('+index snapshot'); await page.getByRole('button', { name: 'Untracked snapshot', exact: true }).click(); await expect(page.locator('.stash-snapshot .diff-baseline')).toContainText('Empty tree'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(await page.locator('.investigation-view').innerText()).not.toMatch(/[\u4e00-\u9fff]/);
});
