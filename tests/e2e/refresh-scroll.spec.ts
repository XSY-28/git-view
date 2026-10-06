import { test, expect, type Page, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let folder: string; let repo: string; let origin: string; let token: string; let sessionId: string;
function git(...args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_AUTHOR_NAME: 'Scroll Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Scroll Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
}
async function call(action: Record<string, unknown>) {
  const response = await fetch(`${origin}/api`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...action }) });
  const result = await response.json() as { ok: boolean; data: Record<string, unknown> };
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.data;
}
const contents = (version: string) => Array.from({ length: 160 }, (_, i) => `${version} line ${i + 1} ${'long content '.repeat(50)}`).join('\n') + '\n';

test.beforeAll(async () => {
  // Git writes stay inside this new disposable fixture. Both views use real diffs.
  folder = await mkdtemp(join(tmpdir(), 'git-view-refresh-scroll-')); repo = join(folder, 'repository'); await mkdir(repo);
  git('init', '-b', 'main');
  for (const path of ['a.txt', 'b.txt']) await writeFile(join(repo, path), contents(`base-${path}`));
  git('add', '--', 'a.txt', 'b.txt'); git('commit', '-m', 'scroll baseline');
  for (const path of ['a.txt', 'b.txt']) await writeFile(join(repo, path), contents(`committed-${path}`));
  git('add', '--', 'a.txt', 'b.txt'); git('commit', '-m', 'long comparisons');
  for (const path of ['a.txt', 'b.txt']) await writeFile(join(repo, path), contents(`working-${path}`));
  const runtime = join(folder, 'runtime');
  execFileSync(process.execPath, [resolve('dist/cli.mjs'), 'open', '--repo', repo, '--no-browser', '--json'], { encoding: 'utf8', env: { ...process.env, GIT_VIEW_HOME: runtime } });
  const record = JSON.parse(await readFile(join(runtime, 'instance.json'), 'utf8'));
  origin = `http://127.0.0.1:${record.port}`; token = record.cliToken;
  sessionId = (await call({ action: 'open', path: repo })).sessionId as string;
});
test.afterAll(async () => { if (origin) await call({ action: 'shutdown' }).catch(() => {}); if (folder) await rm(folder, { recursive: true, force: true }); });

