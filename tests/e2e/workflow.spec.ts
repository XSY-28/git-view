import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let folder: string; let repo: string; let runtime: string; let origin: string; let token: string; let sessionId: string;
const cli = resolve('dist/cli.mjs');
function git(...args: string[]) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'Git View Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Git View Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }); }
async function call(action: Record<string, unknown>) {
  const response = await fetch(`${origin}/api`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...action }) });
  const result = await response.json() as { ok: boolean; data: Record<string, unknown> };
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.data;
}
test.beforeAll(async () => {
  // All Git writes below are confined to this newly created temporary fixture.
  folder = await mkdtemp(join(tmpdir(), 'git-view-browser-')); repo = join(folder, '中文 仓库'); runtime = join(folder, 'runtime'); await mkdir(repo);
  git('init', '-b', 'main');
  await writeFile(join(repo, 'hello.txt'), 'version one\n');
  await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
  git('add', '--', 'hello.txt', '.gitignore'); git('commit', '-m', '首次提交');
  await writeFile(join(repo, 'hello.txt'), 'version two staged\n'); git('add', '--', 'hello.txt');
  await writeFile(join(repo, 'hello.txt'), 'version three working\n');
  await writeFile(join(repo, '未跟踪.txt'), 'a new file\n'); await writeFile(join(repo, 'ignored.txt'), 'ignored\n');
  const output = execFileSync(process.execPath, [cli, 'open', '--repo', repo, '--no-browser', '--json'], { encoding: 'utf8', env: { ...process.env, GIT_VIEW_HOME: runtime } });
  const result = JSON.parse(output) as { ok: boolean }; expect(result.ok).toBe(true);
  const record = JSON.parse(await readFile(join(runtime, 'instance.json'), 'utf8')) as { port: number; cliToken: string };
  origin = `http://127.0.0.1:${record.port}`; token = record.cliToken;
  const opened = await call({ action: 'open', path: repo }); sessionId = opened.sessionId as string;
});
test.afterAll(async () => { if (origin) await call({ action: 'shutdown' }).catch(() => {}); if (folder) await rm(folder, { recursive: true, force: true }); });

test('real partial staging, history, refresh and tool layout', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const ticket = await call({ action: 'ticket', sessionId });
  await page.goto(`${origin}/?session=${encodeURIComponent(sessionId)}#ticket=${encodeURIComponent(ticket.ticket as string)}`);
  await expect(page.getByText('hello.txt', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('group', { name: '固定问题' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '理解现状' })).toHaveCount(0);
  await expect(page.getByText('ignored.txt', { exact: true })).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe('');
  // Selection is driven by accessible names; each comparison has its own button.
  const hello = page.getByRole('button').filter({ hasText: 'hello.txt' });
  await hello.first().click();
  await expect(page.locator('.code-scroll').getByText('+version two staged', { exact: false })).toBeInViewport();
  await expect(page.locator('.diff-baseline')).toContainText(/HEAD(?: [0-9a-f]{10})?\s*→\s*暂存区/);
  const list = await page.locator('.list-panel').boundingBox();
  const detail = await page.locator('.detail-panel').boundingBox();
  expect(list).not.toBeNull(); expect(detail).not.toBeNull();
  expect(detail!.width).toBeGreaterThan(list!.width * 2);
  await page.screenshot({ path: 'test-results/current-changes.png', fullPage: true });
  await hello.nth(1).click();
  await expect(page.locator('.code-scroll').getByText('+version three working', { exact: false })).toBeVisible();
  await expect(page.locator('.code-scroll').getByText('-version two staged', { exact: false })).toBeVisible();
  await expect(page.locator('.diff-baseline')).toContainText(/暂存区\s*→\s*工作区/);
  await page.getByRole('navigation', { name: '主视图', exact: true }).getByRole('button', { name: '历史', exact: true }).click();
  await expect(page.getByRole('button').filter({ hasText: '首次提交' }).first()).toBeVisible();
  await page.getByRole('button').filter({ hasText: '首次提交' }).first().click();
  await page.locator('.commit-metadata summary').click();
  await expect(page.locator('.commit-metadata')).toContainText('相对空树');
  await expect(page.locator('.commit-metadata dd code').first()).toHaveText(/[0-9a-f]{40}/);
  await page.locator('.commit-metadata summary').click();
  await expect(page.locator('.code-scroll').getByText('+ignored.txt', { exact: false })).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: 'test-results/history.png', fullPage: true });
  await page.getByRole('button', { name: /当前改动/ }).first().click();
  await writeFile(join(repo, 'hello.txt'), 'version four after refresh\n');
  await page.getByRole('button', { name: /刷新/ }).first().click();
  await expect(page.locator('.code-scroll').getByText('+version four after refresh', { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByText('hello.txt', { exact: true }).first()).toBeVisible();
  await page.locator('.group-unstaged .file-row').filter({ hasText: 'hello.txt' }).click();
  const other = await page.context().newPage();
  await other.goto('about:blank');
  await writeFile(join(repo, 'hello.txt'), 'version five after focus\n');
  await page.waitForTimeout(750);
  await page.bringToFront();
  await expect(page.locator('.code-scroll').getByText('+version five after focus', { exact: false })).toBeVisible();
  await other.close();
  await writeFile(join(repo, 'hello.txt'), 'version two staged\n');
  await page.waitForTimeout(750);
  await page.getByRole('button', { name: /刷新/ }).first().click();
  // The watcher may have already shown and dismissed the transient notice before
  // the manual refresh. Assert durable selection/diff state, not toast timing.
  await expect(page.locator('.group-unstaged .file-row').filter({ hasText: 'hello.txt' })).toHaveCount(0);
  await expect(page.locator('.file-row[aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator('.code-scroll')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const panels = page.getByRole('navigation', { name: '窄窗口面板' });
  await expect(panels.getByRole('button')).toHaveText(['文件列表', '查看详情']);
  await expect(page.getByRole('complementary', { name: '历史范围', exact: true })).toHaveCount(0);
  await page.getByRole('navigation', { name: '主视图', exact: true }).getByRole('button', { name: '历史', exact: true }).click();
  await expect(panels.getByRole('button')).toHaveText(['历史范围', '提交列表', '查看详情']);
  await panels.getByRole('button', { name: '历史范围', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '历史范围' })).toBeVisible();
  await expect(page.locator('.workspace')).toBeHidden();
  await page.getByRole('navigation', { name: '主视图', exact: true }).getByRole('button', { name: /^当前改动/ }).click();
  await panels.getByRole('button', { name: '文件列表' }).click();
  await page.locator('.group-staged .file-row').filter({ hasText: 'hello.txt' }).click();
  await expect(page.locator('.code-scroll').getByText('+version two staged', { exact: false })).toBeVisible();
  await expect(page.locator('.list-panel')).toBeHidden();
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('an unauthorized browser cannot query repositories', async ({ request }) => {
  const response = await request.post(`${origin}/api`, { data: { schemaVersion: 1, action: 'recents', requestId: 'unauthorized' } });
  expect(response.status()).toBe(403);
  expect((await response.json()).error.code).toBe('UNAUTHORIZED');
});
