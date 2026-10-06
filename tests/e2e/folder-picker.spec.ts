import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { queryKey, requestSchema, type ApiRequest, type RepositorySession } from '../../packages/contracts/src/index';

// These tests validate browser state transitions with a mocked picker/API.
// They do not launch AppKit or claim that the native system dialog was verified.
const origin = 'http://127.0.0.1:41999';
const web = resolve('dist/web');
function makeSession(id: string, name: string): RepositorySession {
  return { sessionId: id, generation: 0, repository: { repositoryId: id, worktreeId: id, worktreeRoot: `/fixture/${name}`, gitDir: `/fixture/${name}/.git`, commonGitDir: `/fixture/${name}/.git` } };
}
const initial = makeSession('initial', 'existing-repository');
const selected = makeSession('selected', 'chosen-repository');
const success = (data: unknown) => ({ schemaVersion: 1, ok: true, data });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function mockApp(page: Page, choose: () => Promise<unknown>, open: (request: ApiRequest) => Promise<unknown> = async () => success(selected)) {
  const actions: ApiRequest[] = [];
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/watch') { await route.fulfill({ json: success({revision:0,watching:true}) }); return; }
    if (url.pathname === '/api/session') { await route.fulfill({ json: success(initial) }); return; }
    if (url.pathname === '/api') {
      const request = requestSchema.parse(route.request().postDataJSON());
      actions.push(request);
      if (request.action === 'pick-folder') { await route.fulfill({ json: await choose() }).catch(() => undefined); return; }
      if (request.action === 'open') { await route.fulfill({ json: await open(request) }).catch(() => undefined); return; }
      if (request.action === 'recents') { await route.fulfill({ json: success([initial, selected].map(session => ({ path: session.repository.worktreeRoot, worktreeId: session.repository.worktreeId, openedAt: '2026-10-06T00:00:00Z' }))) }); return; }
      if (request.action === 'heartbeat') { await route.fulfill({ json: success({ alive: true }) }); return; }
      if (!('sessionId' in request && 'generation' in request)) throw new Error(`Unexpected mock request: ${request.action}`);
      const session = request.sessionId === selected.sessionId ? selected : initial;
      const stamp = { sessionId: session.sessionId, generation: request.generation, queryKey: queryKey(request, session.repository.worktreeId), requestId: request.requestId, observationId: request.requestId, startedAt: '2026-10-06T00:00:00Z', finishedAt: '2026-10-06T00:00:01Z' };
      const entry = { id: 'existing', path: 'existing.txt', rawPath: 'existing.txt', kind: '?', comparison: 'untracked-preview', supported: true };
      const data = request.action === 'overview' ? {
        repository: session.repository, head: { kind: 'unborn', branch: 'main' }, operation: [],
        changes: { staged: [], unstaged: [], untracked: [entry], conflicts: [] }, complete: true, warnings: [], fingerprint: 'current', stamp, explanations: [],
      } : request.action === 'navigation' ? {refs:[],worktrees:[]} : request.action === 'change' ? {
        entry, comparison: 'untracked-preview', text: 'existing contents\n', format: 'text', complete: true, base: 'untracked', target: 'worktree',
      } : { commits: [], scope: 'all', shallow: false };
      await route.fulfill({ json: { ...success(data), stamp } }); return;
    }
    const file = url.pathname.startsWith('/assets/') ? join(web, 'assets', url.pathname.split('/').at(-1)!) : join(web, 'index.html');
    await route.fulfill({ body: await readFile(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto(`${origin}/?session=initial`);
  await expect(page.locator('.repository-title h1')).toHaveText('existing-repository');
  await expect(page.getByText('existing contents', { exact: false })).toBeVisible();
  return actions;
}

async function openSwitcher(page: Page) {
  const dialog = page.getByRole('dialog', { name: '切换仓库', exact: true });
  if (!await dialog.isVisible()) await page.getByRole('button', { name: /^切换仓库：/ }).click();
  await expect(dialog).toBeVisible();
}

test('native cancellation keeps the current repository and suppresses dialog focus refresh', async ({ page }) => {
  const picker = deferred<unknown>();
  const actions = await mockApp(page, () => picker.promise);
  const overviewCount = actions.filter(request => request.action === 'overview').length;
  await openSwitcher(page);
  await page.getByRole('button', { name: /^打开仓库…/ }).click();
  await expect(page.getByRole('button', { name: /^打开仓库…/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: '刷新仓库', exact: true })).toBeDisabled();
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  expect(actions.filter(request => request.action === 'overview')).toHaveLength(overviewCount);
  expect(actions.filter(request => request.action === 'pick-folder')).toHaveLength(1);
  picker.resolve(success({ cancelled: true }));
  await expect(page.locator('.repository-opening')).toBeHidden();
  await openSwitcher(page);
  await expect(page.getByRole('button', { name: /^打开仓库…/ })).toBeEnabled();
  await expect(page.locator('.repository-title h1')).toHaveText('existing-repository');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(actions.filter(request => request.action === 'open')).toHaveLength(0);
  expect(new URL(page.url()).searchParams.get('session')).toBe('initial');
});

test('non-repository selection shows an error and manual fallback without replacing current data', async ({ page }) => {
  const path = '/fixture/not-a-repository';
  const actions = await mockApp(page, async () => success({ cancelled: false, path }), async request => ({ schemaVersion: 1, ok: false, requestId: request.requestId, finishedAt: '2026-10-06T00:00:00Z', error: { code: 'INVALID_REPOSITORY', message: '所选文件夹不是 Git 仓库。', retryable: false } }));
  await openSwitcher(page);
  await page.getByRole('button', { name: /^打开仓库…/ }).click();
  await expect(page.getByRole('alert')).toContainText('所选文件夹不是 Git 仓库');
  await expect(page.locator('.repository-title h1')).toHaveText('existing-repository');
  await expect(page.getByText('existing contents', { exact: false })).toBeVisible();
  await expect(page.getByLabel('本地仓库路径')).not.toBeVisible();
  await page.getByText('手动输入路径', { exact: true }).click();
  await expect(page.getByLabel('本地仓库路径')).toHaveValue(path);
  expect(actions.filter(request => request.action === 'open')).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('focus during validation cannot abort the chosen repository', async ({ page }) => {
  const validation = deferred<unknown>();
  const actions = await mockApp(page, async () => success({ cancelled: false, path: selected.repository.worktreeRoot }), () => validation.promise);
  await openSwitcher(page);
  await page.getByRole('button', { name: /^打开仓库…/ }).click();
  await expect(page.getByRole('button', { name: /^打开仓库…/ })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.repository-title h1')).toHaveText('existing-repository');
  validation.resolve(success(selected));
  await expect(page.locator('.repository-title h1')).toHaveText('chosen-repository');
  await expect(page.getByRole('dialog', { name: '切换仓库', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: '切换仓库：chosen-repository', exact: true })).toBeEnabled();
  expect(actions.filter(request => request.action === 'open')).toHaveLength(1);
  expect(new URL(page.url()).searchParams.get('session')).toBe('selected');
});

test('explicit cancellation rejects a late folder selection', async ({ page }) => {
  const picker = deferred<unknown>();
  const actions = await mockApp(page, () => picker.promise);
  await openSwitcher(page);
  await page.getByRole('button', { name: /^打开仓库…/ }).click();
  await expect(page.getByRole('button', { name: /^打开仓库…/ })).toBeDisabled();
  await page.locator('.repository-opening').getByRole('button', { name: '取消', exact: true }).click();
  picker.resolve(success({ cancelled: false, path: selected.repository.worktreeRoot }));
  await expect(page.getByRole('button', { name: '切换仓库：existing-repository', exact: true })).toBeEnabled();
  await expect(page.locator('.repository-opening')).toBeHidden();
  await expect(page.locator('.repository-title h1')).toHaveText('existing-repository');
  expect(actions.filter(request => request.action === 'open')).toHaveLength(0);
});


test('repository switcher is keyboard accessible, dismissible and reachable in a narrow window', async ({ page }) => {
  const actions = await mockApp(page, async () => success({ cancelled: true }));
  const trigger = page.getByRole('button', { name: '切换仓库：existing-repository', exact: true });
  const dialog = page.getByRole('dialog', { name: '切换仓库', exact: true });
  await trigger.focus(); await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.navigation-recent')).toContainText('chosen-repository');
  await expect.poll(() => dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
  await trigger.click(); await expect(dialog).toBeVisible();
  await page.locator('.diff-header h2').click();
  await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click(); await expect(dialog).toBeInViewport();
  await expect(dialog.getByRole('button', { name: /^打开仓库…/ })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  expect(actions.filter(request => request.action === 'open' || request.action === 'pick-folder')).toHaveLength(0);
});
