#!/usr/bin/env node
// Requires pnpm build and an existing explicit repository; never mutates that repository.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--repo' || !isAbsolute(args[1])) throw new Error('用法：node scripts/verify-lifecycle.mjs --repo <absolute-test-repository>');
const repo = args[1];
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(project, 'dist', 'cli.mjs');
const exec = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'git-view-lifecycle-'));
const runtime = join(temporary, 'runtime');
const destination = join(temporary, 'installed skill');
const installedRuntime = join(temporary, 'installed-runtime');
const env = { ...process.env, GIT_VIEW_HOME: runtime };
const invoke = async (...parameters) => JSON.parse((await exec(process.execPath, [cli, ...parameters, '--json'], { env, cwd: temporary })).stdout);
const pause = () => new Promise(resolvePause => setTimeout(resolvePause, 150));
const installed = async (...parameters) => JSON.parse((await exec(join(destination, 'bin', 'git-view'), [...parameters, '--json'], { env: { ...process.env, GIT_VIEW_HOME: installedRuntime }, cwd: temporary })).stdout);
try {
  const results = await Promise.all(Array.from({ length: 6 }, () => invoke('inspect', '--repo', repo)));
  assert(results.every(result => result.ok && result.action === 'inspect'));
  assert.equal(new Set(results.map(result => result.repository.worktreeId)).size, 1);
  assert(results.every(result => JSON.stringify(result.counts) === JSON.stringify(results[0].counts)));
  assert(results.every(result => result.observation.finishedAt && !('diff' in result) && !('text' in result)));
  const first = JSON.parse(await readFile(join(runtime, 'instance.json'), 'utf8'));
  assert.equal((await stat(join(runtime, 'instance.json'))).mode & 0o777, 0o600);
  // Every session must belong to the single discovered instance, not six hidden daemons.
  for (const result of results) {
    const bootstrap = await fetch(`http://127.0.0.1:${first.port}/api/session?sessionId=${result.observation.sessionId}`, { headers: { Authorization: `Bearer ${first.cliToken}` } });
    assert.equal(bootstrap.status, 200); assert((await bootstrap.json()).ok);
  }
  await invoke('shutdown'); await pause();
  await writeFile(join(runtime, 'instance.json'), JSON.stringify({ ...first, port: 1 }), { mode: 0o600 });
  await writeFile(join(runtime, 'startup.lock'), JSON.stringify({ ownerId: 'stale-owner', createdAt: Date.now() - 60_000 }), { mode: 0o600 });
  assert((await invoke('inspect', '--repo', repo)).ok);
  const second = JSON.parse(await readFile(join(runtime, 'instance.json'), 'utf8')); assert.notEqual(second.instanceId, first.instanceId);
  assert.equal(JSON.parse(await readFile(join(runtime, 'recents.json'), 'utf8')).repositories.length, 1);
  await invoke('shutdown'); await pause();
  await writeFile(join(runtime, 'recents.json'), 'corrupt');
  assert((await invoke('inspect', '--repo', repo)).ok);
  assert.equal(JSON.parse(await readFile(join(runtime, 'recents.json'), 'utf8')).repositories.length, 1);
  await invoke('shutdown'); await pause();

  await exec(process.execPath, [join(project, 'integrations', 'codex', 'install.mjs'), '--dest', destination], { cwd: temporary });
  const skill = await readFile(join(destination, 'SKILL.md'), 'utf8');
  assert(!skill.includes('__GIT_VIEW_CLI__')); assert(skill.includes(join(destination, 'bin', 'git-view')));
  assert(skill.includes(`'${join(destination, 'bin', 'git-view')}' open --repo`), 'Generated skill must shell-quote an installation path containing spaces.');
  const opened = await installed('open', '--repo', repo, '--view', 'changes', '--no-browser');
  assert.equal(opened.launchStatus, 'skipped'); assert.equal(opened.rendered, 'unverified'); assert(!opened.url.includes('#'));
  const inspected = await installed('inspect', '--repo', repo);
  assert.equal(inspected.repository.worktreeId, results[0].repository.worktreeId);
  assert.deepEqual(inspected.counts, results[0].counts);
  const record = JSON.parse(await readFile(join(installedRuntime, 'instance.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${record.port}/`);
  assert.equal(response.status, 200); assert((await response.text()).includes('<html'));
  process.stdout.write(`${JSON.stringify({ passed: true, concurrentInspects: results.length, counts: results[0].counts, singleInstanceVerified: true, staleRecordAndLockRecovered: true, recentsDedupeAndCorruptionRecovered: true, runtimeMode: '0600', temporarySkillInstalled: true, installedCliOutsideProject: true, installedStaticBuildServed: true, browserRendering: 'not checked by this script', codexSkillDiscovery: 'not checked by this script' })}\n`);
} finally {
  await Promise.all([invoke('shutdown').catch(() => {}), installed('shutdown').catch(() => {})]);
  await pause(); await rm(temporary, { recursive: true, force: true });
}
