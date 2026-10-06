import { type Page, type Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let folder: string; let repo: string; let origin: string; let token: string; let sessionId: string;
function git(...args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_AUTHOR_NAME: 'Feedback Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Feedback Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
}
async function call(action: Record<string, unknown>) {
  const response = await fetch(`${origin}/api`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...action }) });
  const result = await response.json() as { ok: boolean; data: Record<string, unknown> };
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.data;
}
const contents = (version: string) => Array.from({ length: 160 }, (_, index) => `${version} line ${index + 1} ${'wide content '.repeat(50)}`).join('\n') + '\n';
const feedback = (page: Page, scope: string) => page.locator(`.read-feedback[data-scope="${scope}"]`);
const refresh = (page: Page) => page.getByRole('button', { name: '刷新仓库', exact: true }).evaluate(node => (node as HTMLButtonElement).click());

async function open(page: Page, history = false) {
  const ticket = await call({ action: 'ticket', sessionId });
  await page.goto(`${origin}/?session=${sessionId}#ticket=${ticket.ticket}`);
  await expect(page.locator('.code-scroll')).toContainText('+working-a.txt');
  if (history) {
    await page.getByRole('button', { name: /提交历史/ }).first().click();
    await page.locator('.commit-row').filter({ hasText: 'feedback changes' }).click();
    await expect(page.locator('.code-scroll')).toContainText('+committed-a.txt');
  }
  await expect(feedback(page, '仓库状态')).toHaveAttribute('data-phase', 'idle');
  await expect(feedback(page, '文件差异')).toHaveAttribute('data-phase', 'idle');
}

test.beforeAll(async () => {
  // All Git writes are confined to this newly created disposable repository.
  // Delayed and failed reads below still start with responses from its real server.
  folder = await mkdtemp(join(tmpdir(), 'git-view-feedback-')); repo = join(folder, 'repository'); await mkdir(repo);
  git('init', '-b', 'main');
  for (const path of ['a.txt', 'b.txt']) await writeFile(join(repo, path), contents(`base-${path}`));
  git('add', '--', 'a.txt', 'b.txt'); git('commit', '-m', 'feedback baseline');
  for (const path of ['a.txt', 'b.txt']) await writeFile(join(repo, path), contents(`committed-${path}`));
  git('add', '--', 'a.txt', 'b.txt'); git('commit', '-m', 'feedback changes');
  for (const path of ['a.txt', 'b.txt']) await writeFile(join(repo, path), contents(`working-${path}`));
  const runtime = join(folder, 'runtime');
  execFileSync(process.execPath, [resolve('dist/cli.mjs'), 'open', '--repo', repo, '--no-browser', '--json'], { encoding: 'utf8', env: { ...process.env, GIT_VIEW_HOME: runtime } });
  const record = JSON.parse(await readFile(join(runtime, 'instance.json'), 'utf8'));
  origin = `http://127.0.0.1:${record.port}`; token = record.cliToken;
  sessionId = (await call({ action: 'open', path: repo })).sessionId as string;
});
test.afterAll(async () => { if (origin) await call({ action: 'shutdown' }).catch(() => {}); if (folder) await rm(folder, { recursive: true, force: true }); });

