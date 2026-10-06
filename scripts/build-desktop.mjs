import { spawn } from 'node:child_process';
import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = join(root, 'apps/desktop/src-tauri');
const resources = join(host, 'resources');
const args = process.argv.slice(2);
if (args.some(arg => !['--prepare-only', '--debug'].includes(arg))) throw new Error('Usage: build-desktop.mjs [--prepare-only] [--debug]');
if (process.versions.node.split('.')[0] !== '24') throw new Error('Build with the locked Node 24 runtime.');
await rm(resources, { recursive: true, force: true });
await mkdir(join(resources, 'runtime'), { recursive: true });
await mkdir(join(resources, 'app'), { recursive: true });
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
await copyFile(process.execPath, join(resources, 'runtime', nodeName));
await copyFile(join(root, 'apps/desktop/licenses', `node-${process.version}-LICENSE`), join(resources, 'runtime', 'NODE-LICENSE'));
await chmod(join(resources, 'runtime', nodeName), 0o755);
const bundledFiles = [nodeName];
for (const entry of ['stdio.mjs', 'inspect.mjs']) {
  await copyFile(join(root, 'dist', entry), join(resources, 'app', entry));
  bundledFiles.push(entry);
}
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const hostManifest = JSON.parse(await readFile(join(host, 'tauri.conf.json'), 'utf8'));
await writeFile(join(resources, 'app', 'build-info.json'), JSON.stringify({
  schemaVersion: 1, hostVersion: hostManifest.version, coreVersion: manifest.version, nodeVersion: process.version,
  platform: process.platform, arch: process.arch, builtAt: new Date().toISOString(),
  sourceRevision: process.env.GITHUB_SHA || process.env.GIT_VIEW_BUILD_REVISION || null,
  releaseRef: process.env.GITHUB_REF_NAME || null,
  dependencies: { ...manifest.dependencies, ...manifest.devDependencies },
  cargoLockSha256: await digest(join(host, 'Cargo.lock')),
  signing: 'unsigned-test-build', files: Object.fromEntries(await Promise.all(bundledFiles.map(async file => [file, await digest(join(resources, file === nodeName ? 'runtime' : 'app', file))]))),
}, null, 2));
if (!args.includes('--prepare-only')) {
  const localCargo = join(root, '.tooling', 'cargo');
  const env = { ...process.env };
  const hasLocalRust = await access(join(localCargo, 'bin', 'rustc')).then(() => true, () => false);
  if (hasLocalRust) {
    env.CARGO_HOME = process.env.CARGO_HOME || localCargo;
    env.RUSTUP_HOME = process.env.RUSTUP_HOME || join(root, '.tooling', 'rustup');
    env.PATH = `${join(env.CARGO_HOME, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`;
  }
  const tauriCli = join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [tauriCli, 'build', ...(args.includes('--debug') ? ['--debug'] : [])], { cwd: host, env, stdio: 'inherit', shell: false });
    child.once('error', reject); child.once('exit', code => resolveResult(code));
  });
  if (result !== 0) process.exit(result || 1);
}
console.log(`Desktop resources prepared for ${process.platform}/${process.arch}; runtime is bundled.`);
