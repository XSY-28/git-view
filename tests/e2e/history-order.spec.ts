import { test, expect, type Page, type Response } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let folder: string; let repo: string; let linked: string; let origin: string; let token: string; let sessionId: string;
const gitEnvironment = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_AUTHOR_NAME: 'History Order Fixture', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'History Order Fixture', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
type HistoryPage = { commits: { oid: string; subject: string; parents: string[] }[]; nextCursor?: string };
function git(args: string[], input?: string, timestamp?: number) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', input, env: { ...gitEnvironment, ...(timestamp === undefined ? {} : { GIT_AUTHOR_DATE: `${timestamp} +0000`, GIT_COMMITTER_DATE: `${timestamp} +0000` }) } }).trim();
}
async function call(action: Record<string, unknown>) {
  const response = await fetch(`${origin}/api`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...action }) });
  const result = await response.json() as { ok: boolean; data: Record<string, unknown> };
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.data;
}
async function open(page: Page) {
  const ticket = await call({ action: 'ticket', sessionId });
  await page.goto(`${origin}/?session=${encodeURIComponent(sessionId)}#ticket=${encodeURIComponent(ticket.ticket as string)}`);
  await expect(page.locator('.repository-title h1')).toHaveText('main-repository');
}
function historyResponse(page: Page, order: 'date' | 'topo', cursor = false) {
  return page.waitForResponse(response => {
    if (!response.url().endsWith('/api')) return false;
    const request = response.request().postDataJSON();
    return request.action === 'history' && request.scope === 'all' && request.order === order && Boolean(request.cursor) === cursor;
  });
}
async function historyData(response: Response): Promise<HistoryPage> {
  const result = await response.json(); expect(result.ok).toBe(true); return result.data;
}
async function graphLanes(page: Page) {
  // Inspect the actual rendered SVG nodes, excluding the decorative HEAD ring.
  return page.locator('.commit-graph circle[r="4.5"]').evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute('cx')))]);
}
async function snapshot() {
  const linkedGitDir = (await readFile(join(linked, '.git'), 'utf8')).trim().replace(/^gitdir: /, '');
  const paths = [join(repo, '.git/HEAD'), join(repo, '.git/index'), join(repo, 'file.txt'), join(linkedGitDir, 'HEAD'), join(linkedGitDir, 'index'), join(linked, 'file.txt')];
  return Promise.all(paths.map(path => readFile(path)));
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }

test.beforeAll(async () => {
  // All fixture Git writes stay in a newly created temporary directory. Explicit
  // dates produce an independent todo chain that topo groups ahead of main,
  // while date order interleaves its commits with a real two-parent merge.
  folder = await mkdtemp(join(tmpdir(), 'git-view-history-order-'));
  repo = join(folder, 'main-repository'); linked = join(folder, 'feature-worktree'); await mkdir(repo);
  git(['init', '-b', 'main']);
  const blob = git(['hash-object', '-w', '--stdin'], 'read-only fixture\n');
  const tree = git(['mktree'], `100644 blob ${blob}\tfile.txt\n`);
  const commit = (subject: string, offset: number, parents: string[] = []) => git(['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', subject], undefined, 1700000000 + offset);
  const root = commit('MAIN root', 0);
  const main = commit('MAIN implementation', 2285, [root]);
  const feature = commit('FEATURE implementation', 2275, [root]);
  const merge = commit('MAIN merge feature', 2295, [main, feature]);
  git(['update-ref', 'refs/heads/main', merge]); git(['update-ref', 'refs/heads/feature', feature]);
  let todo: string | undefined;
  for (let index = 1; index <= 230; index++) todo = commit(`TODO maintenance ${index}`, index * 10, todo ? [todo] : []);
  git(['update-ref', 'refs/remotes/origin/todo', todo!]);
  git(['reset', '--hard', 'main']); git(['worktree', 'add', linked, 'feature']);
  expect(git(['status', '--porcelain'])).toBe('');
  const runtime = join(folder, 'runtime');
  execFileSync(process.execPath, [resolve('dist/cli.mjs'), 'open', '--repo', repo, '--no-browser', '--json'], { encoding: 'utf8', env: { ...process.env, GIT_VIEW_HOME: runtime } });
  const record = JSON.parse(await readFile(join(runtime, 'instance.json'), 'utf8')) as { port: number; cliToken: string };
  origin = `http://127.0.0.1:${record.port}`; token = record.cliToken;
  sessionId = (await call({ action: 'open', path: repo })).sessionId as string;
});
test.afterAll(async () => { if (origin) await call({ action: 'shutdown' }).catch(() => {}); if (folder) await rm(folder, { recursive: true, force: true }); });