type ResponseChange = 'success' | 'error' | 'wrong-stamp' | 'late-content' | 'stale';
async function holdNext(page: Page, action: string, failureMessage = `fixture ${action} failed`) {
  let release!: (change: ResponseChange) => void; let started!: () => void;
  const barrier = new Promise<ResponseChange>(resolve => { release = resolve; });
  const pending = new Promise<void>(resolve => { started = resolve; });
  let intercepted = false; let delivered = false;
  const handler = async (route: Route) => {
    if (intercepted || route.request().postDataJSON()?.action !== action) return route.fallback();
    intercepted = true;
    const response = await route.fetch();
    const body = await response.json();
    started(); const change = await barrier;
    let json = body;
    if (change === 'error') json = { schemaVersion: 1, ok: false, stamp: body.stamp, requestId: route.request().postDataJSON().requestId, finishedAt: body.stamp.finishedAt, error: { code: 'INTERNAL_ERROR', message: failureMessage, retryable: true } };
    if (change === 'stale') json = { schemaVersion: 1, ok: false, stamp: body.stamp, requestId: route.request().postDataJSON().requestId, finishedAt: body.stamp.finishedAt, error: { code: 'STALE_RESULT', message: 'fixture comparison changed', retryable: true } };
    if (change === 'wrong-stamp') json = { ...body, stamp: { ...body.stamp, generation: body.stamp.generation + 1 } };
    if (change === 'late-content') json = { ...body, data: { ...body.data, text: '@@ -1 +1 @@\n-obsolete\n+LATE VALUE MUST NOT APPEAR\n' } };
    await route.fulfill({ response, json }).catch(() => undefined);
    delivered = true;
  };
  await page.route('**/api', handler);
  return { pending, release: () => release('success'), finish: async (change: ResponseChange = 'success') => {
    release(change); await expect.poll(() => delivered).toBe(true); await page.unroute('**/api', handler);
  } };
}
async function ignoreTransportAbort(page: Page) {
  // A host may finish work after cancellation. Removing only the test transport's
  // abort signal proves request identity rejects actual late successes/errors.
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => original(input, init?.signal ? { ...init, signal: undefined } : init);
  });
}
async function readingState(page: Page) {
  return page.evaluate(() => {
    const code = document.querySelector<HTMLElement>('.code-scroll');
    const bounds = code?.getBoundingClientRect();
    return { pageY: scrollY, top: code?.scrollTop, left: code?.scrollLeft, bounds: bounds && { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, retained: code?.dataset.feedbackProbe === 'original', metadata: document.querySelector<HTMLDetailsElement>('.commit-metadata')?.open, files: document.querySelector<HTMLDetailsElement>('.commit-files')?.open };
  });
}
async function prepareScroll(page: Page) {
  await page.getByRole('button', { name: '并排', exact: true }).click(); await page.getByLabel('自动折行').uncheck();
  await page.locator('.code-scroll').evaluate(node => { const el = node as HTMLElement; el.dataset.feedbackProbe = 'original'; el.scrollTop = 620; el.scrollLeft = 180; });
  await page.evaluate(() => scrollTo(0, Math.max(0, document.documentElement.scrollHeight - innerHeight - 30)));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('fast refresh keeps a stable refresh action and avoids extra banners or cancel controls', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 760 }); await open(page); await prepareScroll(page);
  const before = await readingState(page);
  const hold = await holdNext(page, 'change');
  try {
    await refresh(page); await hold.pending;
    await expect(page.getByRole('button', { name: '刷新仓库', exact: true })).toBeVisible();
    await expect(feedback(page, '文件差异')).toHaveAttribute('data-phase', 'loading');
    await expect(feedback(page, '文件差异')).toHaveAttribute('data-slow', 'false');
    await expect(page.getByRole('button', { name: '取消文件差异读取', exact: true })).toHaveCount(0);
    await expect(page.locator('.info-banner')).toHaveCount(0);
    expect(await readingState(page)).toEqual(before);
    await hold.finish();
    await expect(feedback(page, '文件差异')).toHaveAttribute('data-phase', 'idle');
    await expect(page.getByRole('alert')).toHaveCount(0); await expect(page.locator('.info-banner')).toHaveCount(0);
    expect(await readingState(page)).toEqual(before);
  } finally { hold.release(); }
});

