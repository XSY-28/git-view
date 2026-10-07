import { test, expect } from './fixtures';
import { chmodSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createGitAdapter } from '../../packages/git-cli/src/index';
import { createRepositoryQueries } from '../../packages/core/src/index';
import { startLocalServer } from '../../apps/local/src/server';
import { cleanupFixtures, commit, repository, temporaryDirectory, write } from '../fixtures/git';

test('background maintenance leaves reading stable and a real edit still updates automatically', async ({ page }) => {
  const root = repository();
  const contents = (version: string) => Array.from({ length: 400 }, (_, line) => `${version} line ${line}`).join('\n') + '\n';
  write(root, '.gitignore', 'cache/\n');
  write(root, 'file.txt', contents('base'));
  commit(root, 'watch baseline');
  write(root, 'file.txt', contents('working'));
  const server = await startLocalServer({ directory: temporaryDirectory(), webDirectory: path.resolve('dist/web'), queries: createRepositoryQueries(createGitAdapter()) });
  const call = async (fields: Record<string, unknown>) => {
    const response = await fetch(`${server.origin}/api`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${server.record.cliToken}` }, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...fields }) });
    const result = await response.json(); if (!result.ok) throw new Error(JSON.stringify(result)); return result.data;
  };
  try {
    const session = await call({ action: 'open', path: root });
    const ticket = await call({ action: 'ticket', sessionId: session.sessionId });
    const reads: string[] = [];
    page.on('request', request => {
      if (request.url().endsWith('/api') && ['overview', 'navigation', 'history', 'change'].includes(request.postDataJSON().action)) reads.push(request.postDataJSON().action);
    });
    await page.goto(`${server.origin}/?session=${session.sessionId}#ticket=${ticket.ticket}`);
    await expect(page.getByTestId('diff-scroll')).toContainText('+working line 399');
    await page.waitForResponse(response => response.url().endsWith('/api/watch'));
    await expect(page.locator('.read-feedback[data-scope="仓库状态"]')).toHaveAttribute('data-phase', 'idle');
    await page.getByTestId('diff-scroll').evaluate(node => { node.scrollTop = 450; });
    const before = [...reads];
    const objects = path.join(root, '.git/objects');
    const prefix = readdirSync(objects).find(name => /^[0-9a-f]{2}$/.test(name))!;
    const object = path.join(objects, prefix, readdirSync(path.join(objects, prefix))[0]!);
    for (let iteration = 0; iteration < 8; iteration++) {
      chmodSync(object, statSync(object).mode);
      write(root, 'cache/run.txt', String(iteration));
      await page.waitForTimeout(300);
    }
    // Cover another full polling/debounce cycle after the last background event.
    await page.waitForTimeout(1200);
    expect(reads).toEqual(before);
    expect(await page.getByTestId('diff-scroll').evaluate(node => node.scrollTop)).toBe(450);
    await expect(page.locator('.read-feedback[data-scope="仓库状态"]')).toHaveAttribute('data-phase', 'idle');
    write(root, 'file.txt', contents('external'));
    await expect(page.getByTestId('diff-scroll')).toContainText('+external line 399');
    expect(reads.filter(action => action === 'overview').length).toBeGreaterThan(before.filter(action => action === 'overview').length);
    expect(await page.getByTestId('diff-scroll').evaluate(node => node.scrollTop)).toBe(450);
  } finally { await server.close(); await cleanupFixtures(); }
});
