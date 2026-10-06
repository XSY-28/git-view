import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test.skip(process.platform === 'win32', 'Whole-file index writes are POSIX-only in this batch.');

let folder: string; let repo: string; let runtime: string; let origin: string; let token: string; let sessionId: string;
const cli = resolve('dist/cli.mjs');
const fixtureEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'Operations Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Operations Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
// Only newly created temporary repositories receive Git writes in these tests.
function git(...args: string[]) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: fixtureEnv }); }
async function call(action: Record<string, unknown>) {
  const response = await fetch(`${origin}/api`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...action }) });
  const result = await response.json() as { ok: boolean; data: Record<string, unknown> };
  if (!result.ok) throw new Error(JSON.stringify(result)); return result.data;
}
async function open(page: Page) {
  const ticket = await call({ action: 'ticket', sessionId });
  await page.goto(`${origin}/?session=${encodeURIComponent(sessionId)}#ticket=${encodeURIComponent(ticket.ticket as string)}`);
  await expect(page.getByRole('checkbox', { name: '选择暂存 versions.txt', exact: true })).toBeEnabled();
}
async function selectPreview(page: Page, kind: '暂存' | '取消暂存' = '暂存') {
  await page.getByRole('checkbox', { name: `选择${kind} versions.txt`, exact: true }).check();
  await page.getByRole('button', { name: `预览${kind}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `确认${kind} · 1 个文件`, exact: true });
  await expect(dialog).toBeVisible(); return dialog;
}

test.beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'git-view-operations-browser-')); runtime = join(folder, 'runtime');
  repo = join(folder, 'bootstrap'); await mkdir(repo); git('init', '-b', 'main');
  execFileSync(process.execPath, [cli, 'open', '--repo', repo, '--no-browser', '--json'], { encoding: 'utf8', env: { ...fixtureEnv, GIT_VIEW_HOME: runtime } });
  const record = JSON.parse(await readFile(join(runtime, 'instance.json'), 'utf8')) as { port: number; cliToken: string };
  origin = `http://127.0.0.1:${record.port}`; token = record.cliToken;
});
test.beforeEach(async () => {
  repo = await mkdtemp(join(folder, 'fixture-'));
  git('init', '-b', 'main');
  await writeFile(join(repo, 'versions.txt'), 'V1 committed\n'); await writeFile(join(repo, 'untouched.txt'), 'other V1\n');
  git('add', '--', 'versions.txt', 'untouched.txt'); git('commit', '-m', 'baseline');
  await writeFile(join(repo, 'versions.txt'), 'V2 staged\n'); await writeFile(join(repo, 'untouched.txt'), 'other V2 staged\n');
  git('add', '--', 'versions.txt', 'untouched.txt');
  await writeFile(join(repo, 'versions.txt'), 'V3 working\n'); await writeFile(join(repo, 'untouched.txt'), 'other V3 working\n');
  await writeFile(join(repo, 'new.txt'), 'new file\n');
  const opened = await call({ action: 'open', path: repo }); sessionId = opened.sessionId as string;
});
test.afterAll(async () => { if (origin) await call({ action: 'shutdown' }).catch(() => undefined); if (folder) await rm(folder, { recursive: true, force: true }); });

test('explicit stage selection changes V2 to V3 only for selected file; preview cancellation writes nothing', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('button', { name: '预览暂存', exact: true })).toHaveCount(0);
  let dialog = await selectPreview(page);
  await expect(page.getByRole('checkbox', { name: '选择取消暂存 untouched.txt', exact: true, includeHidden: true })).toBeDisabled();
  await expect(dialog.locator('.operation-preview-files button')).toHaveText(['versions.txt']);
  await expect(dialog.locator('.code-scroll')).toContainText('V3 working');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).not.toBeVisible(); expect(git('show', ':versions.txt')).toBe('V2 staged\n');
  await page.getByRole('button', { name: '预览暂存', exact: true }).click();
  dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: '确认暂存', exact: true }).click();
  await expect(page.locator('.operation-feedback')).toContainText('暂存完成');
  expect(git('show', ':versions.txt')).toBe('V3 working\n');
  expect(git('show', ':untouched.txt')).toBe('other V2 staged\n');
  expect(await readFile(join(repo, 'versions.txt'), 'utf8')).toBe('V3 working\n');
  expect(git('ls-files', '--', 'new.txt')).toBe('');
});

test('unstage selected file restores HEAD in index and preserves V3 working file', async ({ page }) => {
  await open(page); const dialog = await selectPreview(page, '取消暂存');
  await expect(dialog).toContainText('保留工作区文件');
  await dialog.getByRole('button', { name: '确认取消暂存', exact: true }).click();
  await expect(page.locator('.operation-feedback')).toContainText('取消暂存完成');
  expect(git('show', ':versions.txt')).toBe('V1 committed\n');
  expect(git('show', ':untouched.txt')).toBe('other V2 staged\n');
  expect(await readFile(join(repo, 'versions.txt'), 'utf8')).toBe('V3 working\n');
});