test('slow feedback preserves live reading, neutral cancellation clears queued focus refresh, and late success cannot revive it', async ({ page }) => {
  await ignoreTransportAbort(page);
  await page.setViewportSize({ width: 1180, height: 760 }); await open(page); await prepareScroll(page);
  // Keep Date fixed while real timers run: focus deterministically enters the
  // refresh throttle queue even after the separate 800 ms slow-read timer fires.
  await page.clock.setFixedTime(new Date());
  const actions: string[] = []; page.on('request', request => { if (request.url().endsWith('/api')) actions.push(request.postDataJSON()?.action); });
  const hold = await holdNext(page, 'change');
  try {
    await refresh(page); await hold.pending;
    const filter = page.getByLabel('筛选当前改动文件', { exact: true });
    await filter.evaluate(node => (node as HTMLElement).focus({ preventScroll: true }));
    const before = await readingState(page);
    await expect(feedback(page, '文件差异')).toHaveAttribute('data-slow', 'true');
    await expect(page.getByRole('button', { name: '取消文件差异读取', exact: true })).toBeVisible();
    await expect(filter).toBeFocused(); expect(await readingState(page)).toEqual(before);
    await expect(page.getByRole('button', { name: '刷新仓库', exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/round3-slow-read.png', fullPage: true });
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      (document.querySelector('[aria-label="取消文件差异读取"]') as HTMLButtonElement).click();
    });
    await expect(feedback(page, '文件差异')).toHaveAttribute('data-phase', 'cancelled');
    await expect(feedback(page, '文件差异').getByRole('status')).toContainText('取消');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重新读取文件差异', exact: true })).toBeVisible();
    expect(await readingState(page)).toEqual(before); await expect(filter).toBeFocused();
    const count = actions.filter(action => action === 'overview').length;
    await hold.finish('late-content');
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(950);
    expect(actions.filter(action => action === 'overview')).toHaveLength(count);
    await expect(feedback(page, '文件差异')).toHaveAttribute('data-phase', 'cancelled');
    await expect(page.locator('.code-scroll')).toContainText('+working-a.txt');
    await expect(page.locator('.code-scroll')).not.toContainText('LATE VALUE');
    await page.screenshot({ path: 'test-results/round3-cancelled-read.png', fullPage: true });
    await refresh(page);
    await expect(feedback(page, '文件差异')).toHaveAttribute('data-phase', 'idle');
    expect(actions.filter(action => action === 'overview').length).toBeGreaterThan(count);
    expect(await readingState(page)).toEqual(before); await expect(filter).toBeFocused();
  } finally { hold.release(); }
});

for (const interrupted of ['error', 'cancelled'] as const) {
  test(`overview ${interrupted} keeps old diff recoverable through its own feedback`, async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 760 }); await open(page); await prepareScroll(page);
    const before = await readingState(page); const failed = await holdNext(page, 'overview');
    try {
      await refresh(page); await failed.pending;
      if (interrupted === 'error') await failed.finish('error');
      else {
        await page.getByRole('button', { name: '取消仓库状态读取', exact: true }).evaluate(node => (node as HTMLButtonElement).click());
        await failed.finish();
      }
      await expect(feedback(page, '仓库状态')).toHaveAttribute('data-phase', interrupted);
      await expect(page.locator('.code-scroll')).toContainText('+working-a.txt');
      expect(await readingState(page)).toEqual(before);
      const retry = await holdNext(page, 'overview');
      try {
        await feedback(page, '文件差异').getByRole('button', { name: /重试文件差异读取|重新读取文件差异/ }).evaluate(node => (node as HTMLButtonElement).click());
        await retry.pending;
        expect(await readingState(page)).toEqual(before);
        await retry.finish();
        await expect(feedback(page, '仓库状态')).toHaveAttribute('data-phase', 'idle');
        await expect(feedback(page, '文件差异')).toHaveAttribute('data-phase', 'idle');
        expect(await readingState(page)).toEqual(before);
        await expect(page.locator('.group-unstaged .file-row[aria-pressed="true"]')).toContainText('a.txt');
      } finally { retry.release(); }
    } finally { failed.release(); }
  });
}

for (const interrupted of ['error', 'cancelled'] as const) {
  test(`commit ${interrupted} and dependent diff retry preserve selected file, disclosures and exact scroll`, async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 760 }); await open(page, true);
  await page.locator('.commit-files .file-row').filter({ hasText: 'b.txt' }).click();
  await expect(page.locator('.code-scroll')).toContainText('+committed-b.txt');
  await page.locator('.commit-metadata summary').click(); await page.locator('.commit-files summary').click();
  await prepareScroll(page); const before = await readingState(page);
  expect(before.top).toBe(620); expect(before.left).toBe(180); expect(before.metadata).toBe(true); expect(before.files).toBe(false);
  const failed = await holdNext(page, 'commit');
  try {
    await refresh(page); await failed.pending;
    await expect(feedback(page, '提交详情')).toHaveAttribute('data-slow', 'true');
    expect(await readingState(page)).toEqual(before);
    if (interrupted === 'error') {
      await failed.finish('error');
      await expect(feedback(page, '提交详情').getByRole('alert')).toContainText('fixture commit failed');
    } else {
      await page.getByRole('button', { name: '取消提交详情读取', exact: true }).evaluate(node => (node as HTMLButtonElement).click());
      await failed.finish();
      await expect(feedback(page, '提交详情').getByRole('status')).toContainText('取消');
      await expect(page.getByRole('alert')).toHaveCount(0);
    }
    await expect(feedback(page, '提交详情')).toHaveAttribute('data-phase', interrupted);
    expect(await readingState(page)).toEqual(before);
    const retry = await holdNext(page, 'commit');
    try {
      await feedback(page, '文件差异').getByRole('button', { name: /重试文件差异读取|重新读取文件差异/ }).evaluate(node => (node as HTMLButtonElement).click());
      await retry.pending; expect(await readingState(page)).toEqual(before);
      await retry.finish();
      await expect(feedback(page, '提交详情')).toHaveAttribute('data-phase', 'idle');
      await expect(feedback(page, '文件差异')).toHaveAttribute('data-phase', 'idle');
      await expect(page.locator('.diff-header h2')).toHaveText('b.txt');
      await expect(page.locator('.code-scroll')).toContainText('+committed-b.txt');
      expect(await readingState(page)).toEqual(before);
      await expect(page.locator('.commit-files .file-row[aria-pressed="true"]')).toContainText('b.txt');
    } finally { retry.release(); }
  } finally { failed.release(); }
  });
}

