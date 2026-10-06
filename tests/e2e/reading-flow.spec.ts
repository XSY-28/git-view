import { test, expect, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let folder: string; let repo: string; let linked: string; let origin: string; let token: string; let sessionId: string;
const paths = Array.from({ length: 36 }, (_, index) => `file-${String(index).padStart(2, '0')}.txt`);
const preview = `untracked line one\n${'long preview '.repeat(35)}\nlast line without newline`;
function git(...args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_AUTHOR_NAME: 'Reading Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Reading Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
}
async function call(action: Record<string, unknown>) {
  const response = await fetch(`${origin}/api`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...action }) });
  const result = await response.json() as { ok: boolean; data: Record<string, unknown> };
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.data;
}
async function open(page: Page) {
  const ticket = await call({ action: 'ticket', sessionId });
  await page.goto(`${origin}/?session=${sessionId}#ticket=${ticket.ticket}`);
  await expect(page.getByLabel('筛选当前改动文件', { exact: true })).toBeVisible();
}
function row(page: Page, group: string, path: string) {
  return page.locator(`${group} .file-row`).filter({ hasText: path });
}
async function expectVisibleAndFocused(target: Locator) {
  await expect(target).toBeFocused();
  await expect(target).toHaveAttribute('aria-pressed', 'true');
  await expect(target).toBeInViewport();
  // Intersection with the document alone does not ensure visibility inside a
  // nested file-list scroller. Check every clipping ancestor as well.
  expect(await target.evaluate(node => {
    const bounds = node.getBoundingClientRect();
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (!/(auto|scroll|hidden)/.test(getComputedStyle(parent).overflowY)) continue;
      const clip = parent.getBoundingClientRect();
      if (bounds.top < clip.top - 1 || bounds.bottom > clip.bottom + 1) return false;
    }
    return true;
  })).toBe(true);
}

test.beforeAll(async () => {
  // All Git writes, mode changes and the linked worktree belong to this fresh
  // disposable fixture; the developer's checkout is never used as test data.
  folder = await mkdtemp(join(tmpdir(), 'git-view-reading-'));
  repo = join(folder, 'reading repository'); linked = join(folder, 'linked reading'); await mkdir(repo);
  git('init', '-b', 'main');
  for (const path of paths) await writeFile(join(repo, path), `base ${path}\n`);
  await writeFile(join(repo, 'versions.txt'), 'V1 first\nunchanged middle\nV1 final');
  await writeFile(join(repo, 'original-name.txt'), 'same renamed content\n');
  await writeFile(join(repo, 'executable.sh'), '#!/bin/sh\nprintf "ready\\n"\n');
  git('add', '--', ...paths, 'versions.txt', 'original-name.txt', 'executable.sh'); git('commit', '-m', 'reading baseline');
  for (const path of paths) await writeFile(join(repo, path), `committed ${path}\n`);
  git('add', '--', ...paths); git('commit', '-m', 'many changed files');
  git('worktree', 'add', '-b', 'linked', linked);
  await writeFile(join(linked, 'linked-only.txt'), 'linked only preview\n');
  for (const path of paths) await writeFile(join(repo, path), `staged ${path}\n`);
  await writeFile(join(repo, 'versions.txt'), 'V2 first\nunchanged middle\nV2 final');
  git('mv', '--', 'original-name.txt', 'renamed-name.txt');
  await chmod(join(repo, 'executable.sh'), 0o755);
  git('add', '--', ...paths, 'versions.txt', 'executable.sh');
  for (const path of paths) await writeFile(join(repo, path), `working ${path}\n`);
  await writeFile(join(repo, 'versions.txt'), 'V3 first\nunchanged middle\nV3 final');
  await writeFile(join(repo, 'preview.txt'), preview);
  const runtime = join(folder, 'runtime');
  execFileSync(process.execPath, [resolve('dist/cli.mjs'), 'open', '--repo', repo, '--no-browser', '--json'], { encoding: 'utf8', env: { ...process.env, GIT_VIEW_HOME: runtime } });
  const record = JSON.parse(await readFile(join(runtime, 'instance.json'), 'utf8'));
  origin = `http://127.0.0.1:${record.port}`; token = record.cliToken;
  sessionId = (await call({ action: 'open', path: repo })).sessionId as string;
});
test.afterAll(async () => { if (origin) await call({ action: 'shutdown' }).catch(() => {}); if (folder) await rm(folder, { recursive: true, force: true }); });

