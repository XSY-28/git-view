import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const args = process.argv.slice(2);
const appIndex = args.indexOf('--app');
const outputIndex = args.indexOf('--output');
if (appIndex < 0 || !args[appIndex + 1] || args.some((arg, i) => !['--app', '--output'].includes(arg) && i !== appIndex + 1 && i !== outputIndex + 1)) throw new Error('Usage: verify-installed.mjs --app <app-bundle-or-installed-directory> [--output <report.json>]');
const source = resolve(args[appIndex + 1]);
const temporary = await mkdtemp(join(tmpdir(), 'git-view-installed-'));
const installed = join(temporary, '中文 安装目录', basename(source));
const fixture = join(temporary, '中文 仓库');
const report = { schemaVersion: 1, platform: process.platform, arch: process.arch, installedFrom: source, checks: {}, gui: 'unverified', signedOrPublished: false };
try {
  await mkdir(join(temporary, '中文 安装目录'), { recursive: true });
  await cp(source, installed, { recursive: true });
  const executable = process.platform === 'darwin' ? join(installed, 'Contents/MacOS/git-view-desktop') : join(installed, 'git-view-desktop.exe');
  const resources = process.platform === 'darwin' ? join(installed, 'Contents/Resources') : installed;
  report.buildInfo = JSON.parse(await readFile(join(resources, 'app/build-info.json'), 'utf8'));
  const runtime = join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  assert.match(await readFile(join(resources, 'runtime', 'NODE-LICENSE'), 'utf8'), /Node\.js is licensed/);
  report.checks.packagedNodeLicensePresent = true;
  for (const [name, expected] of Object.entries(report.buildInfo.files)) {
    const file = name === 'node' || name === 'node.exe' ? runtime : join(resources, 'app', name);
    assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), expected);
  }
  report.checks.resourceChecksumsMatch = true;
  // Only system Git is discoverable. Inspect must start its packaged Node by absolute path.
  const gitExecutable = process.platform === 'win32' ? (await exec('where.exe', ['git.exe'])).stdout.trim().split(/\r?\n/)[0] : (await exec('/usr/bin/which', ['git'])).stdout.trim();
  const gitDirectory = resolve(gitExecutable, '..');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { PATH: process.platform === 'win32' ? `${gitDirectory};${process.env.SystemRoot}\\System32` : '/usr/bin:/bin', GIT_VIEW_HOME: join(temporary, 'private-state'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
  delete env.NODE_PATH; delete env.NODE_OPTIONS;
  await mkdir(fixture);
  const git = async (...gitArgs) => exec(gitExecutable, ['-C', fixture, ...gitArgs], { env });
  await git('init', '-b', 'main');
  await writeFile(join(fixture, '中文 文件.txt'), 'V1\n');
  await git('add', '--', '中文 文件.txt');
  await git('-c', 'user.name=Installed Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  await writeFile(join(fixture, '中文 文件.txt'), 'V2\n');
  await git('add', '--', '中文 文件.txt');
  await writeFile(join(fixture, '中文 文件.txt'), 'V3\n');
  await writeFile(join(fixture, '未跟踪.txt'), 'local only\n');
  const fingerprint = async directory => {
    const digest = createHash('sha256');
    const walk = async path => {
      for (const entry of (await readdir(path)).sort()) {
        const file = join(path, entry); const info = await stat(file);
        digest.update(file.slice(directory.length));
        if (info.isDirectory()) await walk(file); else digest.update(await readFile(file));
      }
    };
    await walk(directory); return digest.digest('hex');
  };
  const before = await fingerprint(fixture);
  report.artifactSha256 = await fingerprint(installed);
  report.nativeExecutableSha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
  const inspect = JSON.parse((await exec(executable, ['inspect', '--repo', fixture, '--json'], { env, timeout: 30_000 })).stdout);
  assert.equal(inspect.ok, true); assert.equal(inspect.action, 'inspect');
  assert.equal(inspect.counts.staged, 1); assert.equal(inspect.counts.unstaged, 1); assert.equal(inspect.counts.untracked, 1);
  assert.equal(inspect.repository.worktreeRoot, await realpath(fixture));
  report.checks.packagedInspectWithoutExternalNode = true;
  report.checks.unicodeAndSpaces = true;
  assert.equal(await fingerprint(fixture), before);
  report.checks.repositoryFingerprintUnchanged = true;
  let invalid;
  try { await exec(executable, ['inspect', '--repo', join(temporary, 'missing'), '--json'], { env, timeout: 30_000 }); }
  catch (error) { invalid = JSON.parse(error.stdout); }
  assert.equal(invalid?.ok, false); assert.equal(invalid.error.code, 'INVALID_REPOSITORY');
  report.checks.invalidRepositoryIsError = true;
  const child = spawn(runtime, [join(resources, 'app/stdio.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const response = await new Promise((resolveResponse, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Packaged stdio timeout')); }, 10_000);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) { clearTimeout(timeout); try { resolveResponse(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); } } });
    child.once('error', reject);
    child.stdin.write(`${JSON.stringify({ id: 'installed-heartbeat', operation: 'request', request: { schemaVersion: 1, requestId: 'installed-heartbeat', action: 'heartbeat' } })}\n`);
  });
  assert.equal(response.id, 'installed-heartbeat'); assert.equal(response.response.ok, true);
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  child.stdin.end();
  const exit = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => { child.kill(); reject(new Error('Stdio child remained after stdin EOF')); }, 10_000).unref())]);
  assert.equal(exit.code, 0);
  report.checks.packagedStdioAndEofCleanup = true;
  console.log(JSON.stringify(report, null, 2));
  if (outputIndex >= 0) await writeFile(resolve(args[outputIndex + 1]), `${JSON.stringify(report, null, 2)}\n`);
} finally { await rm(temporary, { recursive: true, force: true }); }
