import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
if (process.platform !== 'darwin') throw new Error('macOS verification must run on macOS.');
const folder = resolve('dist/installers');
const images = (await readdir(folder)).filter(name => name.endsWith('.dmg'));
if (images.length !== 1) throw new Error('Expected exactly one DMG.');
const temporary = await mkdtemp(join(tmpdir(), 'git-view-mounted-'));
const mount = join(temporary, 'image');
await mkdir(mount);
let mounted = false;
try {
  await exec('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, join(folder, images[0])]);
  mounted = true;
  const command = join(mount, 'Install Git View.command');
  await exec('/bin/bash', [command, '--dry-run'], { timeout: 90_000 });
  const report = JSON.parse((await exec('/bin/bash', [command, '--verify-only'], { timeout: 120_000 })).stdout);
  report.checks.dmgMountedAndInstallerDryRun = true;
  report.checks.extractedPayloadVerified = true;
  await writeFile(join(folder, 'macos-package-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log('DMG mount, installer dry-run and extracted payload checks passed.');
} finally {
  if (mounted) await exec('/usr/bin/hdiutil', ['detach', mount]);
  await rm(temporary, { recursive: true, force: true });
}