test('diff body keeps real line numbers and EOF while raw metadata remains available for viewing and copying', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page);
  await row(page, '.group-staged', 'versions.txt').click();
  const code = page.locator('.code-scroll');
  await expect(code).toContainText('@@ -1,3 +1,3 @@');
  await expect(code).toContainText('-V1 first'); await expect(code).toContainText('+V2 first');
  await expect(code).not.toContainText('diff --git'); await expect(code).not.toContainText('index ');
  await expect(code).not.toContainText('--- a/'); await expect(code).not.toContainText('+++ b/');
  await expect(code.locator('.code-line.removed').first().locator('.line-number').first()).toHaveText('1');
  await expect(code.locator('.code-line.added').last().locator('.line-number').last()).toHaveText('3');
  await expect(code).toContainText('No newline at end of file');
  const raw = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^原始补丁/ }) });
  await expect(raw).not.toHaveAttribute('open');
  await raw.locator('summary').click();
  const patch = raw.locator('pre');
  await expect(patch).toContainText('diff --git a/versions.txt b/versions.txt');
  await expect(patch).toContainText('--- a/versions.txt'); await expect(patch).toContainText('+++ b/versions.txt');
  await page.getByRole('button', { name: '复制补丁', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await patch.textContent());
  await page.screenshot({ path: 'test-results/round2-raw-patch.png', fullPage: true });
  await raw.locator('summary').click();
  await page.getByRole('button', { name: '并排', exact: true }).click();
  await expect(page.locator('.split-labels span')).toHaveText([/^HEAD(?: [0-9a-f]{10})?$/, '暂存区']);
  await row(page, '.group-unstaged', 'versions.txt').click();
  await expect(page.locator('.split-labels span')).toHaveText(['暂存区', '工作区']);
  await expect(code).toContainText('-V2 first'); await expect(code).toContainText('+V3 first');
  await expect(page.locator('.split-note')).toHaveCount(2);
});

test('rename and executable-bit changes stay visible without raw patch metadata in the reading area', async ({ page }) => {
  await open(page);
  await row(page, '.group-staged', 'renamed-name.txt').click();
  await expect(page.locator('.diff-view')).toContainText('original-name.txt');
  await expect(page.locator('.diff-view')).toContainText('renamed-name.txt');
  await expect(page.locator('.diff-view')).toContainText('重命名');
  await expect(page.locator('.patch-metadata')).toContainText('重命名');
  await row(page, '.group-staged', 'executable.sh').click();
  await expect(page.locator('.diff-view')).toContainText('100644');
  await expect(page.locator('.diff-view')).toContainText('100755');
  await expect(page.locator('.patch-metadata')).toContainText('100644');
  await expect(page.locator('.patch-metadata')).toContainText('100755');
});

test('text previews have one numbered column and wrapping without diff-only controls; history names both comparison sides', async ({ page }) => {
  await open(page);
  await row(page, '.group-staged', 'versions.txt').click();
  await page.getByRole('button', { name: '并排', exact: true }).click();
  await row(page, '.group-untracked', 'preview.txt').click();
  await expect(page.locator('.diff-view')).toHaveAttribute('data-diff-mode', 'text');
  await expect(page.getByRole('button', { name: '单列', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '并排', exact: true })).toHaveCount(0);
  await expect(page.locator('.text-code-table .code-line')).toHaveCount(3);
  await expect(page.locator('.text-code-table .line-number')).toHaveText(['1', '2', '3']);
  await expect(page.locator('.text-code-table code')).toHaveText(preview.split('\n'));
  await expect(page.locator('.split-labels')).toHaveCount(0);
  await page.getByLabel('自动折行').uncheck(); await expect(page.locator('.diff-view')).toHaveClass(/nowrap-lines/);
  await page.getByLabel('自动折行').check(); await expect(page.locator('.diff-view')).toHaveClass(/wrap-lines/);
  await page.screenshot({ path: 'test-results/round2-text-preview.png', fullPage: true });
  await page.getByRole('button', { name: /提交历史/ }).first().click();
  await page.locator('.commit-row').filter({ hasText: 'many changed files' }).click();
  await expect(page.locator('.split-labels')).toContainText('父提交');
  await expect(page.locator('.split-labels')).toContainText('所选提交');
  await page.locator('.commit-row').filter({ hasText: 'reading baseline' }).click();
  await expect(page.locator('.split-labels')).toContainText('空树');
  await expect(page.locator('.split-labels')).toContainText('所选提交');
});

