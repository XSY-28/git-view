import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let folder: string; let repo: string; let runtime: string; let origin: string; let token: string; let sessionId: string;
const fixtureEnv = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_AUTHOR_NAME: 'Language Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Language Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
function git(...args: string[]) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: fixtureEnv }); }
async function call(action: Record<string, unknown>) {
  const response = await fetch(`${origin}/api`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...action }) });
  const result = await response.json() as { ok: boolean; data: Record<string, unknown> }; if (!result.ok) throw new Error(JSON.stringify(result)); return result.data;
}
async function start() {
  execFileSync(process.execPath, [resolve('dist/cli.mjs'), 'open', '--repo', repo, '--no-browser', '--json'], { encoding: 'utf8', env: { ...fixtureEnv, GIT_VIEW_HOME: runtime } });
  const record = JSON.parse(await readFile(join(runtime, 'instance.json'), 'utf8')) as { port: number; cliToken: string };
  origin = `http://127.0.0.1:${record.port}`; token = record.cliToken;
  sessionId = (await call({ action: 'open', path: repo })).sessionId as string;
}
async function stop() {
  await call({ action: 'shutdown' });
  await expect.poll(async () => readFile(join(runtime, 'instance.json')).then(() => false, () => true)).toBe(true);
}
async function open(page: Page) {
  const ticket = await call({ action: 'ticket', sessionId });
  await page.goto(`${origin}/?session=${sessionId}#ticket=${ticket.ticket}`);
  await expect(page.locator('#app-language')).toBeEnabled();
  await expect(page.getByTestId('diff-scroll')).toBeVisible();
}
test.beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'git-view-language-ui-')); repo = join(folder, '当前分支'); runtime = join(folder, 'runtime'); await mkdir(repo);
  git('init', '-b', 'main'); await writeFile(join(repo, '暂存.txt'), '当前分支\n'); git('add', '--', '暂存.txt'); git('commit', '-m', '提交说明');
  await writeFile(join(repo, '暂存.txt'), '当前分支\n用户内容保持原文\n');
  await start();
});
test.afterAll(async () => { if (origin) await call({ action: 'shutdown' }).catch(() => {}); if (folder) await rm(folder, { recursive: true, force: true }); });

test('English default, live switching, page reopen and process restart remember the last choice', async ({ page, browser }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const initialIndex = await readFile(join(repo, '.git/index')); const initialHead = git('rev-parse', 'HEAD');
  await open(page);
  await expect(page.getByLabel('Interface language')).toHaveValue('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: /^Changes/ })).toBeVisible();
  await expect(page.locator('.group-unstaged summary')).toContainText('Unstaged');
  await expect(page.locator('.diff-baseline')).toContainText('Index');
  await expect(page.locator('.diff-baseline')).toContainText('Working tree');
  await expect(page.getByTestId('diff-scroll')).toContainText('用户内容保持原文');
  await expect(page.getByRole('button', { name: 'Switch repository: 当前分支', exact: true })).toBeVisible();
  const selectedId = await page.locator('.file-row[aria-pressed="true"]').getAttribute('data-entry-id');
  await page.getByRole('button', { name: 'Side by side', exact: true }).click();
  await page.getByLabel('Filter current change files').fill('暂存');
  await page.getByLabel('Interface language').selectOption('zh-CN');
  await expect(page.getByLabel('界面语言')).toHaveValue('zh-CN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByRole('button', { name: /^当前改动/ })).toBeVisible();
  await expect(page.locator('.diff-view')).toHaveAttribute('data-diff-mode', 'split');
  await expect(page.getByLabel('筛选当前改动文件')).toHaveValue('暂存');
  await expect(page.locator('.file-row[aria-pressed="true"]')).toHaveAttribute('data-entry-id', selectedId!);
  await expect(page.locator('.split-labels')).toHaveText('暂存区工作区');
  expect(JSON.parse(await readFile(join(runtime, 'preferences.json'), 'utf8')).language).toBe('zh-CN');
  await page.reload(); await expect(page.getByLabel('界面语言')).toHaveValue('zh-CN');
  const reopened = await page.context().newPage(); await open(reopened);
  await expect(reopened.getByLabel('界面语言')).toHaveValue('zh-CN'); await reopened.close();
  await page.screenshot({ path: 'test-results/language-chinese.png', fullPage: true });
  await page.close(); await stop(); await start();
  // A new browser context and a restarted local host rule out tab state and
  // per-origin localStorage as the reason the preference was restored.
  const context = await browser.newContext(); const fresh = await context.newPage();
  try {
    await open(fresh); await expect(fresh.getByLabel('界面语言')).toHaveValue('zh-CN');
    await fresh.getByLabel('界面语言').selectOption('en');
    await expect(fresh.getByLabel('Interface language')).toHaveValue('en');
    await fresh.getByRole('button', { name: /^History/ }).click();
    await fresh.getByTestId('commit-row').first().click();
    await expect(fresh.locator('.commit-summary h2')).toHaveText('提交说明');
    await fresh.locator('.commit-metadata summary').click();
    await expect(fresh.locator('.commit-metadata')).toContainText('Compared with the empty tree (initial commit)');
    await fresh.screenshot({ path: 'test-results/language-english.png', fullPage: true });
    await fresh.setViewportSize({ width: 390, height: 844 });
    await expect(fresh.getByLabel('Interface language')).toBeVisible();
    expect(await fresh.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await fresh.screenshot({ path: 'test-results/language-mobile.png', fullPage: true });
  } finally { await context.close(); }
  await stop(); await start();
  const lastContext = await browser.newContext();
  try { const last = await lastContext.newPage(); await open(last); await expect(last.getByLabel('Interface language')).toHaveValue('en'); }
  finally { await lastContext.close(); }
  expect(git('rev-parse', 'HEAD')).toBe(initialHead); expect(await readFile(join(repo, '.git/index'))).toEqual(initialIndex);
  expect(errors).toEqual([]);
});

test('English operation previews and save failures are explicit and do not modify files', async ({ page }) => {
  await call({ action: 'set-language', language: 'en' }); await open(page);
  await page.getByRole('checkbox', { name: 'Select Stage 暂存.txt', exact: true }).check();
  await page.getByRole('button', { name: 'Preview Stage', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Confirm Stage/ });
  await expect(dialog).toContainText('Stage all current changes in the selected files.');
  await expect(dialog.getByRole('button', { name: 'Confirm Stage', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.route('**/api', async route => {
    if (route.request().postDataJSON().action !== 'set-language') return route.fallback();
    await route.fulfill({ json: { schemaVersion: 1, ok: false, error: { code: 'INTERNAL_ERROR', message: 'write failed', retryable: true }, requestId: 'settings', finishedAt: new Date().toISOString() } });
  });
  await page.getByLabel('Interface language').selectOption('zh-CN');
  await expect(page.locator('.language-error')).toHaveText('Could not save the language setting. Retry.');
  await expect(page.getByLabel('Interface language')).toHaveValue('en');
  expect(JSON.parse(await readFile(join(runtime, 'preferences.json'), 'utf8')).language).toBe('en');
  await page.unroute('**/api'); await page.getByLabel('Interface language').selectOption('zh-CN');
  await expect(page.getByLabel('界面语言')).toHaveValue('zh-CN');
  await page.getByLabel('界面语言').selectOption('en');
});
