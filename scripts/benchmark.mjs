// Opt-in real fixture benchmark. All Git writes are confined to a new temp directory.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
const folder = await mkdtemp(join(tmpdir(), 'git-view-benchmark-'));
const repo = join(folder, 'repo'); const runtime = join(folder, 'runtime'); await mkdir(repo);
const env = { ...process.env, GIT_VIEW_HOME: runtime, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (args, input) => execFileSync('git', args, { cwd: repo, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
const cli = args => JSON.parse(execFileSync(process.execPath, [resolve('dist/cli.mjs'), ...args, '--json'], { env, encoding: 'utf8' }));
let browser; let origin; let token;
async function call(action) {
  const response = await fetch(`${origin}/api`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), ...action }) });
  const result = await response.json(); if (!result.ok) throw new Error(JSON.stringify(result)); return result.data;
}
const p95 = numbers => [...numbers].sort((a, b) => a - b)[Math.ceil(numbers.length * .95) - 1];
try {
  git(['init', '-b', 'main']);
  let stream = '';
  for (let commit = 0; commit < 10000; commit++) {
    const subject = `benchmark commit ${commit}`;
    stream += `commit refs/heads/main\ncommitter Benchmark <bench@example.invalid> ${1700000000 + commit} +0000\ndata ${Buffer.byteLength(subject)}\n${subject}\n`;
    if (commit === 0) for (let file = 0; file < 4999; file++) {
      const content = `original ${file}\n`;
      stream += `M 100644 inline file-${String(file).padStart(4, '0')}.txt\ndata ${Buffer.byteLength(content)}\n${content}`;
    }
    const content = `history ${commit}\n`;
    stream += `M 100644 inline history.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`;
  }
  git(['fast-import', '--quiet'], stream); git(['reset', '--hard', 'main']);
  for (let index = 0; index < 200; index++) await writeFile(join(repo, `file-${String(index).padStart(4, '0')}.txt`), `changed ${index}\n`);
  git(['add', '--', ...Array.from({ length: 100 }, (_, i) => `file-${String(i).padStart(4, '0')}.txt`)]);
  if (Number(git(['rev-list', '--count', 'HEAD']).trim()) !== 10000 || git(['ls-files', '-z']).split('\0').filter(Boolean).length !== 5000) throw new Error('Benchmark fixture dimensions do not match the contract.');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const coldStart = performance.now();
  const opened = cli(['open', '--repo', repo, '--no-browser']);
  if (!opened.ok) throw new Error(JSON.stringify(opened));
  const record = JSON.parse(await readFile(join(runtime, 'instance.json'), 'utf8')); origin = `http://127.0.0.1:${record.port}`; token = record.cliToken;
  const session = await call({ action: 'open', path: repo }); const ticket = await call({ action: 'ticket', sessionId: session.sessionId });
  await page.goto(`${origin}/?session=${session.sessionId}#ticket=${ticket.ticket}`);
  await page.locator('.file-row').first().waitFor();
  await page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
  const coldOpenMs = performance.now() - coldStart;
  await page.locator('.diff-content, .diff-body, .diff-lines, .diff-code').first().waitFor({ timeout: 5000 }).catch(() => {});
  const refresh = []; const diff = [];
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(750); // UI intentionally coalesces refreshes within 700 ms.
    const start = performance.now();
    const updated = page.waitForResponse(response => response.url().endsWith('/api') && response.request().postDataJSON()?.action === 'overview');
    await page.getByRole('button', { name: '刷新仓库' }).click(); await updated;
    await page.getByText('正在读取工作区…').waitFor({ state: 'hidden' });
    await page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
    refresh.push(performance.now() - start);
    const target = String(i).padStart(4, '0');
    const diffStart = performance.now();
    const response = page.waitForResponse(reply => reply.url().endsWith('/api') && reply.request().postDataJSON()?.action === 'change');
    await page.locator('.group-staged .file-row').filter({ hasText: `file-${target}.txt` }).click(); await response;
    await page.getByText(`+changed ${i}`, { exact: false }).waitFor();
    await page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
    diff.push(performance.now() - diffStart);
  }
  const report = {
    recordedAt: new Date().toISOString(), machine: { cpu: cpus()[0]?.model, memoryGiB: Math.round(totalmem() / 1024 ** 3), os: `${platform()} ${release()}`, node: process.version, git: git(['--version']).trim(), browser: await browser.version() },
    fixture: { commits: 10000, trackedFiles: 5000, changedFiles: 200, firstHistoryPage: 200 },
    conditions: { filesystem: 'warm: freshly generated fixture; OS cache not purged', applicationColdStart: 'browser already running; new daemon; open then ticket bootstrap; no application diff cache', samples: 20, filesystemCold: 'not measured', browserCold: 'not measured' },
    coldOpenMs, refreshMs: refresh, diffMs: diff, refreshP95Ms: p95(refresh), diffP95Ms: p95(diff),
    warmTargetsPass: coldOpenMs <= 3000 && p95(refresh) <= 1000 && p95(diff) <= 1000,
  };
  await writeFile(process.argv.includes('--output') ? process.argv[process.argv.indexOf('--output') + 1] : 'docs/verification/performance.json', `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ coldOpenMs, refreshP95Ms: p95(refresh), diffP95Ms: p95(diff), warmTargetsPass: report.warmTargetsPass }, null, 2)}\n`);
} finally {
  await browser?.close();
  if (origin) await call({ action: 'shutdown' }).catch(() => {});
  await rm(folder, { recursive: true, force: true });
}