test('file keyboard navigation crosses visible groups, reveals focused rows and preserves distinct staged/working selections', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await open(page);
  const filter = page.getByLabel('筛选当前改动文件', { exact: true });
  await filter.fill('file-');
  const firstStaged = row(page, '.group-staged', 'file-00.txt');
  const lastWorking = row(page, '.group-unstaged', 'file-35.txt');
  await firstStaged.focus(); await firstStaged.press('End'); await expectVisibleAndFocused(lastWorking);
  await expect(page.locator('.code-scroll')).toContainText('+working file-35.txt');
  await lastWorking.press('ArrowUp'); await expectVisibleAndFocused(row(page, '.group-unstaged', 'file-34.txt'));
  await page.keyboard.press('Home'); await expectVisibleAndFocused(firstStaged);
  await expect(page.locator('.code-scroll')).toContainText('+staged file-00.txt');
  const finalStaged = row(page, '.group-staged', 'file-35.txt');
  await finalStaged.focus(); await finalStaged.press('ArrowDown');
  const firstWorking = row(page, '.group-unstaged', 'file-00.txt');
  await expectVisibleAndFocused(firstWorking);
  await expect(firstStaged).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.code-scroll')).toContainText('-staged file-00.txt');
  await expect(page.locator('.code-scroll')).toContainText('+working file-00.txt');
  await firstWorking.press('ArrowUp'); await expectVisibleAndFocused(finalStaged);
  await page.locator('.group-unstaged summary').click();
  await firstStaged.focus(); await firstStaged.press('End'); await expectVisibleAndFocused(finalStaged);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '文件列表', exact: true }).click();
  await firstStaged.focus(); await firstStaged.press('ArrowDown');
  await expectVisibleAndFocused(row(page, '.group-staged', 'file-01.txt'));
  await expect(page.locator('.list-panel')).toBeVisible();
  await expect(page.locator('.detail-panel')).toBeHidden();
});

