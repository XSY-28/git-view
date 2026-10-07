import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as waitFor } from 'node:timers/promises';

const execute = promisify(execFile);
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const bundleId = 'local.git-view.desktop';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const exists = path => lstat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

// Refuse symlinked destinations so a fixed install path cannot redirect writes.
async function checkParents(path) {
  let current = path;
  while (current !== dirname(current)) {
    if (await exists(current)) {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`);
    }
    current = dirname(current);
  }
}

export async function fingerprint(directory) {
  const digest = createHash('sha256');
  const walk = async (path, relative = '') => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink in application: ${path}`);
    digest.update(JSON.stringify([relative, info.mode & 0o777, info.isDirectory()]));
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(join(path, name), `${relative}/${name}`);
    } else if (info.isFile()) digest.update(await readFile(path));
    else throw new Error(`Unsupported application entry: ${path}`);
  };
  await walk(directory);
  return digest.digest('hex');
}

async function validateBundle(path, run, expectedVersion) {
  const info = JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(path, 'Contents/Info.plist')])).stdout);
  if (info.CFBundleIdentifier !== bundleId || info.CFBundleExecutable !== 'git-view-desktop' ||
      info.CFBundleName !== 'Git View' || typeof info.CFBundleShortVersionString !== 'string' ||
      (expectedVersion && info.CFBundleShortVersionString !== expectedVersion)) {
    throw new Error(`Unexpected Git View bundle identity/version: ${path}`);
  }
  const build = JSON.parse(await readFile(join(path, 'Contents/Resources/app/build-info.json'), 'utf8'));
  if (build.schemaVersion !== 1 || build.platform !== 'darwin' ||
      !['arm64', 'x64'].includes(build.arch) || build.hostVersion !== info.CFBundleShortVersionString ||
      !Number.isFinite(Date.parse(build.builtAt))) throw new Error(`Invalid build-info: ${path}`);
  const files = { node: 'runtime/node', 'stdio.mjs': 'app/stdio.mjs', 'inspect.mjs': 'app/inspect.mjs' };
  if (JSON.stringify(Object.keys(build.files ?? {}).sort()) !== JSON.stringify(Object.keys(files).sort())) {
    throw new Error(`Unexpected build-info file manifest: ${path}`);
  }
  for (const [name, relative] of Object.entries(files)) {
    const expected = build.files[name];
    if (!/^[a-f0-9]{64}$/.test(expected) || sha256(await readFile(join(path, 'Contents/Resources', relative))) !== expected) {
      throw new Error(`Packaged resource checksum mismatch: ${name}`);
    }
  }
  const executable = join(path, 'Contents/MacOS/git-view-desktop');
  if (!((await lstat(executable)).mode & 0o111)) throw new Error(`Application executable is not executable: ${executable}`);
  return { version: build.hostVersion, builtAt: build.builtAt, fingerprint: await fingerprint(path) };
}

async function requireStopped(run, paths) {
  const output = (await run('/bin/ps', ['-axo', 'pid=,comm='])).stdout;
  for (const line of output.split('\n')) {
    const entry = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!entry) continue;
    const command = entry[2];
    // A distribution installer runs this script with the incoming bundle's
    // own Node. Exempt only this exact process, never another app or sidecar.
    if (Number(entry[1]) === process.pid && command === process.execPath) continue;
    if (command.endsWith('/Contents/MacOS/git-view-desktop') || paths.some(path => command.startsWith(`${path}/Contents/`))) {
      throw new Error('Git View is running. Quit Git View, then rerun the desktop update/install command. No process was stopped.');
    }
  }
}

async function unregister(path, run) {
  try { await run(lsregister, ['-u', path]); }
  catch (error) {
    if (!`${error.message}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`.includes('-10814')) throw error;
    const dump = (await run(lsregister, ['-dump'], { maxBuffer: 32 * 1024 * 1024 })).stdout;
    const registered = [...dump.matchAll(/^\s*path:\s*(.+)$/gm)].map(match => match[1].replace(/\s+\(0x[0-9a-f]+\)\s*$/i, '').trim());
    if (registered.includes(path)) throw error;
  }
}

