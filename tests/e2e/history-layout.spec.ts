import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let folder: string; let repo: string; let origin: string; let token: string; let sessionId: string;
async function call(action: Record<string, unknown>) {
  const response = await fetch(`${origin}/api`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...action }) });
  const result = await response.json() as { ok: boolean; data: Record<string, unknown> };
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.data;
}
const row = (page: Page, index: number) => page.locator(`.commit-row[data-row="${index}"]`);
const workspace = (page: Page) => page.locator('.history-workspace');
const separator = (page: Page) => page.getByRole('separator', { name: '调整历史与详情宽度', exact: true });
async function snapshot() { return Promise.all(['HEAD', 'index'].map(name => readFile(join(repo, '.git', name)))); }
async function openHistory(page: Page) {
  const ticket = await call({ action: 'ticket', sessionId });
  await page.goto(`${origin}/?session=${encodeURIComponent(sessionId)}#ticket=${encodeURIComponent(ticket.ticket as string)}`);
  await page.getByRole('button', { name: /提交历史/ }).first().click();
  await expect(page.getByRole('button', { name: /提交历史/ }).first()).toContainText('200');
  await expect(row(page, 0)).toContainText('layout commit 240');
}
async function scrollToRow(page: Page, index: number) {
  const rowHeight = await page.locator('.commit-row').first().evaluate(node => node.getBoundingClientRect().height);
  const top = index * rowHeight;
  await page.locator('.history-scroll').evaluate((node, top) => { node.scrollTop = top; }, top);
  await expect.poll(() => page.locator('.history-scroll').evaluate(node => node.scrollTop)).toBe(top);
  await expect(row(page, index)).toBeInViewport();
  return top;
}
async function expectClosed(page: Page) {
  await expect(workspace(page)).toHaveAttribute('data-details', 'closed');
  await expect(page.locator('.detail-panel')).toBeHidden();
  await expect(separator(page)).toBeHidden();
}
async function expectOpen(page: Page) {
  await expect(workspace(page)).toHaveAttribute('data-details', 'open');
  await expect(page.locator('.detail-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: '关闭提交详情', exact: true })).toBeVisible();
}
async function expectFullWidth(page: Page) {
  await expectClosed(page);
  const rectangles = await workspace(page).evaluate(node => {
    const shell = node.getBoundingClientRect(); const list = node.querySelector('.list-panel')!.getBoundingClientRect();
    return { leftGap: list.left - shell.left, rightGap: shell.right - list.right };
  });
  expect(Math.abs(rectangles.leftGap)).toBeLessThanOrEqual(2);
  expect(Math.abs(rectangles.rightGap)).toBeLessThanOrEqual(2);
}
async function paneWidths(page: Page) {
  return workspace(page).evaluate(node => {
    const list = node.querySelector('.list-panel')!.getBoundingClientRect();
    const detail = node.querySelector('.detail-panel')!.getBoundingClientRect();
    const divider = node.querySelector('[role="separator"]')!.getBoundingClientRect();
    const shell = node.getBoundingClientRect();
    return { history: list.width, detail: detail.width, overlaps: list.right > divider.left + 1 || divider.right > detail.left + 1, overflow: list.left < shell.left - 1 || detail.right > shell.right + 1 };
  });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function rendered(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }

test.beforeAll(async () => {
  // Every Git write is confined to this disposable fixture. Each commit changes
  // a file, so delayed commit and commit-change responses are both real reads.
  folder = await mkdtemp(join(tmpdir(), 'git-view-history-layout-')); repo = join(folder, 'layout-repository'); await mkdir(repo);
  const git = (args: string[], input?: string) => execFileSync('git', args, { cwd: repo, input, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull } });
  git(['init', '-b', 'main']);
  let stream = '';
  for (let index = 1; index <= 240; index++) {
    const subject = `layout commit ${index}`; const content = `version ${index}\n`;
    stream += `commit refs/heads/main\ncommitter Layout Fixture <test@example.invalid> ${1700000000 + index} +0000\ndata ${Buffer.byteLength(subject)}\n${subject}\nM 100644 inline file.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`;
  }
  git(['fast-import', '--quiet'], stream); git(['reset', '--hard', 'main']);
  const runtime = join(folder, 'runtime');
  execFileSync(process.execPath, [resolve('dist/cli.mjs'), 'open', '--repo', repo, '--no-browser', '--json'], { encoding: 'utf8', env: { ...process.env, GIT_VIEW_HOME: runtime } });
  const record = JSON.parse(await readFile(join(runtime, 'instance.json'), 'utf8')) as { port: number; cliToken: string };
  origin = `http://127.0.0.1:${record.port}`; token = record.cliToken;
  sessionId = (await call({ action: 'open', path: repo })).sessionId as string;
});
test.afterAll(async () => { if (origin) await call({ action: 'shutdown' }).catch(() => {}); if (folder) await rm(folder, { recursive: true, force: true }); });

test('history starts full width and explicit details preserve selection and scroll across close and keyboard navigation', async ({ page }, testInfo) => {
  const before = await snapshot(); await openHistory(page);
  await expectFullWidth(page);
  const top = await scrollToRow(page, 40);
  await expect(page.locator('.history-read-state .spinner')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('history-full-width.png'), fullPage: true });
  await row(page, 40).click(); await expectOpen(page);
  await expect(page.locator('.commit-detail')).toContainText('layout commit 200');
  await expect(page.locator('.code-scroll')).toContainText('+version 200');
  await expect(separator(page)).toBeVisible();
  await expect(row(page, 40)).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('history-with-details.png'), fullPage: true });

  await page.getByRole('button', { name: '关闭提交详情', exact: true }).click();
  await expectFullWidth(page);
  await expect(row(page, 40)).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('.history-scroll').evaluate(node => node.scrollTop)).toBe(top);
  // The header control is outside the history workspace and disappears once
  // clicked. Escape must still close details after focus leaves that subtree.
  await page.getByRole('button', { name: '查看提交详情', exact: true }).click();
  await expectOpen(page);
  await page.keyboard.press('Escape'); await expectFullWidth(page);
  await expect(row(page, 40)).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('.history-scroll').evaluate(node => node.scrollTop)).toBe(top);
  await row(page, 40).click(); await expectOpen(page);
  await page.keyboard.press('Escape'); await expectFullWidth(page);
  expect(await page.locator('.history-scroll').evaluate(node => node.scrollTop)).toBe(top);

  await row(page, 40).focus(); await row(page, 40).press('ArrowDown');
  await expect(row(page, 41)).toBeFocused(); await expect(row(page, 41)).toHaveAttribute('aria-pressed', 'true');
  await rendered(page); await expectFullWidth(page);
  await row(page, 41).press('Enter'); await expectOpen(page);
  await expect(page.locator('.commit-detail')).toContainText('layout commit 199');
  await page.keyboard.press('Escape'); await expectClosed(page);
  await row(page, 41).focus(); await page.keyboard.press('End');
  await expect(row(page, 199)).toBeFocused(); await expectClosed(page);
  await page.getByRole('button', { name: '定位 HEAD', exact: true }).click();
  await expect.poll(() => page.locator('.history-scroll').evaluate(node => node.scrollTop)).toBe(0);
  await expect(row(page, 0)).toHaveAttribute('aria-pressed', 'true');
  await expect(row(page, 0).locator('.head-label')).toHaveText('HEAD');
  await expectFullWidth(page);
  expect(await snapshot()).toEqual(before);
});