test('filtering keeps typing focus, removes an excluded diff, and remembers filters per view and worktree', async ({ page }) => {
  await open(page);
  const filter = page.getByLabel('筛选当前改动文件', { exact: true });
  await row(page, '.group-unstaged', 'file-00.txt').click();
  await expect(page.locator('.code-scroll')).toContainText('+working file-00.txt');
  await filter.fill('file-12');
  await expect(filter).toBeFocused(); await expect(page.locator('.file-row')).toHaveCount(2);
  await expect(page.locator('.code-scroll')).toHaveCount(0);
  await expect(page.locator('.file-row[aria-pressed="true"]')).toHaveCount(0);
  await row(page, '.group-staged', 'file-12.txt').click();
  await expect(page.locator('.code-scroll')).toContainText('+staged file-12.txt');
  await filter.fill('file-12.txt'); await expect(filter).toBeFocused();
  await expect(row(page, '.group-staged', 'file-12.txt')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.code-scroll')).toContainText('+staged file-12.txt');
  await filter.fill('no-such-file'); await expect(filter).toBeFocused();
  await expect(page.getByText('无匹配文件', { exact: true })).toBeVisible();
  await expect(page.locator('.code-scroll')).toHaveCount(0);
  await filter.fill('file-12');
  await expect(page.locator('.code-scroll')).toHaveCount(0);
  await row(page, '.group-unstaged', 'file-12.txt').click();
  await page.getByRole('button', { name: /提交历史/ }).first().click();
  await page.locator('.commit-row').filter({ hasText: 'many changed files' }).click();
  const commitFilter = page.getByLabel('筛选提交文件', { exact: true });
  await expect(commitFilter).toHaveValue(''); await commitFilter.fill('file-2');
  await expect(commitFilter).toBeFocused(); await expect(page.locator('.commit-files .file-row')).toHaveCount(10);
  await expect(page.locator('.code-scroll')).toHaveCount(0);
  const firstCommitFile = row(page, '.commit-files', 'file-20.txt');
  await firstCommitFile.focus(); await firstCommitFile.press('End');
  await expectVisibleAndFocused(row(page, '.commit-files', 'file-29.txt'));
  await page.keyboard.press('Home'); await expectVisibleAndFocused(firstCommitFile);
  await page.getByRole('button', { name: /当前改动/ }).first().click();
  await expect(filter).toHaveValue('file-12');
  await expect(row(page, '.group-unstaged', 'file-12.txt')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '切换仓库：reading repository', exact: true }).click();
  await page.getByRole('dialog', { name: '切换仓库', exact: true }).locator('.navigation-worktree').filter({ hasText: 'linked reading' }).click();
  await expect(page.locator('.repository-title h1')).toHaveText('linked reading');
  await expect(filter).toHaveValue('');
  await expect(page.locator('.code-scroll')).toContainText('linked only preview');
  await filter.fill('linked-only');
  await page.getByRole('button', { name: '切换仓库：linked reading', exact: true }).click();
  await page.getByRole('dialog', { name: '切换仓库', exact: true }).locator('.navigation-worktree').filter({ hasText: 'reading repository' }).click();
  await expect(page.locator('.repository-title h1')).toHaveText('reading repository');
  await expect(filter).toHaveValue('file-12');
  await expect(row(page, '.group-unstaged', 'file-12.txt')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.code-scroll')).toContainText('+working file-12.txt');
  await page.getByRole('button', { name: /提交历史/ }).first().click();
  await expect(commitFilter).toHaveValue('file-2');
  await expect(firstCommitFile).toHaveAttribute('aria-pressed', 'true');
});

for (const view of ['changes', 'history'] as const) {
  test(`${view}: an excluded selection cannot be refilled by its delayed real Git response`, async ({ page }) => {
    await open(page);
    if (view === 'history') {
      await page.getByRole('button', { name: /提交历史/ }).first().click();
      await page.locator('.commit-row').filter({ hasText: 'many changed files' }).click();
    }
    const group = view === 'history' ? '.commit-files' : '.group-unstaged';
    const action = view === 'history' ? 'commit-change' : 'change';
    await expect(page.locator('.diff-view')).toBeVisible();
    let release!: () => void; let started!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const pending = new Promise<void>(resolve => { started = resolve; });
    let delivered = false; let intercepted = false;
    await page.route(`${origin}/api`, async route => {
      if (intercepted || route.request().postDataJSON()?.action !== action) return route.continue();
      intercepted = true;
      const response = await route.fetch();
      started(); await barrier;
      await route.fulfill({ response }).catch(() => undefined);
      delivered = true;
    });
    try {
      await row(page, group, 'file-12.txt').click(); await pending;
      const filter = page.getByLabel(view === 'history' ? '筛选提交文件' : '筛选当前改动文件', { exact: true });
      await filter.fill('file-20'); await expect(filter).toBeFocused();
      await expect(page.locator('.code-scroll')).toHaveCount(0);
      await expect(page.locator('.file-row[aria-pressed="true"]')).toHaveCount(0);
      release(); await expect.poll(() => delivered).toBe(true);
      await page.waitForTimeout(150);
      await expect(page.locator('.code-scroll')).toHaveCount(0);
      await expect(page.locator('.file-row[aria-pressed="true"]')).toHaveCount(0);
      await expect(filter).toBeFocused();
      await filter.fill('');
      await expect(page.locator('.code-scroll')).toHaveCount(0);
    } finally { release(); }
  });
}