for (const target of [{ action: 'change', scope: '文件差异' }, { action: 'history', scope: '提交历史' }]) {
  test(`${target.action}: a mismatched current response stamp stops loading, retains old data and can be retried`, async ({ page }) => {
    await open(page, target.action === 'history');
    const originalRows = await page.locator('.commit-row').allTextContents();
    const hold = await holdNext(page, target.action);
    try {
      await refresh(page); await hold.pending; await hold.finish('wrong-stamp');
      const area = feedback(page, target.scope);
      await expect(area).toHaveAttribute('data-phase', 'error');
      await expect(area.getByRole('alert')).toContainText('身份不匹配');
      await expect(area.getByRole('button', { name: `取消${target.scope}读取`, exact: true })).toHaveCount(0);
      await expect(page.locator('.code-scroll')).toContainText(target.action === 'history' ? '+committed-a.txt' : '+working-a.txt');
      if (target.action === 'history') expect(await page.locator('.commit-row').allTextContents()).toEqual(originalRows);
      await area.getByRole('button', { name: `重试${target.scope}读取`, exact: true }).click();
      await expect(area).toHaveAttribute('data-phase', 'idle');
      await expect(area.getByRole('alert')).toHaveCount(0);
    } finally { hold.release(); }
  });
}

test('an older failed file request cannot change a newer successful selection or its feedback', async ({ page }) => {
  await ignoreTransportAbort(page); await open(page);
  const hold = await holdNext(page, 'change');
  try {
    await page.locator('.group-unstaged .file-row').filter({ hasText: 'b.txt' }).click(); await hold.pending;
    await page.locator('.group-unstaged .file-row').filter({ hasText: 'a.txt' }).click();
    await expect(page.locator('.code-scroll')).toContainText('+working-a.txt');
    await expect(feedback(page, '文件差异')).toHaveAttribute('data-phase', 'idle');
    await hold.finish('error'); await page.waitForTimeout(100);
    await expect(page.locator('.diff-header h2')).toHaveText('a.txt');
    await expect(feedback(page, '文件差异')).toHaveAttribute('data-phase', 'idle');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.group-unstaged .file-row[aria-pressed="true"]')).toContainText('a.txt');
  } finally { hold.release(); }
});


test('a genuinely new filesystem invalidation resumes a cancelled read without a focus event', async ({ page }) => {
  await open(page);
  const hold = await holdNext(page, 'change');
  try {
    await refresh(page); await hold.pending;
    await page.getByRole('button', { name: '取消文件差异读取', exact: true }).click();
    await expect(feedback(page, '文件差异')).toHaveAttribute('data-phase', 'cancelled');
    await hold.finish();
    await writeFile(join(repo, 'a.txt'), contents('external-after-cancel'));
    await expect(page.locator('.code-scroll')).toContainText('+external-after-cancel', { timeout: 10000 });
    await expect(feedback(page, '文件差异')).toHaveAttribute('data-phase', 'idle');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.info-banner')).toHaveCount(0);
  } finally { hold.release(); await writeFile(join(repo, 'a.txt'), contents('working-a.txt')); }
});

