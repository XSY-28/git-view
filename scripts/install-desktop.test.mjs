import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fingerprint, installDesktop, repairDesktopSearch } from './install-desktop.mjs';

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
  let searchPid = 900;
  const run = async (command, args) => {
    calls.push({ command, args });
    const intercepted = await intercept?.(command, args, { source, destination });
    if (intercepted !== undefined) return intercepted;
    if (command === '/bin/launchctl') {
      if (args[0] === 'print' && args[1].endsWith('/com.apple.campo')) {
        return { stdout: `state = running\npid = ${searchPid}\n` };
      }
      if (args[0] === 'kickstart' && args.at(-1).endsWith('/com.apple.campo')) {
        searchPid += 1;
        return { stdout: '' };
      }
      throw new Error('No such search service');
    }
    if (command.endsWith('/lsregister') && args[0] === '-dump') {
      return { stdout: `path: ${destination} (0xabc)\nidentifier: local.git-view.desktop\n` };
    }
    if (command.endsWith('/lsregister') || command === '/bin/ps') return { stdout: '', stderr: '' };
    assert.ok(['/usr/bin/plutil', '/usr/bin/ditto', '/usr/bin/unzip'].includes(command));
    return execute(command, args);
  };
  return { root, home, source, destination, calls, run, wait: async () => {} };
}

macTest('a successful update refreshes the search service after bundle cleanup', async t => {
  const f = await fixture(t);
  const result = await installDesktop(f);
  const restart = f.calls.findIndex(call => call.command === '/bin/launchctl' && call.args[0] === 'kickstart');
  const lastCleanup = f.calls.findLastIndex(call => call.command.endsWith('/lsregister') && call.args[0] === '-u');
  assert.ok(restart > lastCleanup && lastCleanup >= 0, 'search must reload the final application list');
  assert.equal(result.searchRefresh.status, 'refreshed');
  assert.equal(result.searchRefresh.state, 'running');
  assert.notEqual(result.searchRefresh.pid, result.searchRefresh.previousPid);
  assert.equal(await exists(f.source), false);
});

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

macTest('update readiness works before a bundle exists and makes no changes', async t => {
  const f = await fixture(t);
  await rm(f.source, { recursive: true });
  const before = await fingerprint(f.home);
  const result = await installDesktop({ ...f, checkReady: true });
  assert.equal(result.status, 'ready');
  assert.equal(await fingerprint(f.home), before);
  assert.ok(f.calls.every(call => call.command === '/bin/ps'));
});

