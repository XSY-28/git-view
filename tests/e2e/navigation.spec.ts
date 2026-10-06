import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
let folder: string; let repo: string; let linked: string; let origin: string; let token: string; let sessionId: string;
function git(...args: string[]) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_AUTHOR_NAME: 'Navigation Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Navigation Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }); }
async function call(action: Record<string, unknown>) {
  const response = await fetch(`${origin}/api`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...action }) });
  const result = await response.json() as { ok: boolean; data: Record<string, unknown> }; if (!result.ok) throw new Error(JSON.stringify(result)); return result.data;
}
test.beforeAll(async () => {
  // Every Git write is confined to a newly created disposable fixture.
  folder = await mkdtemp(join(tmpdir(), 'git-view-navigation-')); repo = join(folder, '主 仓库'); linked = join(folder, '关联 工作区'); await mkdir(repo);
  git('init', '-b', 'main'); await writeFile(join(repo, 'file.txt'), 'V1 committed\n'); git('add', '--', 'file.txt'); git('commit', '-m', 'main first');
  git('tag', 'start'); git('branch', 'side'); git('worktree', 'add', linked, 'side');
  git('-C', linked, 'commit', '--allow-empty', '-m', 'side only');
  let stream = ''; const tip = git('rev-parse', 'side').trim();
  for (let index = 1; index <= 210; index++) { const subject = `side history ${index}`; stream += `commit refs/heads/side\ncommitter Navigation Test <test@example.invalid> ${1700000000 + index} +0000\ndata ${Buffer.byteLength(subject)}\n${subject}\n${index === 1 ? `from ${tip}\n` : ''}\n`; }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input: stream, env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull } });
  await writeFile(join(linked, 'only-side.txt'), 'linked worktree contents\n');
  await writeFile(join(repo, 'file.txt'), 'V2 staged\n'); git('add', '--', 'file.txt'); await writeFile(join(repo, 'file.txt'), 'V3 working\n');
  const runtime = join(folder, 'runtime'); execFileSync(process.execPath, [resolve('dist/cli.mjs'), 'open', '--repo', repo, '--no-browser', '--json'], { encoding: 'utf8', env: { ...process.env, GIT_VIEW_HOME: runtime } });
  const record = JSON.parse(await readFile(join(runtime, 'instance.json'), 'utf8')); origin = `http://127.0.0.1:${record.port}`; token = record.cliToken;
  sessionId = (await call({ action: 'open', path: repo })).sessionId as string;
});
test.afterAll(async () => { if (origin) await call({ action: 'shutdown' }).catch(() => {}); if (folder) await rm(folder, { recursive: true, force: true }); });
test('reference filters are read-only; changes selection and linked worktree context stay isolated', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const index = await readFile(join(repo, '.git/index')); const head = git('rev-parse', 'HEAD');
  const ticket = await call({ action: 'ticket', sessionId }); await page.goto(`${origin}/?session=${sessionId}#ticket=${ticket.ticket}`);
  await page.locator('.group-unstaged .file-row').click(); await expect(page.locator('.code-scroll')).toContainText('+V3 working');
  await page.locator('.navigation-ref').filter({ hasText: /^(?:● )?main/ }).click();
  await expect(page.locator('.commit-row')).toHaveCount(1); await expect(page.locator('.commit-row')).toContainText('main first');
  await page.locator('.navigation-ref').filter({ hasText: /^side/ }).click();
  await expect(page.locator('.navigation-ref').filter({ hasText: /^side/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.navigation-ref').filter({ hasText: /^(?:● )?main/ })).toContainText('当前分支');
  await expect(page.locator('.navigation-ref').filter({ hasText: /^side/ })).not.toContainText('当前分支');
  await expect(page.getByRole('button', { name: '分支操作', exact: true })).toHaveText('main');
  await expect(page.locator('.commit-row').filter({ hasText: 'side history 210' })).toBeVisible();
  await expect(page.getByRole('button', { name: /提交历史/ }).first()).toContainText('200');
  await page.getByRole('button', { name: /继续加载 200 条/ }).click(); await expect(page.getByRole('button', { name: /提交历史/ }).first()).toContainText('212');
  await page.locator('.history-scroll').evaluate(node => { node.scrollTop = 600; }); await page.waitForTimeout(100);
  await page.locator('.commit-row[data-row="12"]').click(); await expect(page.locator('.commit-detail')).toContainText('side history 198');
  await page.getByRole('button', { name: /当前改动/ }).first().click(); await expect(page.locator('.group-unstaged .file-row')).toHaveAttribute('aria-pressed', 'true'); await expect(page.locator('.code-scroll')).toContainText('+V3 working');
  await page.getByRole('button', { name: /提交历史/ }).first().click(); await expect(page.locator('.commit-row[data-row="12"]')).toHaveAttribute('aria-pressed', 'true'); expect(await page.locator('.history-scroll').evaluate(node => node.scrollTop)).toBe(600);
  await page.locator('.navigation-ref').filter({ hasText: /^(?:● )?main/ }).click(); await expect(page.locator('.commit-row')).toHaveCount(1); await expect(page.locator('.commit-row')).toContainText('main first');
  await page.getByRole('button', { name: /当前改动/ }).first().click();
  expect(git('rev-parse', 'HEAD')).toBe(head); expect(await readFile(join(repo, '.git/index'))).toEqual(index);
  await page.getByRole('button', { name: '切换仓库：主 仓库', exact: true }).click();
  await page.getByRole('dialog', { name: '切换仓库', exact: true }).locator('.navigation-worktree').filter({ hasText: '关联 工作区' }).click();
  await expect(page.locator('.repository-title h1')).toHaveText('关联 工作区'); await expect(page.locator('.code-scroll')).toContainText('linked worktree contents'); await expect(page.locator('.group-staged .file-row')).toHaveCount(0);
  await page.getByRole('button', { name: '切换仓库：关联 工作区', exact: true }).click();
  await page.getByRole('dialog', { name: '切换仓库', exact: true }).locator('.navigation-worktree').filter({ hasText: '主 仓库' }).click();
  await expect(page.locator('.repository-title h1')).toHaveText('主 仓库'); await expect(page.locator('.group-unstaged .file-row')).toHaveAttribute('aria-pressed', 'true'); await expect(page.locator('.code-scroll')).toContainText('+V3 working');
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: '历史范围', exact: true }).click(); await expect(page.getByLabel('筛选引用')).toBeVisible();
  await page.getByLabel('筛选引用').fill('start'); await expect(page.locator('.navigation-ref')).toHaveCount(1); await page.locator('.navigation-ref').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.commit-row')).toHaveCount(1); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await writeFile(join(repo, 'file.txt'), 'V4 keyboard refresh\n'); await page.keyboard.press('Control+r'); await page.getByRole('button', { name: /当前改动/ }).first().click(); await page.getByRole('button', { name: '查看详情', exact: true }).click(); await expect(page.locator('.code-scroll')).toContainText('+V4 keyboard refresh');
  expect(errors).toEqual([]);
});

