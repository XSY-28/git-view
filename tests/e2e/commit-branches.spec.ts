import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test.skip(process.platform === 'win32', 'Repository writes remain POSIX-only.');
let folder: string, repo: string, runtime: string, origin: string, token: string, sessionId: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
function git(...args: string[]) { return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, env, encoding: 'utf8' }).trim(); }
async function call(action: Record<string, unknown>) {
  const response = await fetch(`${origin}/api`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...action }) });
  const result = await response.json() as { ok: boolean; data: Record<string, unknown> };
  if (!result.ok) throw new Error(JSON.stringify(result)); return result.data;
}
async function open(page: Page) {
  const ticket = await call({ action: 'ticket', sessionId });
  await page.goto(`${origin}/?session=${sessionId}#ticket=${encodeURIComponent(ticket.ticket as string)}`);
  await expect(page.getByRole('button', { name: '分支操作', exact: true })).toBeEnabled();
}
async function commitPreview(page: Page, message = 'UI commit') {
  await page.getByRole('button', { name: '提交暂存内容', exact: true }).click();
  const form = page.getByRole('dialog', { name: '提交暂存内容', exact: true });
  await form.getByLabel('提交说明', { exact: true }).fill(message);
  await form.getByRole('button', { name: '预览操作', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '确认提交 · 1 个文件', exact: true }); await expect(preview).toBeVisible(); return preview;
}
async function confirm(page: Page, label: string) {
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: label, exact: true }) });
  await expect(dialog.getByRole('button', { name: label, exact: true })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: '允许此操作运行仓库 hooks 和已配置的签名程序', exact: true }).check();
  await dialog.getByRole('button', { name: label, exact: true }).click();
}
test.beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'git-view-commit-branch-ui-')); runtime = join(folder, 'runtime');
  repo = join(folder, 'bootstrap'); await mkdir(repo); git('init', '-b', 'main');
  execFileSync(process.execPath, [resolve('dist/cli.mjs'), 'open', '--repo', repo, '--no-browser', '--json'], { env: { ...env, GIT_VIEW_HOME: runtime } });
  const record = JSON.parse(await readFile(join(runtime, 'instance.json'), 'utf8')); origin = `http://127.0.0.1:${record.port}`; token = record.cliToken;
});
test.beforeEach(async () => {
  repo = await mkdtemp(join(folder, 'fixture-')); git('init', '-b', 'main');
  git('config', 'user.name', 'UI Test'); git('config', 'user.email', 'test@example.invalid'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '.git/hooks');
  await writeFile(join(repo, 'file.txt'), 'V1\n'); git('add', '--', 'file.txt'); git('commit', '-m', 'baseline');
  await writeFile(join(repo, 'file.txt'), 'V2 staged\n'); git('add', '--', 'file.txt'); await writeFile(join(repo, 'file.txt'), 'V3 working\n');
  sessionId = (await call({ action: 'open', path: repo })).sessionId as string;
});
test.afterAll(async () => { if (origin) await call({ action: 'shutdown' }).catch(() => {}); if (folder) await rm(folder, { recursive: true, force: true }); });

test('ordinary commit previews staged V2, retains V3, refreshes history and shows actual result', async ({ page }) => {
  await open(page); const before = git('rev-parse', 'HEAD'); const dialog = await commitPreview(page);
  await expect(dialog).toContainText('V2 staged'); await expect(dialog).not.toContainText('V3 working');
  await confirm(page, '确认提交'); await expect(page.locator('.operation-feedback')).toContainText('提交完成');
  const oid = git('rev-parse', 'HEAD'); expect(oid).not.toBe(before); expect(git('rev-parse', 'HEAD^')).toBe(before);
  expect(git('show', 'HEAD:file.txt')).toBe('V2 staged'); expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('V3 working\n');
  await expect(page.locator('.operation-feedback')).toContainText(oid); await expect(page.locator('.operation-feedback')).toContainText('未暂存 1');
  await page.getByRole('button', { name: /提交历史/ }).first().click(); await expect(page.locator('.commit-row').first()).toContainText('UI commit');
});