async function removeBuildCopy(source, expectedFingerprint, run) {
  // Isolate this particular directory before waiting on Launch Services. A new
  // build at the original path must never become the target of our removal.
  const isolated = join(dirname(source), `.git-view-installed-${randomUUID()}.bundle`);
  await rename(source, isolated);
  try {
    if (await fingerprint(isolated) !== expectedFingerprint) throw new Error('The build changed during installation.');
    await unregister(source, run);
    // Launch Services may have followed the directory rename.
    await unregister(isolated, run);
  } catch (error) {
    let preserved = isolated;
    if (!(await exists(source))) {
      // Do not replace another build if it appeared after the previous check.
      // mkdir reserves the name; rename only replaces this empty reservation.
      try {
        await mkdir(source);
        await rename(isolated, source);
        preserved = source;
      } catch { /* Preserve the isolated directory for manual recovery. */ }
    }
    throw new Error(`${error.message} Build files preserved at ${preserved}`, { cause: error });
  }
  await rm(isolated, { recursive: true });
  if (await exists(source)) throw new Error('A concurrent build created another application. It was kept; rerun installation after the build finishes.');
}

async function registeredApplications(run) {
  const { stdout } = await run(lsregister, ['-dump'], { maxBuffer: 32 * 1024 * 1024 });
  return stdout.split(/\n-{10,}\n/).flatMap(record => {
    if (!/^identifier:\s+local\.git-view\.desktop\s*$/m.test(record)) return [];
    const path = /^path:\s+(.+)$/m.exec(record)?.[1].replace(/\s+\(0x[0-9a-f]+\)\s*$/i, '').trim();
    return path ? [path] : [];
  });
}

function searchState(stdout) {
  return {
    state: /^\s*state = (\S+)/m.exec(stdout)?.[1],
    pid: Number(/^\s*pid = (\d+)/m.exec(stdout)?.[1]) || null,
  };
}

async function searchService(run, uid) {
  let stopped;
  for (const label of ['com.apple.campo', 'com.apple.Spotlight']) {
    const target = `gui/${uid}/${label}`;
    try {
      const state = searchState((await run('/bin/launchctl', ['print', target])).stdout);
      const service = { label, target, ...state };
      if (state.state === 'running' && state.pid) return service;
      stopped ??= service;
    } catch { /* The other service may be used by this macOS version. */ }
  }
  if (stopped) return stopped;
  throw new Error('No Spotlight service is loaded in this user login session.');
}

async function stopOwnedSearchProcess(service, uid, run, wait) {
  const executable = {
    'com.apple.campo': '/System/Applications/Siri AI.app/Contents/MacOS/Siri AI',
    'com.apple.Spotlight': '/System/Library/CoreServices/Spotlight.app/Contents/MacOS/Spotlight',
  }[service.label];
  const stillOwned = async () => {
    let stdout;
    try { ({ stdout } = await run('/bin/ps', ['-p', String(service.pid), '-o', 'uid=,comm='])); }
    catch (error) {
      if (error.code === 1) return false; // ps returns 1 when the process has exited.
      throw error;
    }
    if (!stdout.trim()) return false;
    const identity = /^\s*(\d+)\s+(.+?)\s*$/.exec(stdout);
    if (!executable || Number(identity?.[1]) !== uid || identity?.[2] !== executable) {
      throw new Error(`Refusing to stop an unverified search process: ${service.pid}.`);
    }
    return true;
  };
  // SIP can block launchctl -k for this protected GUI job. End only the app
  // owned by this user, then start the loaded job without changing its settings.
  for (const signal of ['-TERM', '-KILL']) {
    if (!(await stillOwned())) return;
    try { await run('/bin/kill', [signal, String(service.pid)]); }
    catch (error) {
      if (!(await stillOwned())) return;
      throw error;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(100);
      if (!(await stillOwned())) return;
    }
  }
  throw new Error(`Search process did not exit: ${service.pid}.`);
}