test('HEAD is the initial range; all refs defaults to interleaved dates and can show grouped topology', async ({ page }) => {
  const before = await snapshot(); await open(page);
  await expect(page.getByRole('button', { name: /当前改动/ }).first()).toHaveClass(/active/);
  await expect(page.getByRole('button', { name: '当前 HEAD', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /提交历史/ }).first().click();
  await expect(page.locator('.commit-row')).toHaveCount(4);
  await expect(page.locator('.commit-row').first()).toContainText('MAIN merge feature');
  await expect(page.locator('.commit-row').filter({ hasText: 'TODO maintenance' })).toHaveCount(0);
  await expect(page.getByLabel('历史排序', { exact: true })).toHaveCount(0);
  expect((await graphLanes(page)).length).toBeGreaterThan(1);

  const dateResponse = historyResponse(page, 'date');
  await page.getByRole('button', { name: '全部引用', exact: true }).click();
  const date = await historyData(await dateResponse);
  await expect(page.getByLabel('历史排序', { exact: true })).toHaveValue('date');
  expect(date.commits).toHaveLength(200);
  expect(date.commits.slice(0, 6).map(commit => commit.subject)).toEqual(['TODO maintenance 230', 'MAIN merge feature', 'TODO maintenance 229', 'MAIN implementation', 'TODO maintenance 228', 'FEATURE implementation']);
  expect(date.commits.find(commit => commit.subject === 'MAIN merge feature')?.parents).toHaveLength(2);
  await expect(page.locator('.commit-row[data-row="1"]')).toContainText('MAIN merge feature');
  expect((await graphLanes(page)).length).toBeGreaterThan(1);

  const topoResponse = historyResponse(page, 'topo');
  await page.getByLabel('历史排序', { exact: true }).selectOption('topo');
  const topo = await historyData(await topoResponse);
  expect(topo.commits).toHaveLength(200);
  expect(topo.commits.every(commit => commit.subject.startsWith('TODO maintenance ') && commit.parents.length <= 1)).toBe(true);
  await expect(page.locator('.commit-row').first()).toContainText('TODO maintenance 230');
  await expect.poll(() => graphLanes(page)).toEqual(['15']);
  expect(await snapshot()).toEqual(before);
});

test('late sort responses and late pagination cannot replace the current ordering', async ({ page }) => {
  const before = await snapshot(); await open(page);
  await page.getByRole('button', { name: '全部引用', exact: true }).click();
  const order = page.getByLabel('历史排序', { exact: true });
  await expect(order).toHaveValue('date');
  await expect(page.locator('.commit-row[data-row="1"]')).toContainText('MAIN merge feature');
  const sort = deferred(); const pagination = deferred();
  let holdTopo = true; let holdDatePage = false; let sortHeld = 0; let sortDelivered = 0; let pageHeld = 0; let pageDelivered = 0;
  await page.route(`${origin}/api`, async route => {
    const request = route.request().postDataJSON();
    const delayedSort = request.action === 'history' && request.scope === 'all' && request.order === 'topo' && !request.cursor && holdTopo;
    const delayedPage = request.action === 'history' && request.scope === 'all' && request.order === 'date' && Boolean(request.cursor) && holdDatePage;
    if (!delayedSort && !delayedPage) { await route.continue(); return; }
    // Delay authentic server responses: commits, cursors, and read stamps remain real.
    const response = await route.fetch();
    if (delayedSort) { sortHeld++; await sort.promise; }
    else { pageHeld++; await pagination.promise; }
    await route.fulfill({ response }).catch(() => undefined);
    if (delayedSort) sortDelivered++; else pageDelivered++;
  });
  try {
    await order.selectOption('topo'); await expect.poll(() => sortHeld).toBe(1);
    await order.selectOption('date');
    await expect(page.locator('.commit-row[data-row="1"]')).toContainText('MAIN merge feature');
    await expect(page.locator('.history-read-state')).toHaveAttribute('data-phase', 'idle');
    sort.resolve(); await expect.poll(() => sortDelivered).toBe(1);
    await expect(order).toHaveValue('date');
    await expect(page.locator('.commit-row[data-row="1"]')).toContainText('MAIN merge feature');

    holdTopo = false; holdDatePage = true;
    await page.getByRole('button', { name: /继续加载 200 条/ }).click();
    await expect.poll(() => pageHeld).toBe(1);
    await order.selectOption('topo');
    await expect(page.locator('.history-read-state')).toHaveAttribute('data-phase', 'idle');
    await expect.poll(() => graphLanes(page)).toEqual(['15']);
    pagination.resolve(); await expect.poll(() => pageDelivered).toBe(1);
    await expect(order).toHaveValue('topo');
    await expect(page.getByRole('button', { name: /提交历史/ }).first()).toContainText('200');
    await expect(page.locator('.commit-row').filter({ hasText: 'MAIN merge feature' })).toHaveCount(0);
    await expect.poll(() => graphLanes(page)).toEqual(['15']);
    expect(await snapshot()).toEqual(before);
  } finally { sort.resolve(); pagination.resolve(); }
});

test('all-ref ordering survives view and scope changes and belongs to each worktree', async ({ page }) => {
  const before = await snapshot(); await open(page);
  await page.getByRole('button', { name: '全部引用', exact: true }).click();
  await page.getByLabel('历史排序', { exact: true }).selectOption('topo');
  await expect.poll(() => graphLanes(page)).toEqual(['15']);
  await page.getByRole('button', { name: '当前 HEAD', exact: true }).click();
  await expect(page.getByLabel('历史排序', { exact: true })).toHaveCount(0);
  await expect(page.locator('.commit-row')).toHaveCount(4);
  await page.getByRole('button', { name: '全部引用', exact: true }).click();
  await expect(page.getByLabel('历史排序', { exact: true })).toHaveValue('topo');
  await page.getByRole('button', { name: /当前改动/ }).first().click();
  await page.getByRole('button', { name: /提交历史/ }).first().click();
  await expect(page.getByLabel('历史排序', { exact: true })).toHaveValue('topo');

  async function switchWorktree(from: string, to: string) {
    await page.getByRole('button', { name: `切换仓库：${from}`, exact: true }).click();
    await page.getByRole('dialog', { name: '切换仓库', exact: true }).locator('.navigation-worktree').filter({ hasText: to }).click();
    await expect(page.locator('.repository-title h1')).toHaveText(to);
  }
  await switchWorktree('main-repository', 'feature-worktree');
  await expect(page.getByRole('button', { name: /当前改动/ }).first()).toHaveClass(/active/);
  await expect(page.getByRole('button', { name: '当前 HEAD', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '全部引用', exact: true }).click();
  await expect(page.getByLabel('历史排序', { exact: true })).toHaveValue('date');
  await expect(page.locator('.commit-row[data-row="1"]')).toContainText('MAIN merge feature');
  await switchWorktree('feature-worktree', 'main-repository');
  await expect(page.getByLabel('历史排序', { exact: true })).toHaveValue('topo');
  await expect.poll(() => graphLanes(page)).toEqual(['15']);
  await switchWorktree('main-repository', 'feature-worktree');
  await expect(page.getByLabel('历史排序', { exact: true })).toHaveValue('date');
  await expect(page.locator('.commit-row[data-row="1"]')).toContainText('MAIN merge feature');
  expect(await snapshot()).toEqual(before);
});

test('history ordering remains usable at a 390px viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await open(page);
  await page.getByRole('button', { name: '历史范围', exact: true }).click();
  await page.getByRole('button', { name: '全部引用', exact: true }).click();
  const order = page.getByLabel('历史排序', { exact: true });
  await expect(order).toBeVisible(); await expect(order).toHaveValue('date');
  await order.selectOption('topo'); await expect.poll(() => graphLanes(page)).toEqual(['15']);
  await order.selectOption('date');
  await expect(page.locator('.commit-row[data-row="1"]')).toContainText('MAIN merge feature');
  await expect(order).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('history-order-narrow.png'), fullPage: true });
});

