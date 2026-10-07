import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

// Drive the actual installed WebView2 window; no HTTP fallback or mocked IPC.
if (process.platform !== 'win32') throw new Error('Native UI verification must run on Windows.');
const executable = resolve(process.argv[2] || '');
const output = resolve('dist/installers');
const temporary = await mkdtemp(join(tmpdir(), 'git-view-native-ui-'));
const fixture = join(temporary, '中文 仓库');
const exec = promisify(execFile);
const env = { ...process.env, GIT_VIEW_HOME: join(temporary, 'state'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' };
for (const name of Object.keys(env)) if (name.startsWith('GIT_') && !['GIT_VIEW_HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(name)) delete env[name];
let child; let browser; let exited;
let diagnostic = ''; let probeFailure; let policyOverride;
const report = { platform: process.platform, arch: process.arch, executable, checks: {}, environment: 'GitHub Windows runner; installed release WebView2 window', physicalWindows10Or11: 'unverified' };
try {
  await mkdir(output, { recursive: true });
  await mkdir(fixture);
  const git = (...args) => exec('git', ['-C', fixture, ...args], { env });
  await git('init', '-b', 'main');
  await writeFile(join(fixture, '中文 文件.txt'), 'version one\n');
  await git('add', '--', '中文 文件.txt');
  await git('-c', 'user.name=Installer Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'native fixture commit');
  await writeFile(join(fixture, '中文 文件.txt'), 'version two staged\n');
  await git('add', '--', '中文 文件.txt');
  await writeFile(join(fixture, '中文 文件.txt'), 'version three working\n');
  await writeFile(join(fixture, '未跟踪.txt'), 'untracked content\n');
  const fingerprint = async () => {
    const hash = createHash('sha256');
    const walk = async path => {
      for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = join(path, item.name); hash.update(file.slice(fixture.length));
        if (item.isDirectory()) await walk(file); else hash.update(await readFile(file));
      }
    };
    await walk(fixture); return hash.digest('hex');
  };
  const before = await fingerprint();
  const server = createServer();
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  // WebView2 150+ ignores environment debug flags in elevated hosts.
  // Scope its documented HKLM override to this executable on the disposable runner,
  // and restore any previous value even when verification fails.
  const policyKey = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments';
  const policyName = basename(executable).replaceAll("'", "''");
  const elevated = (await exec('powershell.exe', ['-NoProfile', '-Command', "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"])).stdout.trim() === 'True';
  report.elevatedHost = elevated;
  if (elevated) {
    policyOverride = { key: policyKey, name: policyName, previous: JSON.parse((await exec('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference='Stop'; $k='${policyKey}'; $n='${policyName}'; $v=Get-ItemPropertyValue -LiteralPath $k -Name $n -ErrorAction SilentlyContinue; ConvertTo-Json -Compress -InputObject $v`])).stdout.trim() || 'null') };
    await exec('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference='Stop'; New-Item -Path '${policyKey}' -Force | Out-Null; New-ItemProperty -LiteralPath '${policyKey}' -Name '${policyName}' -PropertyType String -Value '--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1' -Force | Out-Null`]);
  }
  // This debugging endpoint exists only in the disposable CI process.
  child = spawn(executable, [], { env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`, WEBVIEW2_USER_DATA_FOLDER: join(temporary, 'webview') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { diagnostic += chunk; });
  child.stderr.on('data', chunk => { diagnostic += chunk; });
  exited = new Promise((resolveExit, reject) => { child.once('exit', (code, signal) => resolveExit({ code, signal })); child.once('error', reject); });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`Native app exited before WebView initialization: ${diagnostic}`);
    return fetch(`http://127.0.0.1:${port}/json/version`).then(result => { probeFailure = `HTTP ${result.status}`; return result.ok; }, error => { probeFailure = String(error.cause || error); return false; });
  }, { timeout: 60_000, message: 'Installed WebView2 must expose its real window' }).toBe(true);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await expect.poll(() => browser.contexts().flatMap(context => context.pages()).length, { timeout: 30_000 }).toBeGreaterThan(0);
  const page = browser.contexts().flatMap(context => context.pages())[0];
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('.repository-switcher-trigger')).toBeEnabled({ timeout: 30_000 });
  assert.equal(await page.evaluate(() => typeof window.__TAURI__?.core?.invoke), 'function');
  report.checks.realTauriIpcAndWebView2 = true;
  await page.locator('.repository-switcher-trigger').click();
  await page.locator('.repository-switcher-manual summary').click();
  await page.locator('#repo-path').fill(fixture);
  await page.locator('.repository-switcher-manual button').click();
  await expect(page.locator('.group-staged .file-row').filter({ hasText: '中文 文件.txt' })).toBeVisible({ timeout: 30_000 });
  report.checks.manualOpenUnicodeRepository = true;
  await page.locator('.group-staged .file-row').filter({ hasText: '中文 文件.txt' }).click();
  await expect(page.getByTestId('diff-scroll')).toContainText('+version two staged');
  await expect(page.getByTestId('diff-scroll')).toContainText('-version one');
  report.checks.stagedDiff = true;
  await page.locator('.group-unstaged .file-row').filter({ hasText: '中文 文件.txt' }).click();
  await expect(page.getByTestId('diff-scroll')).toContainText('+version three working');
  await expect(page.getByTestId('diff-scroll')).toContainText('-version two staged');
  report.checks.unstagedDiff = true;
  await page.screenshot({ path: join(output, 'windows-native-changes.png') });
  await page.getByRole('navigation', { name: /^(Main view|主视图)$/ }).getByRole('button', { name: /^(History|历史)$/ }).click();
  await page.getByTestId('commit-row').filter({ hasText: 'native fixture commit' }).click();
  await expect(page.getByTestId('diff-scroll')).toContainText('+version one');
  report.checks.historyAndCommitDiff = true;
  await page.screenshot({ path: join(output, 'windows-native-history.png') });
  assert.deepEqual(errors, []);
  report.checks.noRendererErrors = true;
  assert.equal(await fingerprint(), before);
  report.checks.repositoryFingerprintUnchanged = true;
  const nodes = JSON.parse((await exec('powershell.exe', ['-NoProfile', '-Command', `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${child.pid}" | Where-Object Name -eq 'node.exe' | Select-Object -ExpandProperty ProcessId)`])).stdout);
  assert.ok(nodes.length > 0, 'The real packaged Node sidecar must be running.');
  const consoleHandles = JSON.parse((await exec('powershell.exe', ['-NoProfile', '-Command', `
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ConsoleProbe { [DllImport("kernel32.dll")] public static extern bool FreeConsole(); [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid); [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }';
    $handles = @(${nodes.join(',')} | ForEach-Object {
      [ConsoleProbe]::FreeConsole() | Out-Null;
      if ([ConsoleProbe]::AttachConsole($_)) { [ConsoleProbe]::GetConsoleWindow().ToInt64(); [ConsoleProbe]::FreeConsole() | Out-Null } else { 0 }
    });
    ConvertTo-Json -Compress -InputObject $handles
  `])).stdout);
  assert.ok(consoleHandles.every(handle => handle === 0), 'The background Node sidecar must not allocate a console window.');
  report.checks.noSidecarConsoleWindow = true;
  await exec('powershell.exe', ['-NoProfile', '-Command', `$p = Get-Process -Id ${child.pid}; if (-not $p.CloseMainWindow()) { throw 'Native window did not accept close' }`]);
  const result = await Promise.race([exited, wait(15_000).then(() => { throw new Error('Native host did not exit after window close.'); })]);
  assert.equal(result.code, 0);
  await expect.poll(async () => (await exec('powershell.exe', ['-NoProfile', '-Command', `@(Get-Process -Id ${nodes.join(',')} -ErrorAction SilentlyContinue).Count`])).stdout.trim(), { timeout: 15_000 }).toBe('0');
  report.checks.normalWindowCloseAndSidecarCleanup = true;
  await writeFile(join(output, 'windows-native-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log('Installed Windows window, repository opening, staged/unstaged diff, history and normal exit passed.');
} catch (error) {
  const processes = child ? await exec('powershell.exe', ['-NoProfile', '-Command', `ConvertTo-Json -Depth 4 -InputObject @{ app = @(Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue | Select-Object Id,MainWindowTitle,Responding,SessionId,@{Name='WindowHandle';Expression={ [string]$_.MainWindowHandle }}); webviews = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedgewebview2.exe' -or $_.ProcessId -eq ${child.pid} -or $_.ParentProcessId -eq ${child.pid} } | Select-Object Name,ProcessId,ParentProcessId,CommandLine) }`]).then(result => result.stdout, failure => String(failure)) : '';
  await writeFile(join(output, 'windows-native-diagnostics.json'), `${JSON.stringify({ error: String(error), diagnostic, probeFailure, processes }, null, 2)}\n`);
  const screenshot = join(output, 'windows-native-desktop-failure.png').replaceAll("'", "''");
  await exec('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $r=[System.Windows.Forms.SystemInformation]::VirtualScreen; $b=New-Object System.Drawing.Bitmap($r.Width,$r.Height); $g=[System.Drawing.Graphics]::FromImage($b); try { $g.CopyFromScreen($r.Left,$r.Top,0,0,$b.Size); $b.Save('${screenshot}',[System.Drawing.Imaging.ImageFormat]::Png) } finally { $g.Dispose(); $b.Dispose() }`]).catch(failure => console.log(`Desktop screenshot unavailable: ${failure.message}`));
  if (browser) for (const page of browser.contexts().flatMap(context => context.pages())) await page.screenshot({ path: join(output, 'windows-native-failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) { await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']).catch(() => {}); await exited.catch(() => {}); }
  if (policyOverride) {
    const { key, name, previous } = policyOverride;
    const restore = previous === null
      ? `Remove-ItemProperty -LiteralPath '${key}' -Name '${name}' -ErrorAction SilentlyContinue`
      : `New-ItemProperty -LiteralPath '${key}' -Name '${name}' -PropertyType String -Value '${String(previous).replaceAll("'", "''")}' -Force | Out-Null`;
    await exec('powershell.exe', ['-NoProfile', '-Command', restore]);
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