test('branch creation does not switch; a separate clean switch updates files and HEAD', async ({ page }) => {
  git('reset', '--hard', 'HEAD'); git('switch', '-c', 'existing'); await writeFile(join(repo, 'file.txt'), 'other branch\n'); git('add', '--', 'file.txt'); git('commit', '-m', 'existing branch version'); git('switch', 'main');
  await open(page); await page.getByRole('button', { name: '分支操作', exact: true }).click();
  let form = page.getByRole('dialog', { name: '分支操作', exact: true }); await form.getByLabel('新分支名称', { exact: true }).fill('topic/ui'); await form.getByRole('button', { name: '预览操作', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认创建分支', exact: true })).toContainText('topic/ui');
  await confirm(page, '确认创建分支'); await expect(page.locator('.operation-feedback')).toContainText('创建分支完成');
  expect(git('symbolic-ref', '--short', 'HEAD')).toBe('main'); expect(git('rev-parse', 'topic/ui')).toBe(git('rev-parse', 'main'));
  await page.getByRole('button', { name: /提交历史/ }).first().click();
  await page.locator('.commit-row').first().click();
  await expect(page.locator('.commit-row[aria-pressed="true"]')).toHaveCount(1);
  await page.getByRole('button', { name: '分支操作', exact: true }).click(); form = page.getByRole('dialog', { name: '分支操作', exact: true });
  await form.getByRole('button', { name: '切换分支', exact: true }).click(); await form.getByLabel('目标本地分支', { exact: true }).selectOption('existing');
  await form.getByRole('button', { name: '预览操作', exact: true }).click(); await expect(page.getByRole('dialog', { name: '确认切换分支', exact: true })).toContainText('existing');
  await confirm(page, '确认切换分支'); await expect(page.locator('.operation-feedback')).toContainText('切换分支完成');
  await expect(page.getByRole('button', { name: '分支操作', exact: true })).toHaveText('existing'); expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('other branch\n');
  await expect(page.getByRole('heading', { name: '工作区干净', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /提交历史/ }).first().click();
  await expect(page.locator('.commit-row').first()).toContainText('existing branch version');
  await expect(page.locator('.commit-row[aria-pressed="true"]')).toHaveCount(0);
  await writeFile(join(repo, 'file.txt'), 'external change after switching\n');
  await expect(page.getByRole('button', { name: /当前改动/ }).first()).toContainText('1');
});

test('hook failure stays visible and the commit message remains available for correction', async ({ page }) => {
  const file = join(repo, '.git/hooks/pre-commit'); await writeFile(file, '#!/bin/sh\necho UI-hook-refused >&2\nexit 1\n'); await chmod(file, 0o755);
  await open(page); const before = git('rev-parse', 'HEAD'); await commitPreview(page, 'keep this message'); await confirm(page, '确认提交');
  await expect(page.locator('.operation-feedback')).toContainText('提交失败'); expect(git('rev-parse', 'HEAD')).toBe(before);
  await page.locator('.operation-feedback').getByText('Git 输出', { exact: true }).click(); await expect(page.locator('.operation-feedback')).toContainText('UI-hook-refused');
  await page.getByRole('button', { name: '提交暂存内容', exact: true }).click(); await expect(page.getByLabel('提交说明', { exact: true })).toHaveValue('keep this message');
});

test('lost commit response is recovered after reload without creating a second commit', async ({ page }) => {
  await open(page); let executions = 0;
  await page.route(`${origin}/api/operations`, async route => {
    if (route.request().postDataJSON().action === 'execute') { executions++; await route.fetch(); return route.abort('failed'); }
    return route.continue();
  });
  await commitPreview(page, 'commit only once'); await confirm(page, '确认提交'); await expect(page.getByRole('button', { name: '核实结果', exact: true })).toBeVisible();
  const oid = git('rev-parse', 'HEAD'); await page.reload(); await expect(page.locator('.operation-feedback')).toContainText('提交完成');
  expect(executions).toBe(1); expect(git('rev-parse', 'HEAD')).toBe(oid); expect(git('rev-list', '--count', 'HEAD')).toBe('2');
});

test('narrow commit confirmation is readable and requires explicit hook consent', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await open(page); const dialog = await commitPreview(page, '窄窗口提交');
  const consent = dialog.getByRole('checkbox', { name: '允许此操作运行仓库 hooks 和已配置的签名程序', exact: true }); await consent.focus(); await page.keyboard.press('Space');
  await expect(consent).toBeChecked(); await expect(dialog.getByRole('button', { name: '确认提交', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/commit-preview-narrow.png', fullPage: true });
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); expect(git('rev-list', '--count', 'HEAD')).toBe('1');
});