test('startup restores the most recent path; missing path stays explicit and Ctrl+O opens the picker', async ({ page }) => {
  const unrelated = join(folder, 'another valid repository'); await mkdir(unrelated); git('-C', unrelated, 'init', '-b', 'main');
  await call({ action: 'open', path: unrelated });
  const recent = await call({ action: 'open', path: repo });
  const ticket = await call({ action: 'ticket', sessionId: recent.sessionId });
  await page.goto(`${origin}/#ticket=${ticket.ticket}`);
  await expect(page.locator('.repository-title h1')).toHaveText('主 仓库');
  await page.goto('about:blank');
  const nextTicket = await call({ action: 'ticket', sessionId: recent.sessionId });
  await rename(repo, `${repo}-moved`);
  await page.goto(`${origin}/#ticket=${nextTicket.ticket}`);
  await expect(page.locator('.repository-switcher-error')).toContainText(repo);
  await expect(page.locator('.repository-title h1')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '切换仓库', exact: true }).locator('.navigation-recent').filter({ hasText: 'another valid repository' })).toBeVisible();
  let picked = false;
  await page.route(`${origin}/api`, async route => {
    const request = route.request().postDataJSON() as { action: string };
    if (request.action === 'pick-folder') { picked = true; await route.fulfill({ json: { schemaVersion: 1, ok: true, data: { cancelled: true } } }); }
    else await route.continue();
  });
  await page.keyboard.press('Control+o'); await expect.poll(() => picked).toBe(true);
  await expect(page.getByRole('button', { name: /^打开仓库…/ })).toBeEnabled();
  await expect(page.locator('.repository-title h1')).toHaveCount(0);
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function raceFixture(page: import('@playwright/test').Page, options: { initial?: boolean; recents?: Promise<void>; open?: Promise<void>; overview?: () => Promise<void>; history?: () => Promise<void> }) {
  // Controlled transport timing tests complement the real Git tests above; they do not claim native GUI evidence.
  const mockOrigin = 'http://127.0.0.1:41998';
  const actions: { action: string; path?: string; generation?: number; entryId?: string; requestId: string }[] = [];
  let session = { sessionId: 'B', generation: 0, repository: { repositoryId: 'B', worktreeId: 'B', worktreeRoot: '/fixture/B', gitDir: '/fixture/B/.git', commonGitDir: '/fixture/B/.git' } };
  const commits = Array.from({ length: 30 }, (_, index) => ({ oid: String(30 - index).padStart(40, '0'), parents: index < 29 ? [String(29 - index).padStart(40, '0')] : [], author: 'Fixture', authoredAt: '2026-10-06T00:00:00Z', subject: `fixture commit ${30 - index}`, refs: [], boundary: false }));
  const entries = [{ id: 'staged', path: 'file.txt', rawPath: 'file.txt', kind: 'M', comparison: 'head-index', supported: true }, { id: 'unstaged', path: 'file.txt', rawPath: 'file.txt', kind: 'M', comparison: 'index-worktree', supported: true }];
  const success = (data: unknown) => ({ schemaVersion: 1, ok: true, data });
  let recentCalls = 0;
  await page.route(`${mockOrigin}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/session') { await route.fulfill({ json: success(session) }); return; }
    if (url.pathname === '/api/watch') { await route.fulfill({ json: success({ revision: 0, watching: true }) }); return; }
    if (url.pathname === '/api') {
      const request = route.request().postDataJSON(); actions.push(request);
      if (request.action === 'preferences') { await route.fulfill({ json: success({ schemaVersion: 1, language: 'zh-CN' }) }); return; }
      if (request.action === 'recents') { if (recentCalls++ === 0) await options.recents; await route.fulfill({ json: success([{ path: '/fixture/A', worktreeId: 'A', openedAt: '2026-10-06T00:00:00Z' }]) }).catch(() => undefined); return; }
      if (request.action === 'open') { await options.open; const name = request.path.split('/').at(-1); session = { sessionId: name, generation: 0, repository: { repositoryId: name, worktreeId: name, worktreeRoot: request.path, gitDir: `${request.path}/.git`, commonGitDir: `${request.path}/.git` } }; await route.fulfill({ json: success(session) }); return; }
      const { queryKey } = await import('../../packages/contracts/src/index');
      const stamp = { sessionId: request.sessionId, generation: request.generation, queryKey: queryKey(request, request.sessionId), requestId: request.requestId, observationId: request.requestId, startedAt: '2026-10-06T00:00:00Z', finishedAt: '2026-10-06T00:00:01Z' };
      if (request.action === 'overview') await options.overview?.();
      if (request.action === 'history') await options.history?.();
      const entry = entries.find(item => item.id === request.entryId) || entries[0]!;
      const data = request.action === 'overview' ? { repository: session.repository, head: { kind: 'unborn', branch: 'main' }, operation: [], changes: { staged: [entries[0]], unstaged: [entries[1]], untracked: [], conflicts: [] }, complete: true, warnings: [], fingerprint: 'current', stamp, explanations: [] }
        : request.action === 'navigation' ? { refs: [], worktrees: [] }
        : request.action === 'change' ? { entry, comparison: entry.comparison, text: request.entryId === 'unstaged' ? '@@ -1 +1 @@\n-V2\n+V3' : '@@ -1 +1 @@\n-V1\n+V2', format: 'diff', complete: true, base: 'index', target: 'worktree' }
        : request.action === 'commit' ? { commit: commits.find(node => node.oid === request.oid) || commits[0], base: null, comparisonLabel: '相对空树', changes: [] }
        : { commits, scope: request.scope, order: request.order, shallow: false };
      await route.fulfill({ json: { ...success(data), stamp } }).catch(() => undefined); return;
    }
    const file = url.pathname.startsWith('/assets/') ? join(resolve('dist/web'), 'assets', url.pathname.split('/').at(-1)!) : resolve('dist/web/index.html');
    await route.fulfill({ body: await readFile(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto(`${mockOrigin}/${options.initial ? '?session=B' : ''}`);
  return actions;
}

test('a delayed recent repository cannot override an explicit desktop open in progress', async ({ page }) => {
  const recents = deferred(); const opening = deferred(); const actions = await raceFixture(page, { recents: recents.promise, open: opening.promise });
  await expect.poll(() => actions.some(request => request.action === 'recents')).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('git-view:open-repository', { detail: { path: '/fixture/B' } })));
  await expect.poll(() => actions.filter(request => request.action === 'open').length).toBe(1);
  recents.resolve(); await expect(page.getByRole('dialog', { name: '切换仓库', exact: true }).locator('.navigation-recent')).toContainText('/fixture/A');
  opening.resolve(); await expect(page.locator('.repository-title h1')).toHaveText('B');
  await page.waitForTimeout(100);
  expect(actions.filter(request => request.action === 'open').map(request => request.path)).toEqual(['/fixture/B']);
});

test('a focus refresh keeps a file selected while its newer overview is still pending', async ({ page }) => {
  let pause = false; const overview = deferred(); const actions = await raceFixture(page, { initial: true, overview: () => pause ? overview.promise : Promise.resolve() });
  await expect(page.locator('.code-scroll')).toContainText('+V2');
  const target = page.locator('.group-unstaged .file-row'); const before = await target.boundingBox(); expect(before).not.toBeNull();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2); await page.mouse.down();
  pause = true; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => actions.filter(request => request.action === 'overview').length).toBe(2);
  await expect(page.getByRole('button', { name: '取消仓库状态读取', exact: true })).toBeVisible();
  expect(await target.boundingBox()).toEqual(before);
  await page.mouse.up(); await expect(page.locator('.code-scroll')).toContainText('+V3');
  overview.resolve(); await expect(page.locator('.group-unstaged .file-row')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.code-scroll')).toContainText('+V3'); await expect(page.locator('.group-staged .file-row')).toHaveAttribute('aria-pressed', 'false');
});


test('desktop requests keep the latest path while opening, including a return to the currently shown repository', async ({ page }) => {
  const opening = deferred(); const actions = await raceFixture(page, { initial: true, open: opening.promise });
  await expect(page.locator('.repository-title h1')).toHaveText('B');
  await page.evaluate(() => { window.dispatchEvent(new CustomEvent('git-view:open-repository', { detail: { path: '/fixture/C' } })); window.dispatchEvent(new CustomEvent('git-view:open-repository', { detail: { path: '/fixture/C' } })); });
  await expect.poll(() => actions.filter(request => request.action === 'open').length).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('git-view:open-repository', { detail: { path: '/fixture/B' } })));
  opening.resolve();
  await expect.poll(() => actions.filter(request => request.action === 'open').map(request => request.path)).toEqual(['/fixture/C', '/fixture/B']);
  await expect(page.locator('.repository-title h1')).toHaveText('B');
});


test('returning to the in-flight desktop path clears an older queued path', async ({ page }) => {
  const opening = deferred(); const actions = await raceFixture(page, { initial: true, open: opening.promise });
  await expect(page.locator('.repository-title h1')).toHaveText('B');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('git-view:open-repository', { detail: { path: '/fixture/C' } })));
  await expect.poll(() => actions.filter(request => request.action === 'open').length).toBe(1);
  await page.evaluate(() => { window.dispatchEvent(new CustomEvent('git-view:open-repository', { detail: { path: '/fixture/B' } })); window.dispatchEvent(new CustomEvent('git-view:open-repository', { detail: { path: '/fixture/C' } })); });
  opening.resolve(); await expect(page.locator('.repository-title h1')).toHaveText('C');
  await page.waitForTimeout(100);
  expect(actions.filter(request => request.action === 'open').map(request => request.path)).toEqual(['/fixture/C']);
});


test('background history refresh keeps list geometry, scroll and click targets until the replacement arrives', async ({ page }) => {
  let pause = false; const history = deferred(); const overview = deferred(); const actions = await raceFixture(page, { initial: true, overview: () => pause ? overview.promise : Promise.resolve(), history: () => pause ? history.promise : Promise.resolve() });
  await expect(page.locator('.code-scroll')).toContainText('+V2');
  await page.getByRole('button', { name: /提交历史/ }).first().click();
  await expect(page.getByRole('button', { name: /提交历史/ }).first()).toContainText('30');
  await page.locator('.history-scroll').evaluate(node => { node.scrollTop = 600; });
  const target = page.locator('.commit-row[data-row="12"]'); await expect(target).toBeVisible();
  const before = await target.boundingBox(); expect(before).not.toBeNull();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2); await page.mouse.down();
  pause = true; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => actions.filter(request => request.action === 'overview').length).toBe(2);
  await expect(page.locator('.history-read-state')).toHaveAttribute('data-phase', 'stale'); expect(await target.boundingBox()).toEqual(before);
  overview.resolve();
  await expect.poll(() => actions.filter(request => request.action === 'history').length).toBe(2);
  await expect(page.locator('.history-read-state')).toHaveAttribute('data-phase', 'loading');
  await expect(page.getByRole('button', { name: '取消提交历史读取', exact: true })).toBeVisible();
  expect(await target.boundingBox()).toEqual(before);
  expect(await page.locator('.history-scroll').evaluate(node => node.scrollTop)).toBe(600);
  await page.getByRole('button', { name: /提交历史/ }).first().evaluate(node => { if (!node.textContent?.includes('30')) throw new Error('History was emptied during refresh'); });
  await page.mouse.up(); await expect(target).toHaveAttribute('aria-pressed', 'true');
  history.resolve(); await expect(page.locator('.commit-detail')).toContainText('fixture commit 18');
  await expect(target).toHaveAttribute('aria-pressed', 'true'); expect(await page.locator('.history-scroll').evaluate(node => node.scrollTop)).toBe(600);
});