test('the details separator supports pointer and keyboard resizing without overlapping either pane', async ({ page }, testInfo) => {
  const before = await snapshot(); await openHistory(page);
  const top = await scrollToRow(page, 40);
  await row(page, 40).click(); await expectOpen(page);
  const divider = separator(page);
  await expect(divider).toHaveAttribute('aria-orientation', 'vertical');
  for (const attribute of ['aria-valuemin', 'aria-valuenow', 'aria-valuemax']) await expect(divider).toHaveAttribute(attribute, /^\d+(?:\.\d+)?$/);
  const start = await paneWidths(page); const bounds = await divider.boundingBox(); expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + Math.min(80, bounds!.height / 2));
  await page.mouse.down(); await page.mouse.move(bounds!.x + bounds!.width / 2 + 100, bounds!.y + Math.min(80, bounds!.height / 2), { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await paneWidths(page)).history - start.history).toBeGreaterThan(30);
  const dragged = await paneWidths(page);
  expect(dragged.detail).toBeLessThan(start.detail - 30); expect(dragged.overlaps).toBe(false); expect(dragged.overflow).toBe(false);
  expect(await page.locator('.history-scroll').evaluate(node => node.scrollTop)).toBe(top);
  await divider.focus(); await divider.press('ArrowLeft');
  await expect.poll(async () => (await paneWidths(page)).history).toBeLessThan(dragged.history);
  const left = await paneWidths(page); await divider.press('ArrowRight');
  await expect.poll(async () => (await paneWidths(page)).history).toBeGreaterThan(left.history);
  await divider.press('Home');
  await expect.poll(async () => Number(await divider.getAttribute('aria-valuenow'))).toBe(Number(await divider.getAttribute('aria-valuemin')));
  await divider.press('End');
  await expect.poll(async () => Number(await divider.getAttribute('aria-valuenow'))).toBe(Number(await divider.getAttribute('aria-valuemax')));
  const end = await paneWidths(page);
  expect(end.history).toBeGreaterThan(0); expect(end.detail).toBeGreaterThan(0); expect(end.overlaps).toBe(false); expect(end.overflow).toBe(false);
  await expect(row(page, 40)).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('history-resized-details.png'), fullPage: true });
  expect(await snapshot()).toEqual(before);
});