// Hold the real response, so assertions cover the loading interval rather than
// merely observing a final restored position after the page already jumped.
async function holdNext(page: Page, action: string) {
  let release!: (fail?: boolean) => void; let started!: () => void;
  const barrier = new Promise<boolean | undefined>(resolve => { release = resolve; });
  const pending = new Promise<void>(resolve => { started = resolve; });
  let intercepted = false;
  const handler = async (route: Route) => {
    if (intercepted || route.request().postDataJSON()?.action !== action) return route.fallback();
    intercepted = true;
    const response = await route.fetch();
    started();
    const fail = await barrier;
    if (fail) {
      const body = await response.json();
      await route.fulfill({ response, json: { schemaVersion: 1, ok: false, stamp: body.stamp, requestId: route.request().postDataJSON().requestId, finishedAt: body.stamp.finishedAt, error: { code: 'INTERNAL_ERROR', message: 'fixture refresh failed', retryable: true } } });
    } else await route.fulfill({ response });
  };
  await page.route('**/api', handler);
  return { pending, release, finish: async (fail = false) => {
    const completed = page.waitForResponse(response => response.url().endsWith('/api') && response.request().postDataJSON()?.action === action);
    release(fail); await completed; await page.unroute('**/api', handler);
  } };
}
async function scrollState(page: Page, disclosure: string) {
  return page.evaluate(selector => {
    const code = document.querySelector<HTMLElement>('.code-scroll');
    return { pageY: window.scrollY, top: code?.scrollTop, left: code?.scrollLeft, retained: code?.dataset.scrollProbe === 'original', collapsed: !document.querySelector<HTMLDetailsElement>(selector)?.open };
  }, disclosure);
}
async function moveDown(page: Page, top: number, left: number, pageDelta = 0) {
  await page.locator('.code-scroll').evaluate((node, point) => { node.scrollTop = point.top; node.scrollLeft = point.left; }, { top, left });
  await page.evaluate(delta => window.scrollTo(0, document.documentElement.scrollHeight - innerHeight - 30 + delta), pageDelta);
  // Let native scroll events and scroll anchoring settle before taking a baseline.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const view of ['changes', 'history'] as const) {
  test(`${view}: focus/manual refresh retain live scroll and disclosure state; failed refresh and file changes remain correct`, async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 760 });
    const ticket = await call({ action: 'ticket', sessionId });
    await page.goto(`${origin}/?session=${sessionId}#ticket=${ticket.ticket}`);
    if (view === 'history') {
      await page.getByRole('button', { name: /提交历史/ }).first().click();
      await page.locator('.commit-row').first().click();
    }
    await expect(page.locator('.diff-header h2')).toHaveText('a.txt');
    await page.getByRole('button', { name: '并排', exact: true }).click();
    await page.getByLabel('自动折行').uncheck();
    const disclosure = view === 'history' ? '.commit-files' : '.group-staged';
    await page.locator(`${disclosure} summary`).click();
    await page.locator('.code-scroll').evaluate(node => { (node as HTMLElement).dataset.scrollProbe = 'original'; });
    await moveDown(page, 620, 180);
    const original = await scrollState(page, disclosure);
    // The compact layout needs less page scrolling; any nonzero offset still
    // exercises the same exact scroll-preservation assertions below.
    expect(original.pageY).toBeGreaterThan(0); expect(original.top).toBe(620); expect(original.left).toBe(180); expect(original.collapsed).toBe(true);
    const action = view === 'history' ? 'commit-change' : 'change';

    const focus = await holdNext(page, action);
    try {
      await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
      await focus.pending;
      expect(await scrollState(page, disclosure)).toEqual(original);
      await focus.finish();
      await expect(page.locator('.detail-panel [role="status"]').filter({ hasText: '正在' })).toHaveCount(0);
      expect(await scrollState(page, disclosure)).toEqual(original);
    } finally { focus.release(); }

    const manual = await holdNext(page, action);
    try {
      // Native activation avoids Playwright scrolling the off-screen refresh
      // button into view, which would change the position we are testing.
      await page.getByRole('button', { name: '刷新仓库', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
      await manual.pending;
      expect(await scrollState(page, disclosure)).toEqual(original);
      await moveDown(page, 910, 260, -45);
      const movedDuringRefresh = await scrollState(page, disclosure);
      await manual.finish();
      await expect(page.locator('.detail-panel [role="status"]').filter({ hasText: '正在' })).toHaveCount(0);
      expect(await scrollState(page, disclosure)).toEqual(movedDuringRefresh);
    } finally { manual.release(); }

    const beforeFailure = await scrollState(page, disclosure);
    const failed = await holdNext(page, action);
    try {
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await failed.pending;
      expect(await scrollState(page, disclosure)).toEqual(beforeFailure);
      await failed.finish(true);
      await expect(page.getByRole('alert')).toContainText('fixture refresh failed');
      expect(await scrollState(page, disclosure)).toEqual(beforeFailure);
    } finally { failed.release(); }

    const retry = await holdNext(page, action);
    try {
      await page.locator('.detail-panel').getByRole('button', { name: '重试文件差异读取', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
      await retry.pending;
      expect(await scrollState(page, disclosure)).toEqual(beforeFailure);
      await retry.finish();
      await expect(page.locator('.detail-panel [role="status"]').filter({ hasText: '正在' })).toHaveCount(0);
      await expect(page.locator('.detail-panel [role="alert"]')).toHaveCount(0);
      expect(await scrollState(page, disclosure)).toEqual(beforeFailure);
    } finally { retry.release(); }

    // Keeping old content is valid only for the same comparison. Switching to
    // another file must not mislabel the old diff while its request is pending.
    if (view === 'history') await page.locator('.commit-files summary').click();
    const next = await holdNext(page, action);
    try {
      const group = view === 'history' ? '.commit-files' : '.group-unstaged';
      await page.locator(`${group} .file-row`).filter({ hasText: 'b.txt' }).click();
      await next.pending;
      await expect(page.locator('.code-scroll')).toHaveCount(0);
      await next.finish();
      await expect(page.locator('.diff-header h2')).toHaveText('b.txt');
      const other = await scrollState(page, disclosure);
      expect(other.retained).toBe(false); expect(other.top).toBe(0); expect(other.left).toBe(0);
      await expect(page.locator('.code-scroll')).toContainText(view === 'history' ? '+committed-b.txt' : '+working-b.txt');
    } finally { next.release(); }
  });
}