test('double confirmation sends one execute and blocks navigation while execution is pending', async ({ page }) => {
  await open(page); const dialog = await selectPreview(page);
  let executions = 0; let release!: () => void; let started!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }); const pending = new Promise<void>(resolve => { started = resolve; });
  await page.route(`${origin}/api/operations`, async route => {
    if (route.request().postDataJSON().action !== 'execute') return route.continue();
    executions += 1; const response = await route.fetch(); started(); await barrier; await route.fulfill({ response });
  });
  try {
    // Two native click events in the same task exercise the synchronous guard.
    await dialog.getByRole('button', { name: '确认暂存', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await pending;
    await expect(dialog.getByRole('button', { name: '执行中…', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '刷新仓库', includeHidden: true })).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
    release(); await expect(page.locator('.operation-feedback')).toContainText('暂存完成'); expect(executions).toBe(1);
  } finally { release(); }
});

test('lost execution response recovers the stored operation after reload without executing again', async ({ page }) => {
  await open(page); const dialog = await selectPreview(page); let executions = 0; const ids: string[] = [];
  await page.route(`${origin}/api/operations`, async route => {
    const request = route.request().postDataJSON();
    if (request.action === 'execute') { executions += 1; ids.push(request.operationId); await route.fetch(); return route.abort('failed'); }
    if (request.action === 'receipt') ids.push(request.operationId);
    return route.continue();
  });
  await dialog.getByRole('button', { name: '确认暂存', exact: true }).click();
  await expect(page.getByRole('button', { name: '核实结果', exact: true })).toBeVisible();
  expect(git('show', ':versions.txt')).toBe('V3 working\n');
  await page.reload();
  await expect(page.locator('.operation-feedback')).toContainText('暂存完成');
  expect(executions).toBe(1); expect(ids.length).toBeGreaterThan(1); expect(new Set(ids).size).toBe(1);
});

test('external edit after preview is rejected and cannot stage unseen content', async ({ page }) => {
  // Isolate core freshness validation from the watcher closing an outdated preview first.
  await page.route(`${origin}/api/watch`, route => route.fulfill({ json: { revision: 0, watching: false } }));
  await open(page); const dialog = await selectPreview(page);
  await writeFile(join(repo, 'versions.txt'), 'V4 unseen edit\n');
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: '确认暂存', exact: true }).click();
  await expect.poll(() => git('show', ':versions.txt')).toBe('V2 staged\n');
  await expect(page.locator('.operation-feedback')).toContainText(/失败|状态已更新|待核实/);
  expect(await readFile(join(repo, 'versions.txt'), 'utf8')).toBe('V4 unseen edit\n');
});

test('narrow keyboard selection and preview are accessible; commit history has no operation checkboxes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await open(page);
  const checkbox = page.getByRole('checkbox', { name: '选择暂存 versions.txt', exact: true });
  await checkbox.focus(); await page.keyboard.press('Space'); await expect(checkbox).toBeChecked();
  const action = page.getByRole('button', { name: '预览暂存', exact: true }); await action.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/operation-preview-narrow.png', fullPage: true });
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(action).toBeFocused();
  await page.getByRole('button', { name: /提交历史/ }).first().click(); await page.locator('.commit-row').first().click();
  await expect(page.locator('.change-list-history')).toBeVisible();
  await expect(page.locator('.change-list-history input[type=checkbox]')).toHaveCount(0);
});