macTest('update readiness rejects a running app before building a new copy', async t => {
  const f = await fixture(t, { intercept: (command, args, paths) => command === '/bin/ps' ? { stdout: `42 ${paths.destination}/Contents/MacOS/git-view-desktop\n` } : undefined });
  await rm(f.source, { recursive: true });
  const before = await fingerprint(f.home);
  await assert.rejects(installDesktop({ ...f, checkReady: true }), /Quit Git View/);
  assert.equal(await exists(f.source), false);
  assert.equal(await fingerprint(f.home), before);
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

macTest('consecutive iterations retain one latest app, ZIP backups, and refresh search each time', async t => {
  const f = await fixture(t);
  const original = await fingerprint(f.destination);
  const firstBuild = await fingerprint(f.source);
  const first = await installDesktop(f);
  await bundle(f.source, 'second iteration');
  const secondBuild = await fingerprint(f.source);
  assert.notEqual(secondBuild, firstBuild);
  const second = await installDesktop(f);
  assert.equal(await fingerprint(f.destination), secondBuild);
  assert.equal(await exists(f.source), false);
  assert.deepEqual(await readdir(join(f.home, 'Applications')), ['Git View.app']);
  const backups = await readdir(join(f.home, 'Library/Application Support/Git View/backups'));
  assert.equal(backups.length, 2);
  assert.ok(backups.every(name => name.endsWith('.zip')));
  for (const [result, expected, directory] of [
    [first, original, 'restore-original'],
    [second, firstBuild, 'restore-first'],
  ]) {
    const restore = join(f.home, directory);
    await execute('/usr/bin/ditto', ['-x', '-k', result.archive, restore]);
    assert.equal(await fingerprint(join(restore, 'Git View.app')), expected);
    assert.equal(result.searchRefresh.state, 'running');
    assert.notEqual(result.searchRefresh.pid, result.searchRefresh.previousPid);
  }
  assert.equal(second.searchRefresh.previousPid, first.searchRefresh.pid);
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
  await assert.rejects(installDesktop(f), /Latest Git View is installed.*post-install cleanup\/search refresh failed/);
  assert.equal(await fingerprint(f.destination), latest);
  assert.equal(await fingerprint(f.source), latest);
  assert.deepEqual(await readdir(join(f.home, 'Applications')), ['Git View.app']);
});

macTest('an unregistered build is accepted only after the registration dump confirms it is absent', async t => {
  const f = await fixture(t, { intercept: (command, args, paths) => {
    if (command.endsWith('/lsregister') && args[0] === '-u') throw new Error('failed to unregister: -10814');
    if (command.endsWith('/lsregister') && args[0] === '-dump') {
      return { stdout: `path: ${paths.destination} (0xabc)\nidentifier: local.git-view.desktop\n--------------------------------\npath: /Applications/Unrelated.app (0xdef)\nidentifier: com.example.unrelated\n` };
    }
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

macTest('search repair works without a build copy and never changes the installed files', async t => {
  const f = await fixture(t);
  await rm(f.source, { recursive: true });
  const before = await fingerprint(f.home);
  const result = await repairDesktopSearch(f);
  assert.equal(result.status, 'refreshed');
  assert.equal(result.gui, 'unverified');
  assert.equal(await fingerprint(f.home), before);
  assert.equal(await exists(f.source), false);
});

macTest('search repair dry-run changes neither files, registration, nor search processes', async t => {
  const f = await fixture(t);
  const before = await fingerprint(f.home);
  const result = await repairDesktopSearch({ ...f, dryRun: true });
  assert.equal(result.status, 'planned');
  assert.equal(await fingerprint(f.home), before);
  assert.ok(f.calls.every(({ command, args }) => command === '/usr/bin/plutil' ||
    (command.endsWith('/lsregister') && args[0] === '-dump') ||
    (command === '/bin/launchctl' && args[0] === 'print')));
});

macTest('search repair removes only absent Git View registrations and preserves unrelated records', async t => {
  let removed = false;
  let orphan;
  const f = await fixture(t, { intercept: (command, args, paths) => {
    if (!command.endsWith('/lsregister')) return undefined;
    orphan = join(paths.destination, '..', 'Deleted Git View.app');
    if (args[0] === '-u' && args[1] === orphan) { removed = true; return { stdout: '' }; }
    if (args[0] === '-dump') {
      return { stdout: [
        `path: ${paths.destination} (0xabc)\nidentifier: local.git-view.desktop`,
        ...(!removed ? [`path: ${orphan} (0xdef)\nidentifier: local.git-view.desktop`] : []),
        'path: /Applications/Unrelated.app (0x123)\nidentifier: com.example.unrelated',
      ].join('\n--------------------------------\n') };
    }
  } });
  const before = await fingerprint(f.home);
  const result = await repairDesktopSearch(f);
  assert.deepEqual(result.removedRegistrations, [orphan]);
  assert.equal(await fingerprint(f.home), before);
  assert.ok(!f.calls.some(call => call.args[0] === '-u' && call.args[1] === '/Applications/Unrelated.app'));
});

macTest('a live extra app is reported and is never deleted or unregistered', async t => {
  let duplicate;
  const f = await fixture(t, { intercept: (command, args, paths) => {
    if (command.endsWith('/lsregister') && args[0] === '-dump') {
      return { stdout: [paths.destination, duplicate].map(path => `path: ${path} (0xabc)\nidentifier: local.git-view.desktop`).join('\n--------------------------------\n') };
    }
  } });
  duplicate = join(f.home, 'Another directory/Git View.app');
  await bundle(duplicate, 'other live copy');
  const before = await fingerprint(f.home);
  await assert.rejects(repairDesktopSearch(f), /Another Git View application exists/);
  assert.equal(await fingerprint(f.home), before);
  assert.ok(!f.calls.some(call => call.args[0] === '-u' || call.args[0] === 'kickstart'));
});

macTest('a failed search restart starts the service again instead of leaving it stopped', async t => {
  let pid = 900;
  const f = await fixture(t, { intercept: (command, args) => {
    if (command !== '/bin/launchctl') return undefined;
    if (args[0] === 'print') return { stdout: pid ? `state = running\npid = ${pid}\n` : 'state = exited\n' };
    if (args[0] === 'kickstart' && args.includes('-k')) {
      pid = null;
      throw new Error('restart failed after stopping the old process');
    }
    if (args[0] === 'kickstart') { pid = 901; return { stdout: '' }; }
  } });
  const before = await fingerprint(f.home);
  const result = await repairDesktopSearch(f);
  assert.equal(result.status, 'refreshed');
  assert.equal(result.recoveryAttempted, true);
  assert.equal(result.state, 'running');
  assert.equal(pid, 901);
  assert.equal(await fingerprint(f.home), before);
});

macTest('an immediate clean exit is recovered before search refresh is reported as successful', async t => {
  let phase = 'old';
  let freshObserved = false;
  const f = await fixture(t, { intercept: (command, args) => {
    if (command !== '/bin/launchctl') return undefined;
    if (args[0] === 'kickstart') {
      phase = args.includes('-k') ? 'briefly running' : 'recovered';
      return { stdout: '' };
    }
    if (args[0] === 'print') {
      if (phase === 'old') return { stdout: 'state = running\npid = 900\n' };
      if (phase === 'recovered') return { stdout: 'state = running\npid = 902\n' };
      if (!freshObserved) { freshObserved = true; return { stdout: 'state = running\npid = 901\n' }; }
      return { stdout: 'state = exited\nlast exit code = 0\n' };
    }
  } });
  const result = await repairDesktopSearch(f);
  assert.equal(result.pid, 902);
  assert.equal(result.recoveryAttempted, true);
});

macTest('a search failure preserves the committed latest installation and a retry command', async t => {
  const f = await fixture(t, { intercept: (command, args) => {
    if (command === '/bin/launchctl' && args[0] === 'kickstart') throw new Error('search service unavailable');
  } });
  const latest = await fingerprint(f.source);
  await assert.rejects(installDesktop(f), /Latest Git View is installed.*Retry pnpm repair:desktop-search/);
  assert.equal(await fingerprint(f.destination), latest);
  assert.equal(await exists(f.source), false);
  assert.deepEqual(await readdir(join(f.home, 'Applications')), ['Git View.app']);
});

macTest('search repair uses the legacy Spotlight service when Campo is not loaded', async t => {
  let pid = 800;
  const f = await fixture(t, { intercept: (command, args) => {
    if (command !== '/bin/launchctl') return undefined;
    if (args[0] === 'print' && args[1].endsWith('/com.apple.campo')) throw new Error('No such service');
    if (args[0] === 'print') return { stdout: `state = running\npid = ${pid}\n` };
    if (args[0] === 'kickstart') { pid = 801; return { stdout: '' }; }
  } });
  const result = await repairDesktopSearch(f);
  assert.equal(result.service, 'com.apple.Spotlight');
  assert.equal(result.status, 'refreshed');
  assert.equal(result.pid, 801);
});

macTest('a SIP-protected service is refreshed by ending only its verified owned app process', async t => {
  let oldAlive = true;
  let pid = 900;
  const f = await fixture(t, { intercept: (command, args) => {
    if (command === '/bin/launchctl') {
      if (args[0] === 'print') return { stdout: `state = running\npid = ${pid}\n` };
      if (args.includes('-k')) throw Object.assign(new Error('System Integrity Protection is engaged'), { code: 150 });
      if (args[0] === 'kickstart') { if (!oldAlive) pid = 901; return { stdout: '' }; }
    }
    if (command === '/bin/ps' && args[0] === '-p') {
      return { stdout: oldAlive ? `${process.getuid()} /System/Applications/Siri AI.app/Contents/MacOS/Siri AI\n` : '' };
    }
    if (command === '/bin/kill') {
      assert.deepEqual(args, ['-TERM', '900']);
      oldAlive = false;
      return { stdout: '' };
    }
  } });
  const before = await fingerprint(f.home);
  const result = await repairDesktopSearch(f);
  assert.equal(result.status, 'refreshed');
  assert.equal(result.restartMethod, 'owned-process');
  assert.equal(result.pid, 901);
  assert.equal(await fingerprint(f.home), before);
});

macTest('a search app ignoring TERM is verified again before KILL and restored', async t => {
  let oldAlive = true;
  let pid = 900;
  const signals = [];
  const f = await fixture(t, { intercept: (command, args) => {
    if (command === '/bin/launchctl') {
      if (args[0] === 'print') return { stdout: `state = running\npid = ${pid}\n` };
      if (args.includes('-k')) throw Object.assign(new Error('System Integrity Protection is engaged'), { code: 150 });
      if (args[0] === 'kickstart') { if (!oldAlive) pid = 901; return { stdout: '' }; }
    }
    if (command === '/bin/ps' && args[0] === '-p') {
      return { stdout: oldAlive ? `${process.getuid()} /System/Applications/Siri AI.app/Contents/MacOS/Siri AI\n` : '' };
    }
    if (command === '/bin/kill') {
      assert.equal(args[1], '900');
      signals.push(args[0]);
      if (args[0] === '-KILL') oldAlive = false;
      return { stdout: '' };
    }
  } });
  const result = await repairDesktopSearch(f);
  assert.deepEqual(signals, ['-TERM', '-KILL']);
  for (const index of f.calls.keys()) {
    if (f.calls[index].command === '/bin/kill') assert.equal(f.calls[index - 1].command, '/bin/ps');
  }
  assert.equal(result.pid, 901);
  assert.equal(result.state, 'running');
});

macTest('search restart never signals a PID whose owner or executable does not match', async t => {
  for (const identity of [
    `${process.getuid() + 1} /System/Applications/Siri AI.app/Contents/MacOS/Siri AI`,
    `${process.getuid()} /Applications/Unrelated.app/Contents/MacOS/Unrelated`,
  ]) {
    const f = await fixture(t, { intercept: (command, args) => {
      if (command === '/bin/launchctl') {
        if (args[0] === 'print') return { stdout: 'state = running\npid = 900\n' };
        if (args.includes('-k')) throw Object.assign(new Error('System Integrity Protection is engaged'), { code: 150 });
        return { stdout: '' };
      }
      if (command === '/bin/ps' && args[0] === '-p') return { stdout: `${identity}\n` };
    } });
    const before = await fingerprint(f.home);
    await assert.rejects(repairDesktopSearch(f), /Refusing to stop an unverified search process/);
    assert.ok(f.calls.every(call => call.command !== '/bin/kill'));
    assert.equal(await fingerprint(f.home), before);
  }
});
