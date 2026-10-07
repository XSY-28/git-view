import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
let folder: string; let repo: string; let origin: string; let token: string; let sessionId: string;
function git(...args: string[]) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_AUTHOR_NAME: 'Diff Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Diff Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }); }
async function call(action: Record<string, unknown>) { const response = await fetch(`${origin}/api`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...action }) }); const result = await response.json() as { ok: boolean; data: Record<string, unknown> }; if (!result.ok) throw new Error(JSON.stringify(result)); return result.data; }
function contents(version: string) { return Array.from({ length: 90 }, (_, i) => `${version} 第 ${i + 1} 行\t${i === 0 ? '长文本'.repeat(70) : '内容'}`).join('\n') + `\n\n${version} 末尾无换行`; }
test.beforeAll(async () => {
  // All writes are to this disposable temporary repository, including external refresh events.
  folder = await mkdtemp(join(tmpdir(), 'git-view-comparison-')); repo = join(folder, '中文 diff'); await mkdir(repo);
  git('init', '-b', 'main'); await writeFile(join(repo, 'versions.txt'), contents('V1')); git('add', '--', 'versions.txt'); git('commit', '-m', 'diff baseline');
  await writeFile(join(repo, 'versions.txt'), contents('V2')); git('add', '--', 'versions.txt'); await writeFile(join(repo, 'versions.txt'), contents('V3'));
  const runtime = join(folder, 'runtime'); execFileSync(process.execPath, [resolve('dist/cli.mjs'), 'open', '--repo', repo, '--no-browser', '--json'], { encoding: 'utf8', env: { ...process.env, GIT_VIEW_HOME: runtime } }); const record = JSON.parse(await readFile(join(runtime, 'instance.json'), 'utf8')); origin = `http://127.0.0.1:${record.port}`; token = record.cliToken; sessionId = (await call({ action: 'open', path: repo })).sessionId as string;
});
test.afterAll(async () => { if (origin) await call({ action: 'shutdown' }).catch(() => {}); if (folder) await rm(folder, { recursive: true, force: true }); });
test('compact diff controls keep code near the top and reveal full IDs, with file-history context restored on return', async ({ page }) => {
  const index = await readFile(join(repo, '.git/index')); const head = git('rev-parse', 'HEAD').trim();
  const ticket = await call({ action: 'ticket', sessionId }); await page.goto(`${origin}/?session=${sessionId}#ticket=${ticket.ticket}`);
  await page.locator('.group-staged .file-row').click();
  await expect(page.getByTestId('diff-scroll')).toContainText('+V2 第 1 行');
  await expect(page.locator('.diff-header .diff-toolbar')).toBeVisible();
  await expect(page.locator('.diff-header .file-history-action')).toBeVisible();
  const information = page.getByRole('button', { name: '文件变化信息', exact: true });
  await expect(information).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.diff-object-details')).toBeHidden();
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    if (width === 390) await page.getByRole('navigation', { name: '窄窗口面板', exact: true }).getByRole('button', { name: '查看详情', exact: true }).click();
    const gap = await page.locator('.diff-view').evaluate(node => node.querySelector('[data-testid=diff-scroll]')!.getBoundingClientRect().top - node.getBoundingClientRect().top);
    // File title/actions and the comparison baseline occupy compact rows;
    // metadata is explicit disclosure rather than stacked full-ID rows.
    expect(gap).toBeLessThanOrEqual(width === 1440 ? 110 : 150);
    await expect(page.locator('.diff-header .file-history-action')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await information.click();
  await expect(information).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.diff-object-details')).toBeVisible();
  await expect(page.locator('.diff-object-details')).toContainText(head);
  await expect(page.locator('.diff-object-details')).toContainText('versions.txt');
  await information.click();
  const code = page.getByTestId('diff-scroll');
  await code.evaluate(node => { node.scrollTop = 600; });
  await expect.poll(() => code.evaluate(node => node.scrollTop)).toBe(600);
  await page.locator('.diff-header .file-history-action').click();
  const main = page.getByRole('navigation', { name: '主视图', exact: true });
  const contents = page.getByRole('navigation', { name: '历史内容', exact: true });
  await expect(main.getByRole('button', { name: '历史', exact: true })).toHaveClass(/active/);
  await expect(contents.getByRole('button', { name: '文件历史', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('文件历史路径')).toHaveValue('versions.txt');
  await expect(page.getByLabel('文件历史提交 ID')).toHaveValue(head);
  await expect(page.locator('.investigation-file [data-testid=diff-scroll]')).toContainText('+V1 第 1 行');
  await main.getByRole('button', { name: /^当前改动/ }).click();
  await expect(page.locator('.group-staged .file-row')).toHaveAttribute('aria-pressed', 'true');
  await expect(code).toContainText('+V2 第 1 行');
  await expect.poll(() => code.evaluate(node => node.scrollTop)).toBe(600);
  await main.getByRole('button', { name: '历史', exact: true }).click();
  await expect(contents.getByRole('button', { name: '文件历史', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('文件历史路径')).toHaveValue('versions.txt');
  await expect(page.getByLabel('文件历史提交 ID')).toHaveValue(head);
  await expect(page.locator('.investigation-file [data-testid=diff-scroll]')).toContainText('+V1 第 1 行');
  expect(git('rev-parse', 'HEAD').trim()).toBe(head); expect(await readFile(join(repo, '.git/index'))).toEqual(index);
});

test('split column labels stay flush with the scroll viewport and aligned with both columns', async ({ page }) => {
  const ticket = await call({ action: 'ticket', sessionId }); await page.goto(`${origin}/?session=${sessionId}#ticket=${ticket.ticket}`);
  await page.locator('.group-staged .file-row').click();
  await page.getByRole('button', { name: '并排', exact: true }).click();
  const scroll = page.getByTestId('diff-scroll');
  await expect(page.locator('.split-labels span')).toHaveText([/^HEAD(?: [0-9a-f]{10})?$/, '暂存区']);
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 960 });
    for (const wrap of [true, false]) {
      await page.getByLabel('自动折行').setChecked(wrap);
      for (const scrollTop of [0, 600]) {
        await scroll.evaluate((node, top) => { node.scrollTop = top; }, scrollTop);
        await expect.poll(async () => scroll.evaluate(node => {
          const viewport = node.getBoundingClientRect();
          const labels = node.querySelector('.split-labels')!.getBoundingClientRect();
          return Math.abs(labels.top - viewport.top);
        })).toBeLessThanOrEqual(1);
        expect(await scroll.evaluate(node => {
          const labels = Array.from(node.querySelectorAll('.split-labels span'));
          const firstRow = node.querySelector('.split-row')!;
          return labels.every((label, index) => {
            const heading = label.getBoundingClientRect();
            const cell = firstRow.children[index]!.getBoundingClientRect();
            return Math.abs(heading.left - cell.left) <= 1 && Math.abs(heading.width - cell.width) <= 1;
          });
        })).toBe(true);
        if (!wrap) {
          const longLine = await scroll.evaluate(node => {
            const row = Array.from(node.querySelectorAll('.split-row')).find(row => row.textContent?.includes('长文本'))!;
            const cells = Array.from(row.querySelectorAll('.split-cell'));
            const textBounds = cells.map(cell => { const range = document.createRange(); range.selectNodeContents(cell.querySelector('.split-content > code')!); return range.getBoundingClientRect(); });
            return { leftTextRight: textBounds[0]!.right, rightColumnLeft: cells[1]!.getBoundingClientRect().left, rightTextRight: textBounds[1]!.right, tableRight: node.querySelector('.split-code-table')!.getBoundingClientRect().right, scrollWidth: node.scrollWidth, viewportWidth: node.clientWidth };
          });
          // Actual text geometry catches overflow that cell-box alignment alone
          // misses: long lines must scroll, never paint over the other version.
          expect(longLine.leftTextRight).toBeLessThanOrEqual(longLine.rightColumnLeft + 1);
          expect(longLine.rightTextRight).toBeLessThanOrEqual(longLine.tableRight + 1);
          expect(longLine.scrollWidth).toBeGreaterThan(longLine.viewportWidth);
        }
      }
    }
  }
});
test('both diff modes preserve V1/V2/V3, original line numbers, scroll and stored preference; external edits refresh', async ({ page }) => {
  const ticket = await call({ action: 'ticket', sessionId }); await page.goto(`${origin}/?session=${sessionId}#ticket=${ticket.ticket}`);
  await page.locator('.group-staged .file-row').click(); await expect(page.getByTestId('diff-scroll')).toContainText('-V1 第 1 行'); await expect(page.getByTestId('diff-scroll')).toContainText('+V2 第 1 行');
  await page.getByRole('button', { name: '并排', exact: true }).click();
  await expect(page.locator('.split-row .removed').first()).toContainText('-V1 第 1 行'); await expect(page.locator('.split-row .added').first()).toContainText('+V2 第 1 行');
  await expect(page.locator('.split-row .removed .line-number').first()).toHaveText('1'); await expect(page.locator('.split-row .added .line-number').first()).toHaveText('1');
  const finalReplacement = page.locator('.split-row').filter({ hasText: 'V1 末尾无换行' }); await expect(finalReplacement).toContainText('+V2 末尾无换行'); await expect(finalReplacement.locator('.split-cell .split-note')).toHaveCount(2);
  const stagedRows = await page.locator('.split-row').count(); await page.getByLabel('自动折行').uncheck(); expect(await page.locator('.split-row').count()).toBe(stagedRows); await page.getByLabel('自动折行').check();
  await page.locator('.group-unstaged .file-row').click(); await expect(page.getByTestId('diff-scroll')).toContainText('-V2 第 1 行'); await expect(page.getByTestId('diff-scroll')).toContainText('+V3 第 1 行');
  await page.getByTestId('diff-scroll').evaluate(node => { node.scrollTop = 600; }); await page.waitForTimeout(100); const top = await page.getByTestId('diff-scroll').evaluate(node => node.scrollTop);
  await page.getByRole('navigation', { name: '主视图', exact: true }).getByRole('button', { name: '历史', exact: true }).click(); await page.getByTestId('commit-row').first().click(); await expect(page.locator('.commit-detail')).toContainText('diff baseline');
  await page.getByRole('button', { name: /当前改动/ }).first().click(); await expect(page.locator('.group-unstaged .file-row')).toHaveAttribute('aria-pressed', 'true'); await expect(page.getByTestId('diff-scroll')).toContainText('+V3 第 1 行'); expect(await page.getByTestId('diff-scroll').evaluate(node => node.scrollTop)).toBe(top);
  await page.getByRole('button', { name: '单列', exact: true }).click(); expect(await page.getByTestId('diff-scroll').evaluate(node => node.scrollTop)).toBe(top);
  await page.getByRole('button', { name: '并排', exact: true }).click(); await page.reload(); await expect(page.locator('.diff-view')).toHaveAttribute('data-diff-mode', 'split');
  await page.locator('.group-unstaged .file-row').click(); await writeFile(join(repo, 'versions.txt'), contents('V4')); await expect(page.getByTestId('diff-scroll')).toContainText('+V4 第 1 行', { timeout: 15000 });
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: '查看详情', exact: true }).click(); await expect(page.locator('.diff-toolbar')).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