test('batch stages tracked and untracked selections and leaves other paths unchanged', async ({ page }) => {
  await open(page);
  await page.getByRole('checkbox', { name: '选择暂存 versions.txt', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择暂存 new.txt', exact: true }).check();
  await page.getByRole('button', { name: '预览暂存', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认暂存 · 2 个文件', exact: true });
  await expect(dialog.locator('.operation-preview-files button')).toHaveText(['versions.txt', 'new.txt']);
  await dialog.getByRole('button', { name: '确认暂存', exact: true }).click();
  await expect(page.locator('.operation-feedback')).toContainText('暂存完成');
  expect(git('show', ':versions.txt')).toBe('V3 working\n'); expect(git('show', ':new.txt')).toBe('new file\n');
  expect(git('show', ':untouched.txt')).toBe('other V2 staged\n');
});

test('a delayed preview from the previous repository cannot appear after switching', async ({ page }) => {
  const original = repo; repo = join(folder, 'other-preview-repo'); await mkdir(repo); git('init', '-b', 'main'); await writeFile(join(repo, 'other-only.txt'), 'other repository\n'); const other = repo; repo = original;
  await open(page);
  let release!: () => void; let started!: () => void; let delivered = false;
  const barrier = new Promise<void>(resolve => { release = resolve; }); const pending = new Promise<void>(resolve => { started = resolve; });
  await page.route(`${origin}/api/operations`, async route => {
    if (route.request().postDataJSON().action !== 'preview') return route.continue();
    const response = await route.fetch(); started(); await barrier; await route.fulfill({ response }).catch(() => undefined); delivered = true;
  });
  try {
    await page.getByRole('checkbox', { name: '选择暂存 versions.txt', exact: true }).check();
    await page.getByRole('button', { name: '预览暂存', exact: true }).click(); await pending;
    await page.evaluate(path => window.dispatchEvent(new CustomEvent('git-view:open-repository', { detail: { path } })), other);
    await expect(page.getByRole('checkbox', { name: '选择暂存 other-only.txt', exact: true })).toBeEnabled();
    release(); await expect.poll(() => delivered).toBe(true);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '预览暂存', exact: true })).toHaveCount(0);
    expect(git('show', ':versions.txt')).toBe('V2 staged\n');
  } finally { release(); }
});

test('durable pending discovery restores a receipt after process restart with no browser storage', async ({ page }) => {
  await open(page); let operationId = ''; let executions = 0;
  page.on('request', request => { if (request.url().endsWith('/api/operations') && request.postDataJSON()?.action === 'execute') { operationId = request.postDataJSON().operationId; executions += 1; } });
  const dialog = await selectPreview(page); await dialog.getByRole('button', { name: '确认暂存', exact: true }).click();
  await expect(page.locator('.operation-feedback')).toContainText('暂存完成');
  const receiptPath = join(runtime, 'operations', `${createHash('sha256').update(operationId).digest('hex')}.json`);
  const saved = JSON.parse(await readFile(receiptPath, 'utf8'));
  // Simulate interruption after installing the index but before persisting the final
  // status. Keep the actual writer's durable evidence, then restart the real host.
  saved.receipt.status = 'running'; delete saved.receipt.finishedAt;
  await writeFile(receiptPath, JSON.stringify(saved));
  await writeFile(join(runtime, 'operations', 'pending', `${createHash('sha256').update(operationId).digest('hex')}.json`), JSON.stringify({ schemaVersion: 1, operationId }), { mode: 0o600 });
  await page.evaluate(() => sessionStorage.clear()); await page.goto('about:blank');
  await call({ action: 'shutdown' });
  await expect.poll(async () => { try { await fetch(`${origin}/health`); return false; } catch { return true; } }).toBe(true);
  execFileSync(process.execPath, [cli, 'open', '--repo', repo, '--no-browser', '--json'], { encoding: 'utf8', env: { ...fixtureEnv, GIT_VIEW_HOME: runtime } });
  const record = JSON.parse(await readFile(join(runtime, 'instance.json'), 'utf8')) as { port: number; cliToken: string };
  origin = `http://127.0.0.1:${record.port}`; token = record.cliToken;
  sessionId = (await call({ action: 'open', path: repo })).sessionId as string;
  const ticket = await call({ action: 'ticket', sessionId });
  await page.goto(`${origin}/?session=${encodeURIComponent(sessionId)}#ticket=${encodeURIComponent(ticket.ticket as string)}`);
  await expect(page.locator('.operation-feedback')).toContainText('暂存完成');
  await expect(page.locator('.operation-feedback')).toContainText('保存的执行证据一致');
  expect(executions).toBe(1); expect(git('show', ':versions.txt')).toBe('V3 working\n');
});

test('refresh while pending discovery is delayed keeps writes disabled until discovery completes', async ({ page }) => {
  let release!: () => void; let started!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }); const pending = new Promise<void>(resolve => { started = resolve; });
  await page.route(`${origin}/api/operations`, async route => {
    if (route.request().postDataJSON().action !== 'pending') return route.continue();
    const response = await route.fetch(); started(); await barrier; await route.fulfill({ response });
  });
  try {
    const ticket = await call({ action: 'ticket', sessionId });
    await page.goto(`${origin}/?session=${encodeURIComponent(sessionId)}#ticket=${encodeURIComponent(ticket.ticket as string)}`); await pending;
    const checkbox = page.getByRole('checkbox', { name: '选择暂存 versions.txt', exact: true }); await expect(checkbox).toBeDisabled();
    await page.getByRole('button', { name: '刷新仓库', exact: true }).click(); await expect(checkbox).toBeDisabled();
    release(); await expect(checkbox).toBeEnabled();
  } finally { release(); }
});