async function refreshSearchService(service, uid, run, wait) {
  const waitUntilRunning = async () => {
    let observedPid;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const state = searchState((await run('/bin/launchctl', ['print', service.target])).stdout);
        if (state.state === 'running' && state.pid && state.pid !== service.pid) {
          if (state.pid === observedPid) return state;
          observedPid = state.pid;
        } else observedPid = undefined;
      } catch { observedPid = undefined; }
      await wait(100);
    }
    throw new Error('Search service did not reach a stable running state with a fresh process.');
  };
  let state;
  let recoveryAttempted = false;
  let restartMethod = service.pid ? 'launchctl' : 'start';
  try {
    try {
      await run('/bin/launchctl', ['kickstart', ...(service.pid ? ['-k'] : []), service.target]);
    } catch (error) {
      if (!service.pid || !(error.code === 150 || /System Integrity Protection/i.test(`${error.message}\n${error.stderr ?? ''}`))) throw error;
      restartMethod = 'owned-process';
      await stopOwnedSearchProcess(service, uid, run, wait);
      await run('/bin/launchctl', ['kickstart', service.target]);
    }
    state = await waitUntilRunning();
  } catch (restartError) {
    // A failed restart must not leave the search shortcut without its service.
    recoveryAttempted = true;
    try {
      await run('/bin/launchctl', ['kickstart', service.target]);
      state = await waitUntilRunning();
    } catch (error) {
      let current;
      try { current = searchState((await run('/bin/launchctl', ['print', service.target])).stdout).state; }
      catch { current = 'unavailable'; }
      throw new Error(`Could not refresh ${service.label}; service state: ${current}. ${restartError.message} Retry pnpm repair:desktop-search.`, { cause: error });
    }
  }
  return { status: 'refreshed', service: service.label, previousPid: service.pid, ...state, restartMethod, recoveryAttempted, gui: 'unverified' };
}

// Repair also works after the build copy was consumed by a previous installation.
export async function repairDesktopSearch({ home = homedir(), dryRun = false, run = execute,
  platform = process.platform, uid = process.getuid?.(), wait = waitFor } = {}) {
  if (platform !== 'darwin') throw new Error('Desktop search repair currently supports macOS only.');
  if (!Number.isInteger(uid) || uid < 0) throw new Error('Cannot determine the user login session.');
  home = await realpath(home);
  const destination = join(home, 'Applications/Git View.app');
  await checkParents(destination);
  const build = await validateBundle(destination, run);
  const registrations = await registeredApplications(run);
  const stale = [];
  for (const path of registrations) {
    if (path === destination) continue;
    if (await exists(path) && await realpath(path) !== destination) {
      throw new Error(`Another Git View application exists at ${path}. Archive that copy before repairing search.`);
    }
    stale.push(path);
  }
  const service = await searchService(run, uid);
  if (dryRun) return { dryRun: true, destination, build, staleRegistrations: stale, searchService: service.label, status: 'planned' };
  for (const path of stale) await unregister(path, run);
  await run(lsregister, ['-f', destination]);
  const remaining = await registeredApplications(run);
  if (remaining.length !== 1 || remaining[0] !== destination) {
    throw new Error(`Git View registration is still not unique: ${remaining.join(', ') || 'missing'}.`);
  }
  return { destination, build, removedRegistrations: stale, ...await refreshSearchService(service, uid, run, wait) };
}

