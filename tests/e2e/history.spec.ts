import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let folder: string; let repo: string; let origin: string; let token: string; let sessionId: string;
async function call(action: Record<string, unknown>) {
  const response = await fetch(`${origin}/api`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...action }) });
  const result = await response.json() as { ok: boolean; data: Record<string, unknown> };
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.data;
}
test.beforeAll(async () => {
  // Only a fresh temporary fixture is modified: main stays at its first commit,
  // while the local side branch contains 230 newer commits. No user repo writes.
  folder = await mkdtemp(join(tmpdir(), 'git-view-history-ui-')); repo = join(folder, 'repository');
  const runtime = join(folder, 'runtime'); await mkdir(repo);
  const git = (args: string[], input?: string) => execFileSync('git', args, { cwd: repo, input, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  git(['init', '-b', 'main']);
  let stream = '';
  for (let index = 1; index <= 231; index++) {
    const subject = `历史提交 ${index}`; const content = `history ${index}\n`;
    stream += `commit refs/heads/side\nmark :${index}\ncommitter History Fixture <test@example.invalid> ${1700000000 + index} +0000\ndata ${Buffer.byteLength(subject)}\n${subject}\nM 100644 inline history.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`;
  }
  stream += 'reset refs/heads/main\nfrom :1\n\n';
  git(['fast-import', '--quiet'], stream); git(['reset', '--hard', 'main']);
  try { execFileSync(process.execPath, [resolve('dist/cli.mjs'), 'open', '--repo', repo, '--no-browser', '--json'], { encoding: 'utf8', env: { ...process.env, GIT_VIEW_HOME: runtime } }); }
  catch (error) { const failure = error as { stdout?: string; stderr?: string }; throw new Error(`Fixture CLI failed: ${failure.stdout || failure.stderr || String(error)}`); }
  const record = JSON.parse(await readFile(join(runtime, 'instance.json'), 'utf8')) as { port: number; cliToken: string };
  origin = `http://127.0.0.1:${record.port}`; token = record.cliToken;
  const opened = await call({ action: 'open', path: repo }); sessionId = opened.sessionId as string;
});
test.afterAll(async () => { if (origin) await call({ action: 'shutdown' }).catch(() => {}); if (folder) await rm(folder, { recursive: true, force: true }); });

test('history defaults to HEAD; locating it outside all refs and virtual pagination work', async ({ page }) => {
  const ticket = await call({ action: 'ticket', sessionId });
  await page.goto(`${origin}/?session=${encodeURIComponent(sessionId)}#ticket=${encodeURIComponent(ticket.ticket as string)}`);
  await page.getByRole('navigation', { name: '主视图', exact: true }).getByRole('button', { name: '历史', exact: true }).click();
  await expect(page.getByRole('button', { name: '当前 HEAD', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.history-loaded-count')).toHaveText('已加载 1 条提交');
  await page.getByRole('button', { name: '全部引用', exact: true }).click();
  await expect(page.locator('.history-loaded-count')).toHaveText('已加载 200 条提交');
  expect(await page.getByTestId('commit-row').count()).toBeLessThan(40);
  await page.getByRole('button', { name: /查看 HEAD 历史/ }).click();
  await expect(page.getByRole('button', { name: '当前 HEAD', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-testid=commit-row].selected')).toContainText('历史提交 1');
  await expect(page.locator('[data-testid=commit-row].selected .head-label')).toHaveText('HEAD');
  // Locating a commit preserves the closed overview; inspecting it is explicit.
  await page.locator('[data-testid=commit-row].selected').click();
  await expect(page.locator('.commit-detail')).toContainText('相对空树');
  await expect(page.getByRole('button', { name: /定位 HEAD/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '分支操作', exact: true })).toHaveText('main');
  await page.getByRole('button', { name: '全部引用', exact: true }).click();
  await expect(page.locator('.history-loaded-count')).toHaveText('已加载 200 条提交');
  const first = page.locator('[data-testid=commit-row][data-row="0"]');
  await first.focus(); await first.press('End');
  const last = page.locator('[data-testid=commit-row][data-row="199"]');
  await expect(last).toBeFocused(); await expect(last).toHaveAttribute('aria-pressed', 'true');
  await expect(last).toBeInViewport();
  await last.press('ArrowUp');
  await expect(page.locator('[data-testid=commit-row][data-row="198"]')).toBeFocused();
  await expect(page.locator('[data-testid=commit-row][data-row="198"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-testid=commit-row][data-row="198"]')).toBeInViewport();
  await page.keyboard.press('Home');
  await expect(first).toBeFocused(); await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(first).toBeInViewport();
  await page.getByRole('button', { name: /继续加载 200 条/ }).click();
  await expect(page.locator('.history-loaded-count')).toHaveText('已加载 231 条提交');
  await expect(page.getByRole('button', { name: /继续加载 200 条/ })).toHaveCount(0);
  expect(await page.getByTestId('commit-row').count()).toBeLessThan(40);
});

test('locating HEAD runs once across refresh and history remount, and a new request still works', async ({ page }) => {
  // Switch only this disposable fixture so HEAD is present in the first history page.
  execFileSync('git', ['switch', 'side'], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  const ticket = await call({ action: 'ticket', sessionId });
  await page.goto(`${origin}/?session=${encodeURIComponent(sessionId)}#ticket=${encodeURIComponent(ticket.ticket as string)}`);
  await page.getByRole('navigation', { name: '主视图', exact: true }).getByRole('button', { name: '历史', exact: true }).click();
  await expect(page.locator('.history-loaded-count')).toHaveText('已加载 200 条提交');
  await page.getByRole('button', { name: /定位 HEAD/ }).click();
  await expect(page.locator('[data-testid=commit-row].selected .head-label')).toHaveText('HEAD');
  const scroll = page.getByTestId('history-scroll');
  await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBe(0);
  await scroll.evaluate(node => { node.scrollTop = 600; });
  await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBe(600);
  const refreshed = page.waitForResponse(response => response.url().endsWith('/api') && response.request().postDataJSON()?.action === 'history');
  await page.getByRole('button', { name: '刷新仓库', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
  await refreshed;
  await expect(page.locator('.history-read-state')).toHaveAttribute('data-phase', 'idle');
  // Observe beyond a smooth-scroll animation: a transient 600 must not count as preserved.
  await page.waitForTimeout(500);
  expect(await scroll.evaluate(node => node.scrollTop)).toBe(600);
  await page.getByRole('button', { name: /当前改动/ }).first().click();
  await page.getByRole('navigation', { name: '主视图', exact: true }).getByRole('button', { name: '历史', exact: true }).click();
  await page.waitForTimeout(500);
  expect(await scroll.evaluate(node => node.scrollTop)).toBe(600);
  await page.getByRole('button', { name: /定位 HEAD/ }).click();
  await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBe(0);
  await expect(page.locator('[data-testid=commit-row].selected .head-label')).toHaveText('HEAD');
});

test('a late initial overview cannot replace an explicitly requested history page', async ({ page }) => {
  let releaseOverview!: () => void; let releasePage!: () => void; let pageCaptured!: () => void;
  const overviewHold = new Promise<void>(resolve => { releaseOverview = resolve; });
  const pageHold = new Promise<void>(resolve => { releasePage = resolve; });
  const captured = new Promise<void>(resolve => { pageCaptured = resolve; });
  let firstOverview = true; let firstPage = true;
  await page.route(`${origin}/api`, async route => {
    const request = route.request().postDataJSON();
    if (request.action === 'overview' && firstOverview) {
      firstOverview = false; const response = await route.fetch(); await overviewHold;
      await route.fulfill({ response }).catch(() => undefined); return;
    }
    if (request.action === 'history' && request.cursor && firstPage) {
      firstPage = false; const response = await route.fetch(); pageCaptured(); await pageHold;
      await route.fulfill({ response }).catch(() => undefined); return;
    }
    await route.fallback();
  });
  try {
    const ticket = await call({ action: 'ticket', sessionId });
    await page.goto(`${origin}/?session=${encodeURIComponent(sessionId)}#ticket=${encodeURIComponent(ticket.ticket as string)}`);
    await page.getByRole('navigation', { name: '主视图', exact: true }).getByRole('button', { name: '历史', exact: true }).click();
    await expect(page.locator('.history-loaded-count')).toBeVisible();
    await expect(page.locator('.history-read-state')).toHaveAttribute('data-phase', 'idle');
    await page.getByRole('button', { name: '全部引用', exact: true }).click();
    await expect(page.locator('.history-loaded-count')).toHaveText('已加载 200 条提交');
    await page.getByRole('button', { name: /继续加载 200 条/ }).click(); await captured;
    releaseOverview(); await expect(page.locator('.overview-read-state')).toHaveAttribute('data-phase', 'idle');
    releasePage(); await expect(page.locator('.history-loaded-count')).toHaveText('已加载 231 条提交');
    await expect(page.locator('.history-read-state')).toHaveAttribute('data-phase', 'idle');
  } finally { releaseOverview(); releasePage(); }
});

test('unchanged focus leaves loaded history intact; full refresh retains pages and rejects a delayed page after changing scope', async ({ page }) => {
  const ticket = await call({ action: 'ticket', sessionId });
  await page.goto(`${origin}/?session=${encodeURIComponent(sessionId)}#ticket=${encodeURIComponent(ticket.ticket as string)}`);
  const historyTab = page.getByRole('navigation', { name: '主视图', exact: true }).getByRole('button', { name: '历史', exact: true });
  await historyTab.click();
  await page.getByRole('button', { name: '全部引用', exact: true }).click();
  await expect(page.locator('.history-loaded-count')).toHaveText('已加载 200 条提交');
  await page.getByRole('button', { name: /继续加载 200 条/ }).click();
  await expect(page.locator('.history-loaded-count')).toHaveText('已加载 231 条提交');
  const scroll = page.getByTestId('history-scroll');
  const deepTop = 200 * await page.getByTestId('commit-row').first().evaluate(node => node.getBoundingClientRect().height);
  await scroll.evaluate((node, top) => { node.scrollTop = top; }, deepTop);
  await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBe(deepTop);

  let release!: () => void;
  let hold = new Promise<void>(resolve => { release = resolve; });
  let firstPagesDelivered = 0; let secondPagesHeld = 0; let secondPagesDelivered = 0;
  await page.route(`${origin}/api`, async route => {
    const request = route.request().postDataJSON();
    if (request.action !== 'history' || request.scope !== 'all') { await route.continue(); return; }
    // Delay real Git responses only; every page and read stamp comes from the running server.
    const response = await route.fetch();
    if (request.cursor) {
      const pending = hold; secondPagesHeld++;
      await pending;
      await route.fulfill({ response }).catch(() => undefined);
      secondPagesDelivered++;
    } else {
      await route.fulfill({ response });
      firstPagesDelivered++;
    }
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.waitForTimeout(1000);
    expect(firstPagesDelivered).toBe(0); expect(secondPagesHeld).toBe(0);
    await expect(page.locator('.history-loaded-count')).toHaveText('已加载 231 条提交'); expect(await scroll.evaluate(node => node.scrollTop)).toBe(deepTop);
    await page.getByRole('button', { name: '刷新仓库', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
    await expect.poll(() => firstPagesDelivered).toBe(1);
    await expect.poll(async () => secondPagesHeld > 0 || await page.locator('.history-read-state').getAttribute('data-phase') === 'idle').toBe(true);
    await expect(page.locator('.history-loaded-count')).toHaveText('已加载 231 条提交');
    expect(secondPagesHeld).toBe(1);
    await expect(page.locator('.history-read-state')).toHaveAttribute('data-phase', 'loading');
    expect(await scroll.evaluate(node => node.scrollTop)).toBe(deepTop);
    release();
    await expect(page.locator('.history-read-state')).toHaveAttribute('data-phase', 'idle');
    await expect(page.locator('.history-loaded-count')).toHaveText('已加载 231 条提交');
    expect(await scroll.evaluate(node => node.scrollTop)).toBe(deepTop);

    hold = new Promise<void>(resolve => { release = resolve; });
    await page.getByRole('button', { name: '刷新仓库', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
    await expect.poll(() => secondPagesHeld).toBe(2);
    await page.getByTestId('navigation-ref').filter({ hasText: /^(?:● )?main/ }).click();
    await expect(page.locator('.history-range-label')).toContainText('main');
    await expect(page.getByTestId('commit-row')).toHaveCount(1);
    await expect(page.getByTestId('commit-row')).toContainText('历史提交 1');
    release();
    await expect.poll(() => secondPagesDelivered).toBe(2);
    await page.waitForTimeout(100);
    await expect(page.locator('.history-range-label')).toContainText('main');
    await expect(page.getByTestId('commit-row')).toHaveCount(1);
    expect(await scroll.evaluate(node => node.scrollTop)).toBe(0);
  } finally { release(); }
});