test('wide merge graphs have a clipped graph column separate from descriptions at both scroll axes', async ({ page }, testInfo) => {
  // A real 64-parent merge and three commits per branch provide wide lanes and
  // enough rows to exercise virtualization far below the initial viewport.
  const wide = join(folder, 'wide-history'); await mkdir(wide);
  const wideGit = (args: string[], input?: string, timestamp?: number) => git(['-C', wide, ...args], input, timestamp);
  wideGit(['init', '-b', 'main']);
  const blob = wideGit(['hash-object', '-w', '--stdin'], 'wide history fixture\n');
  const tree = wideGit(['mktree'], `100644 blob ${blob}\tfile.txt\n`);
  const commit = (subject: string, offset: number, parents: string[] = []) => wideGit(['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', subject], undefined, 1700000000 + offset);
  const root = commit('Wide history root', 0);
  const parents = Array.from({ length: 64 }, (_, branch) => {
    let parent = root;
    for (let step = 1; step <= 3; step++) parent = commit(`Parallel branch ${branch + 1} step ${step}`, branch * 10 + step, [parent]);
    return parent;
  });
  const merge = commit('Merge 64 parallel branches', 1000, parents);
  wideGit(['update-ref', 'refs/heads/main', merge]); wideGit(['reset', '--hard', 'main']);
  const before = await Promise.all(['HEAD', 'index'].map(name => readFile(join(wide, '.git', name))));
  const opened = await call({ action: 'open', path: wide });
  const ticket = await call({ action: 'ticket', sessionId: opened.sessionId });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/?session=${encodeURIComponent(opened.sessionId as string)}#ticket=${encodeURIComponent(ticket.ticket as string)}`);
  await expect(page.locator('.repository-title h1')).toHaveText('wide-history');
  await page.getByRole('button', { name: /提交历史/ }).first().click();
  await expect(page.getByRole('button', { name: /提交历史/ }).first()).toContainText('194');
  const row = page.locator('.commit-row[data-row="0"]');
  await expect(row.locator('.commit-subject')).toContainText('Merge 64 parallel branches');
  await expect(row.locator('.commit-graph path')).toHaveCount(64);
  const deepTop = 100 * await row.evaluate(node => node.getBoundingClientRect().height);
  const scroll = page.locator('.history-scroll');
  const pan = page.locator('.history-graph-pan');
  await expect(row.locator('.history-graph-viewport')).toBeVisible();
  await expect(pan).toBeVisible();
  expect(await pan.evaluate(node => !node.closest('.history-scroll'))).toBe(true);
  const geometry = () => scroll.evaluate(node => {
    const viewport = node.getBoundingClientRect();
    const rows = [...node.querySelectorAll('.commit-row')].filter(row => {
      const rect = row.getBoundingClientRect(); return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
    }).map(row => {
      const clipNode = row.querySelector<HTMLElement>('.history-graph-viewport')!;
      const copyNode = row.querySelector<HTMLElement>('.commit-copy')!;
      const graphNode = row.querySelector<SVGSVGElement>('.commit-graph')!;
      const clip = clipNode.getBoundingClientRect(); const copy = copyNode.getBoundingClientRect();
      const title = row.querySelector('.commit-subject')!.getBoundingClientRect();
      const graph = graphNode.getBoundingClientRect();
      const line = row.querySelector('.commit-graph path')!.getBoundingClientRect();
      let escapedGraphHits = 0;
      // Hit-test points on real SVG curves beyond the graph column. A sticky
      // opaque text overlay would still leave SVG elements in the hit stack;
      // an actual overflow clip excludes them, including to the text's right.
      for (const path of row.querySelectorAll<SVGPathElement>('.commit-graph path')) {
        const matrix = path.getScreenCTM(); if (!matrix) continue;
        for (const part of [.2, .5, .8]) {
          const point = path.getPointAtLength(path.getTotalLength() * part).matrixTransform(matrix);
          if (point.x < viewport.left + 1 || point.x > viewport.right - 1 || point.y < viewport.top + 1 || point.y > viewport.bottom - 1) continue;
          if (point.x >= clip.left + 1 && point.x <= clip.right - 1) continue;
          if (document.elementsFromPoint(point.x, point.y).some(element => element === graphNode || graphNode.contains(element))) escapedGraphHits++;
        }
      }
      return { index: row.getAttribute('data-row'), clipLeft: clip.left, clipRight: clip.right, clipWidth: clip.width, clipOverflowX: getComputedStyle(clipNode).overflowX, clipOverflowY: getComputedStyle(clipNode).overflowY, graphInClip: clipNode.contains(graphNode), independentColumns: copyNode.parentElement === clipNode.parentElement && !copyNode.contains(clipNode) && !clipNode.contains(copyNode), copyPosition: getComputedStyle(copyNode).position, copyLeft: copy.left, copyRight: copy.right, copyWidth: copy.width, titleLeft: title.left, titleRight: title.right, graphLeft: graph.left, graphWidth: graph.width, lineLeft: line.left, escapedGraphHits };
    });
    return { viewportLeft: viewport.left, viewportRight: viewport.right, viewportWidth: node.clientWidth, scrollWidth: node.scrollWidth, scrollLeft: node.scrollLeft, overflowX: getComputedStyle(node).overflowX, rows };
  });
  async function assertSeparatedColumns() {
    const current = await geometry();
    expect(current.rows.length).toBeGreaterThan(0);
    expect(['hidden', 'clip']).toContain(current.overflowX);
    expect(current.scrollWidth).toBeLessThanOrEqual(current.viewportWidth + 1);
    expect(current.scrollLeft).toBe(0);
    for (const visible of current.rows) {
      expect(['hidden', 'clip']).toContain(visible.clipOverflowX);
      expect(['hidden', 'clip']).toContain(visible.clipOverflowY);
      expect(visible.graphInClip).toBe(true);
      expect(visible.independentColumns).toBe(true);
      expect(['static', 'relative']).toContain(visible.copyPosition);
      expect(visible.graphWidth).toBeGreaterThan(visible.clipWidth);
      expect(visible.copyWidth).toBeGreaterThanOrEqual(200);
      expect(visible.clipLeft).toBeGreaterThanOrEqual(current.viewportLeft);
      expect(visible.clipRight).toBeLessThanOrEqual(visible.copyLeft);
      expect(visible.copyRight).toBeLessThanOrEqual(current.viewportRight);
      expect(visible.titleLeft).toBeGreaterThanOrEqual(visible.clipRight);
      expect(visible.titleRight).toBeLessThanOrEqual(current.viewportRight);
      expect(visible.escapedGraphHits).toBe(0);
    }
    return current;
  }
  async function assertNoGraphOverText() {
    const leaks = await scroll.evaluate(node => {
      const viewport = node.getBoundingClientRect();
      const visible = [...node.querySelectorAll('.commit-row')].find(row => {
        const rect = row.getBoundingClientRect(); return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
      })!;
      const row = visible.getBoundingClientRect();
      const clip = visible.querySelector('.history-graph-viewport')!.getBoundingClientRect();
      const graphElements = new Set(node.querySelectorAll('.commit-graph, .commit-graph *'));
      let count = 0; let first: { x: number; y: number } | undefined;
      // Scan every pixel of one complete visible row, from the graph boundary
      // through the text and right gutter. This catches lines that an opaque
      // sticky description merely covers instead of keeping in a clipped column.
      for (let y = Math.ceil(row.top) + 1; y < Math.floor(row.bottom); y++) {
        for (let x = Math.ceil(clip.right) + 1; x < Math.floor(viewport.right); x++) {
          if (document.elementsFromPoint(x, y).some(element => graphElements.has(element))) { count++; first ??= { x, y }; }
        }
      }
      return { count, first };
    });
    expect(leaks).toEqual({ count: 0, first: undefined });
  }
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    await expect.poll(() => pan.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    for (const top of [0, deepTop]) {
      await scroll.evaluate((node, top) => { node.scrollTop = top; }, top);
      await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBe(top);
      await expect(pan).toBeInViewport();
      await pan.evaluate(node => { node.scrollLeft = 0; });
      await expect.poll(() => pan.evaluate(node => node.scrollLeft)).toBe(0);
      // The DOM scroll position changes before React applies the shared SVG
      // translation. Wait for the rendered graph before recording the baseline.
      await expect.poll(async () => {
        const first = (await geometry()).rows[0]!;
        return Math.abs(first.graphLeft - first.clipLeft);
      }).toBeLessThanOrEqual(1);
      const initial = await assertSeparatedColumns();
      if (width === 390) expect(initial.rows[0]!.graphWidth).toBeGreaterThan(initial.viewportWidth);
      await assertNoGraphOverText();
      const screenshot = `history-wide${width === 1440 ? '-desktop' : ''}${top ? '-deep' : ''}`;
      await page.screenshot({ path: testInfo.outputPath(`${screenshot}-before.png`), fullPage: true });
      const maxPan = await pan.evaluate(node => { node.scrollLeft = node.scrollWidth; return node.scrollLeft; });
      expect(maxPan).toBeGreaterThan(0);
      await expect.poll(() => pan.evaluate(node => node.scrollLeft)).toBe(maxPan);
      await expect.poll(async () => {
        const moved = (await geometry()).rows[0]!;
        return Math.abs(moved.lineLeft - initial.rows[0]!.lineLeft + maxPan);
      }).toBeLessThanOrEqual(1);
      const moved = await assertSeparatedColumns();
      expect(moved.rows.map(row => row.index)).toEqual(initial.rows.map(row => row.index));
      for (let index = 0; index < moved.rows.length; index++) {
        expect(Math.abs(moved.rows[index]!.copyLeft - initial.rows[index]!.copyLeft)).toBeLessThanOrEqual(1);
        expect(Math.abs(moved.rows[index]!.titleLeft - initial.rows[index]!.titleLeft)).toBeLessThanOrEqual(1);
      }
      await assertNoGraphOverText();
      await page.screenshot({ path: testInfo.outputPath(`${screenshot}-after.png`), fullPage: true });
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await scroll.evaluate((node, top) => { node.scrollTop = top; }, deepTop);
  const deepRow = page.locator('.commit-row[data-row="100"]');
  const subject = await deepRow.locator('.commit-subject').innerText();
  await deepRow.locator('.commit-subject').click();
  await expect(page.locator('.commit-detail')).toContainText(subject);
  await page.getByRole('button', { name: '提交列表', exact: true }).click();
  await expect(deepRow).toHaveAttribute('aria-pressed', 'true');
  await deepRow.focus(); await deepRow.press('ArrowDown');
  await expect(page.locator('.commit-row[data-row="101"]')).toBeFocused();
  await expect(page.locator('.commit-row[data-row="101"]')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('End');
  await expect(page.locator('.commit-row[data-row="193"]')).toBeFocused();
  await expect(page.locator('.commit-row[data-row="193"]')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '定位 HEAD', exact: true }).click();
  await page.getByRole('button', { name: '提交列表', exact: true }).click();
  await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBe(0);
  await expect(row).toBeInViewport();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await expect(row.locator('.head-label')).toHaveText('HEAD');
  await assertSeparatedColumns();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await Promise.all(['HEAD', 'index'].map(name => readFile(join(wide, '.git', name))))).toEqual(before);
});