test('narrow-window detail tabs and closing return to the same history selection without a separator', async ({ page }, testInfo) => {
  const before = await snapshot(); await openHistory(page);
  const top = await scrollToRow(page, 40);
  await row(page, 40).click(); await expectOpen(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectOpen(page); await expect(page.locator('.list-panel')).toBeHidden(); await expect(separator(page)).toBeHidden();
  await page.getByRole('button', { name: '关闭提交详情', exact: true }).click();
  await expectClosed(page); await expect(page.locator('.list-panel')).toBeVisible();
  await expect(row(page, 40)).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('.history-scroll').evaluate(node => node.scrollTop)).toBe(top);
  await page.getByRole('button', { name: '查看详情', exact: true }).click(); await expectOpen(page);
  await expect(page.locator('.commit-detail')).toContainText('layout commit 200');
  await expect(page.locator('.code-scroll')).toContainText('+version 200');
  await expect(page.locator('.diff-read-state .spinner')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('history-narrow-details.png'), fullPage: true });
  await page.keyboard.press('Escape'); await expectClosed(page);
  await expect(row(page, 40)).toBeInViewport();
  await page.setViewportSize({ width: 1440, height: 960 });
  await expectFullWidth(page); await expect(row(page, 40)).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await snapshot()).toEqual(before);
});

test('late real commit and diff responses cannot reopen closed details or replace a newer selection', async ({ page }) => {
  const before = await snapshot(); await openHistory(page); const top = await scrollToRow(page, 35);
  let delayedAction: string | undefined; let barrier = deferred(); let held = 0; let delivered = 0;
  await page.route(`${origin}/api`, async route => {
    const request = route.request().postDataJSON();
    if (!delayedAction || request.action !== delayedAction) { await route.continue(); return; }
    delayedAction = undefined; const pending = barrier.promise;
    const response = await route.fetch(); held++;
    await pending; await route.fulfill({ response }).catch(() => undefined); delivered++;
  });
  try {
    delayedAction = 'commit'; await row(page, 35).click(); await expect.poll(() => held).toBe(1);
    await expectOpen(page); await page.getByRole('button', { name: '关闭提交详情', exact: true }).click();
    await expectFullWidth(page); barrier.resolve(); await expect.poll(() => delivered).toBe(1); await rendered(page);
    await expectFullWidth(page); await expect(row(page, 35)).toHaveAttribute('aria-pressed', 'true');
    expect(await page.locator('.history-scroll').evaluate(node => node.scrollTop)).toBe(top);

    barrier = deferred(); delayedAction = 'commit-change';
    await row(page, 36).click(); await expect.poll(() => held).toBe(2); await expectOpen(page);
    await page.keyboard.press('Escape'); await expectClosed(page);
    barrier.resolve(); await expect.poll(() => delivered).toBe(2); await rendered(page);
    await expectFullWidth(page); await expect(row(page, 36)).toHaveAttribute('aria-pressed', 'true');

    barrier = deferred(); delayedAction = 'commit';
    await row(page, 37).click(); await expect.poll(() => held).toBe(3);
    await page.keyboard.press('Escape'); await expectClosed(page);
    await row(page, 38).click(); await expectOpen(page);
    await expect(page.locator('.commit-detail')).toContainText('layout commit 202');
    barrier.resolve(); await expect.poll(() => delivered).toBe(3); await rendered(page);
    await expect(row(page, 38)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.commit-detail')).toContainText('layout commit 202');
    await expect(page.locator('.code-scroll')).toContainText('+version 202');
    expect(await snapshot()).toEqual(before);
  } finally { barrier.resolve(); }
});