// root/home/run are injected only by tests; the CLI always uses the fixed paths.
export async function installDesktop({ root = project, home = homedir(), dryRun = false, checkReady = false, run = execute,
  platform = process.platform, uid = process.getuid?.(), wait = waitFor } = {}) {
  if (platform !== 'darwin') throw new Error('install:desktop currently supports macOS only.');
  root = await realpath(root);
  home = await realpath(home);
  const source = join(root, 'apps/desktop/src-tauri/target/release/bundle/macos/Git View.app');
  const applications = join(home, 'Applications');
  const destination = join(applications, 'Git View.app');
  const backups = join(home, 'Library/Application Support/Git View/backups');
  await checkParents(source);
  await checkParents(destination);
  await checkParents(backups);
  const config = JSON.parse(await readFile(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
  if (config.identifier !== bundleId) throw new Error('Unexpected desktop configuration identifier.');
  if (checkReady) {
    if (await exists(join(applications, '.git-view-install.lock'))) throw new Error('Another desktop installation may be running. Wait before updating.');
    await requireStopped(run, [source, destination]);
    return { status: 'ready', destination };
  }
  if (!(await exists(source))) throw new Error('Release bundle is missing. Run pnpm build and pnpm build:desktop first.');
  const sourceInfo = await validateBundle(source, run, config.version);
  const hadPrevious = await exists(destination);
  const previousInfo = hadPrevious ? await validateBundle(destination, run) : null;
  await requireStopped(run, [source, destination]);
  const plan = { dryRun, source, destination, build: sourceInfo, previousBuild: previousInfo, backupDirectory: hadPrevious ? backups : null };
  if (dryRun) return { ...plan, searchRefresh: { status: 'planned', gui: 'unverified' } };

  await mkdir(applications, { recursive: true });
  const lock = join(applications, '.git-view-install.lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another installation may be running. Check before removing the lock: ${lock}`);
    throw error;
  }
  let stage;
  let archive;
  let movedPrevious = false;
  let placedNew = false;
  let committed = false;
  try {
    if (await exists(destination) !== hadPrevious || (hadPrevious && await fingerprint(destination) !== previousInfo.fingerprint)) {
      throw new Error('The installed application changed before the installation lock was acquired; retry.');
    }
    stage = await mkdtemp(join(applications, '.git-view-install-'));
    const next = join(stage, 'next.bundle');
    const previous = join(stage, 'previous.bundle');
    await run('/usr/bin/ditto', [source, next]);
    if (await fingerprint(next) !== sourceInfo.fingerprint) throw new Error('Build changed while copying; installed application was not replaced.');
    if (hadPrevious) {
      await mkdir(backups, { recursive: true });
      archive = join(backups, `Git-View-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.zip`);
      await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', destination, archive]);
      await run('/usr/bin/unzip', ['-t', archive]);
      if (await fingerprint(destination) !== previousInfo.fingerprint) throw new Error('Existing installation changed during backup; retry after it stops changing.');
    }
    await requireStopped(run, [source, destination]);
    if (hadPrevious) { await rename(destination, previous); movedPrevious = true; }
    await rename(next, destination);
    placedNew = true;
    if (await fingerprint(destination) !== sourceInfo.fingerprint) throw new Error('Installed application does not match the verified build.');
    await run(lsregister, ['-f', destination]);
    committed = true;
    await removeBuildCopy(source, sourceInfo.fingerprint, run);
    if (movedPrevious) await unregister(previous, run);
    await rm(stage, { recursive: true });
    stage = undefined;
    const searchRefresh = await repairDesktopSearch({ home, run, platform, uid, wait });
    return { ...plan, archive: archive ?? null, installed: true, buildCopyRemoved: true, searchRefresh };
  } catch (error) {
    if (!committed) {
      try {
        if (placedNew) {
          // Registration can fail after a partial update. Recovery of files must
          // still proceed when Launch Services itself is unavailable.
          await run(lsregister, ['-u', destination]).catch(() => {});
          await rm(destination, { recursive: true });
        }
        if (movedPrevious) await rename(join(stage, 'previous.bundle'), destination);
        if (hadPrevious && movedPrevious) await run(lsregister, ['-f', destination]);
      } catch (rollbackError) {
        // Preserve the stage when automatic recovery fails; never delete the old app.
        throw new Error(`Installation failed and recovery needs attention. Preserved files: ${stage}; ZIP: ${archive ?? 'none'}. ${rollbackError.message}`, { cause: error });
      }
    }
    if (stage) await rm(stage, { recursive: true });
    stage = undefined;
    if (committed) throw new Error(`Latest Git View is installed at ${destination}, but post-install cleanup/search refresh failed: ${error.message}`, { cause: error });
    throw error;
  } finally {
    if (committed && stage) await rm(stage, { recursive: true });
    await rm(lock, { recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.some(arg => !['--dry-run', '--repair-search', '--check-ready'].includes(arg)) ||
        (args.includes('--repair-search') && args.includes('--check-ready'))) {
      throw new Error('Usage: node scripts/install-desktop.mjs [--dry-run] [--repair-search | --check-ready]');
    }
    const options = { dryRun: args.includes('--dry-run'), checkReady: args.includes('--check-ready') };
    console.log(JSON.stringify(await (args.includes('--repair-search') ? repairDesktopSearch(options) : installDesktop(options)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
