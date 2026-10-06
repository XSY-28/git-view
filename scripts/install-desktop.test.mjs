import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fingerprint, installDesktop } from './install-desktop.mjs';

const execute = promisify(execFile);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const exists = path => lstat(path).then(() => true, () => false);
const macTest = (name, body) => test(name, { skip: process.platform !== 'darwin' }, body);

async function bundle(path, revision) {
  await mkdir(join(path, 'Contents/MacOS'), { recursive: true });
  await mkdir(join(path, 'Contents/Resources/runtime'), { recursive: true });
  await mkdir(join(path, 'Contents/Resources/app'), { recursive: true });
  await writeFile(join(path, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>local.git-view.desktop</string>
    <key>CFBundleName</key><string>Git View</string>
    <key>CFBundleExecutable</key><string>git-view-desktop</string>
    <key>CFBundleShortVersionString</key><string>0.2.0</string>
  </dict></plist>`);
  await writeFile(join(path, 'Contents/MacOS/git-view-desktop'), `test executable ${revision}`);
  await chmod(join(path, 'Contents/MacOS/git-view-desktop'), 0o755);
  const files = {};
  for (const name of ['node', 'stdio.mjs', 'inspect.mjs']) {
    const content = `${name} ${revision}`;
    await writeFile(join(path, 'Contents/Resources', name === 'node' ? 'runtime' : 'app', name), content);
    files[name] = sha256(content);
  }
  await writeFile(join(path, 'Contents/Resources/app/build-info.json'), JSON.stringify({
    schemaVersion: 1, platform: 'darwin', arch: 'arm64', hostVersion: '0.2.0', builtAt: '2026-10-06T08:52:26.517Z', files,
  }));
}

async function fixture(t, { previous = true, intercept } = {}) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'git-view-installer-test-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, '项目');
  const home = join(temporary, 'home');
  const source = join(root, 'apps/desktop/src-tauri/target/release/bundle/macos/Git View.app');
  const destination = join(home, 'Applications/Git View.app');
  await mkdir(home, { recursive: true });
  await bundle(source, 'new');
  await writeFile(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), JSON.stringify({ identifier: 'local.git-view.desktop', version: '0.2.0' }));
  if (previous) await bundle(destination, 'old');
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    const intercepted = await intercept?.(command, args, { source, destination });
    if (intercepted !== undefined) return intercepted;
    if (command.endsWith('/lsregister') || command === '/bin/ps') return { stdout: '', stderr: '' };
    assert.ok(['/usr/bin/plutil', '/usr/bin/ditto', '/usr/bin/unzip'].includes(command));
    return execute(command, args);
  };
  return { root, home, source, destination, calls, run };
}

macTest('dry-run verifies real bundles and makes no filesystem or registration changes', async t => {
  const f = await fixture(t);
  const before = await fingerprint(f.home);
  const sourceBefore = await fingerprint(f.source);
  const result = await installDesktop({ ...f, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(await fingerprint(f.home), before);
  assert.equal(await fingerprint(f.source), sourceBefore);
  assert.ok(f.calls.every(call => ['/usr/bin/plutil', '/bin/ps'].includes(call.command)));
});

macTest('updates one installed bundle, preserves the old bytes in ZIP, and removes the build copy', async t => {
  const f = await fixture(t);
  const latest = await fingerprint(f.source);
  const previous = await fingerprint(f.destination);
  const result = await installDesktop(f);
  assert.equal(await fingerprint(f.destination), latest);
  assert.equal(await exists(f.source), false);
  assert.deepEqual(await readdir(join(f.home, 'Applications')), ['Git View.app']);
  const restore = join(f.home, 'restore');
  await execute('/usr/bin/ditto', ['-x', '-k', result.archive, restore]);
  assert.equal(await fingerprint(join(restore, 'Git View.app')), previous);
  const registrations = f.calls.filter(call => call.command.endsWith('/lsregister')).map(call => call.args);
  assert.deepEqual(registrations.slice(0, 2), [['-f', f.destination], ['-u', f.source]]);
  assert.equal(registrations[2][0], '-u');
  assert.match(registrations[2][1], /\/\.git-view-installed-[^/]+\.bundle$/);
});

macTest('first install creates the fixed destination without a backup', async t => {
  const f = await fixture(t, { previous: false });
  const latest = await fingerprint(f.source);
  const result = await installDesktop(f);
  assert.equal(result.archive, null);
  assert.equal(await fingerprint(f.destination), latest);
  assert.equal(await exists(join(f.home, 'Library')), false);
});

macTest('running installation is rejected before writing files or stopping processes', async t => {
  const f = await fixture(t, { intercept: (command, args, paths) => command === '/bin/ps' ? { stdout: `42 ${paths.destination}/Contents/MacOS/git-view-desktop\n` } : undefined });
  const before = await fingerprint(f.home);
  await assert.rejects(installDesktop(f), /Quit Git View/);
  assert.equal(await fingerprint(f.home), before);
  assert.ok(f.calls.every(call => ['/usr/bin/plutil', '/bin/ps'].includes(call.command)));
});

macTest('damaged build resource is rejected before installation', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'Contents/Resources/app/stdio.mjs'), 'corrupt');
  const before = await fingerprint(f.home);
  await assert.rejects(installDesktop(f), /checksum mismatch/);
  assert.equal(await fingerprint(f.home), before);
});

macTest('registration failure restores the original installation and retains the build', async t => {
  let registrations = 0;
  const f = await fixture(t, { intercept: command => {
    if (command.endsWith('/lsregister') && ++registrations === 1) throw new Error('test registration failure');
  } });
  const previous = await fingerprint(f.destination);
  const sourceBefore = await fingerprint(f.source);
  await assert.rejects(installDesktop(f), /test registration failure/);
  assert.equal(await fingerprint(f.destination), previous);
  assert.equal(await fingerprint(f.source), sourceBefore);
  assert.deepEqual(await readdir(join(f.home, 'Applications')), ['Git View.app']);
});

macTest('backup failure leaves the old installation and build untouched', async t => {
  const f = await fixture(t, { intercept: (command, args) => {
    if (command === '/usr/bin/ditto' && args.includes('-c')) throw new Error('test archive failure');
  } });
  const previous = await fingerprint(f.destination);
  const sourceBefore = await fingerprint(f.source);
  await assert.rejects(installDesktop(f), /test archive failure/);
  assert.equal(await fingerprint(f.destination), previous);
  assert.equal(await fingerprint(f.source), sourceBefore);
  assert.deepEqual(await readdir(join(f.home, 'Applications')), ['Git View.app']);
});

macTest('cleanup failure keeps the verified latest installation and reports the remaining copy', async t => {
  const f = await fixture(t, { intercept: (command, args) => {
    if (command.endsWith('/lsregister') && args[0] === '-u') throw new Error('test unregister failure');
  } });
  const latest = await fingerprint(f.source);
  await assert.rejects(installDesktop(f), /Latest Git View is installed.*duplicate cleanup failed/);
  assert.equal(await fingerprint(f.destination), latest);
  assert.equal(await fingerprint(f.source), latest);
  assert.deepEqual(await readdir(join(f.home, 'Applications')), ['Git View.app']);
});

macTest('an unregistered build is accepted only after the registration dump confirms it is absent', async t => {
  const f = await fixture(t, { intercept: (command, args) => {
    if (command.endsWith('/lsregister') && args[0] === '-u') throw new Error('failed to unregister: -10814');
    if (command.endsWith('/lsregister') && args[0] === '-dump') return { stdout: 'path: /Applications/Unrelated.app (0xabc)\n' };
  } });
  const result = await installDesktop(f);
  assert.equal(result.buildCopyRemoved, true);
  assert.ok(f.calls.some(call => call.args[0] === '-dump'));
});

macTest('an unregister error with a remaining exact registration retains the build', async t => {
  const f = await fixture(t, { intercept: (command, args, paths) => {
    if (command.endsWith('/lsregister') && args[0] === '-u') throw new Error('failed to unregister: -10814');
    if (command.endsWith('/lsregister') && args[0] === '-dump') return { stdout: `path:                       ${paths.source} (0x1ab0)\n` };
  } });
  const latest = await fingerprint(f.source);
  await assert.rejects(installDesktop(f), /Build files preserved at/);
  assert.equal(await fingerprint(f.source), latest);
  assert.equal(await fingerprint(f.destination), latest);
});

macTest('a concurrent build created during unregister is retained instead of removed', async t => {
  const f = await fixture(t, { intercept: async (command, args, paths) => {
    if (command.endsWith('/lsregister') && args[0] === '-u' && args[1] === paths.source) {
      await bundle(paths.source, 'concurrent new build');
      return { stdout: '' };
    }
  } });
  const installed = await fingerprint(f.source);
  await assert.rejects(installDesktop(f), /concurrent build created another application/);
  assert.equal(await fingerprint(f.destination), installed);
  assert.notEqual(await fingerprint(f.source), installed);
  assert.deepEqual(await readdir(join(f.home, 'Applications')), ['Git View.app']);
});

macTest('a build changed before cleanup is retained with a precise recovery path', async t => {
  const f = await fixture(t, { intercept: async (command, args, paths) => {
    if (command.endsWith('/lsregister') && args[0] === '-f') {
      await writeFile(join(paths.source, 'Contents/MacOS/git-view-desktop'), 'concurrent executable');
      return { stdout: '' };
    }
  } });
  const installed = await fingerprint(f.source);
  await assert.rejects(installDesktop(f), /Build files preserved at/);
  assert.equal(await fingerprint(f.destination), installed);
  assert.notEqual(await fingerprint(f.source), installed);
});