test('automatic stale comparison recovery clears its feedback without a persistent process banner', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 760 }); await open(page); await prepareScroll(page);
  await page.evaluate(() => {
    const probe = window as Window & { staleAlerts?: string[] }; probe.staleAlerts = [];
    new MutationObserver(() => {
      for (const alert of document.querySelectorAll('[role="alert"]')) if (alert.textContent?.includes('fixture comparison changed')) probe.staleAlerts!.push(alert.textContent);
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  const before = await readingState(page);
  const hold = await holdNext(page, 'change');
  try {
    await refresh(page); await hold.pending; await hold.finish('stale');
    await expect(feedback(page, '文件差异')).toHaveAttribute('data-phase', 'idle');
    await expect(page.locator('.code-scroll')).toContainText('+working-a.txt');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.info-banner')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: /重新读取概览|发起新一轮读取/ })).toHaveCount(0);
    expect(await page.evaluate(() => (window as Window & { staleAlerts?: string[] }).staleAlerts)).toEqual([]);
    expect(await readingState(page)).toEqual(before);
  } finally { hold.release(); }
});

test('a cleared file selection has no synthetic diff read or cancel while its overview is slow', async ({ page }) => {
  await open(page);
  const filter = page.getByLabel('筛选当前改动文件', { exact: true });
  await filter.fill('no-matching-file');
  await expect(page.locator('.code-scroll')).toHaveCount(0);
  await expect(page.locator('.file-row[aria-pressed="true"]')).toHaveCount(0);
  const hold = await holdNext(page, 'overview');
  try {
    await refresh(page); await hold.pending;
    await expect(feedback(page, '仓库状态')).toHaveAttribute('data-slow', 'true');
    await expect(feedback(page, '文件差异')).toHaveAttribute('data-phase', 'idle');
    await expect(page.getByRole('button', { name: '取消文件差异读取', exact: true })).toHaveCount(0);
    await expect(page.getByRole('status', { name: /正在读取.*文件差异/ })).toHaveCount(0);
    await expect(filter).toBeFocused();
    await hold.finish();
    await expect(page.locator('.code-scroll')).toHaveCount(0);
    await expect(feedback(page, '文件差异')).toHaveAttribute('data-phase', 'idle');
  } finally { hold.release(); }
});

test('a compact navigation error is fully readable by keyboard without moving its action or the reading layout', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 760 }); await open(page);
  const area = feedback(page, '引用');
  const before = await readingState(page); const slotBefore = await area.boundingBox();
  const longError = `引用读取失败：${'这是必须能够逐行查看的完整错误详情，包含出错位置和重新读取的上下文。'.repeat(16)}详情结束。`;
  const hold = await holdNext(page, 'navigation', longError);
  try {
    await refresh(page); await hold.pending; await hold.finish('error');
    await expect(area).toHaveAttribute('data-phase', 'error');
    const message = area.getByRole('alert');
    const retry = area.getByRole('button', { name: '重试引用读取', exact: true });
    const actionBefore = await retry.boundingBox();
    expect(actionBefore).not.toBeNull(); expect(slotBefore).not.toBeNull();
    expect(actionBefore!.x).toBeGreaterThanOrEqual(slotBefore!.x);
    expect(actionBefore!.x + actionBefore!.width).toBeLessThanOrEqual(slotBefore!.x + slotBefore!.width + 1);
    expect(await area.boundingBox()).toEqual(slotBefore); expect(await readingState(page)).toEqual(before);
    await retry.focus(); await page.keyboard.press('Shift+Tab');
    await expect(message).toBeFocused(); await expect(message).toContainText(longError);
    await expect(message).toHaveCSS('white-space', 'normal');
    expect(await message.evaluate(node => node.clientHeight)).toBeGreaterThan(24);
    expect(await message.evaluate(node => node.scrollHeight)).toBeGreaterThan(await message.evaluate(node => node.clientHeight));
    await page.keyboard.press('PageDown');
    await expect.poll(() => message.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    expect(await area.boundingBox()).toEqual(slotBefore); expect(await retry.boundingBox()).toEqual(actionBefore);
    expect(await readingState(page)).toEqual(before);
    await page.keyboard.press('Tab'); await expect(retry).toBeFocused();
    await expect(message).toHaveCSS('white-space', 'nowrap');
    await retry.click(); await expect(area).toHaveAttribute('data-phase', 'idle');
    expect(await readingState(page)).toEqual(before);
  } finally { hold.release(); }
});
