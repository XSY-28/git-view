import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = join(root, 'apps/desktop/src-tauri');
const config = JSON.parse(await readFile(join(host, 'tauri.conf.json'), 'utf8'));
const output = join(root, 'dist/installers');
await mkdir(output, { recursive: true });
let artifact;
if (process.platform === 'darwin') {
  const stage = await mkdtemp(join(tmpdir(), 'git-view-dmg-'));
  try {
    const source = join(host, 'target/release/bundle/macos/Git View.app');
    await exec('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', source, join(stage, 'Git-View.app.zip')]);
    await mkdir(join(stage, '.installer'));
    for (const name of ['install-desktop.mjs', 'verify-installed.mjs']) await copyFile(join(root, 'scripts', name), join(stage, '.installer', name));
    await copyFile(join(host, 'tauri.conf.json'), join(stage, '.installer/tauri.conf.json'));
    await copyFile(join(root, 'LICENSE'), join(stage, 'LICENSE.txt'));
    await copyFile(join(root, 'scripts/macos-install.command'), join(stage, 'Install Git View.command'));
    await chmod(join(stage, 'Install Git View.command'), 0o755);
    await writeFile(join(stage, 'READ ME.txt'), `Git View ${config.version} — macOS ${process.arch}\n\nQuit Git View, then double-click Install Git View.command.\nThe installer uses the bundled Node runtime; no Node or Rust installation is needed.\nIt installs only to ~/Applications/Git View.app and keeps previous versions as ZIP backups.\nSystem Git is required. This preview has no Developer ID signature or Apple notarization.\nIf macOS blocks it, inspect the source and use System Settings > Privacy & Security > Open Anyway.\nDo not disable Gatekeeper. Close the installer disk image after installation.\n\n退出 Git View 后，双击 Install Git View.command。安装位置固定为 ~/Applications/Git View.app。\n旧版本备份为 ZIP。需要系统 Git，无需另装 Node 或 Rust。当前预览包尚未签名或公证。\n`);
    artifact = `Git-View_${config.version}_macos-${process.arch}.dmg`;
    await exec('/usr/bin/hdiutil', ['create', '-volname', 'Git View Installer', '-srcfolder', stage, '-ov', '-format', 'UDZO', join(output, artifact)], { timeout: 180_000 });
    await exec('/usr/bin/hdiutil', ['verify', join(output, artifact)], { timeout: 120_000 });
  } finally { await rm(stage, { recursive: true, force: true }); }
} else if (process.platform === 'win32') {
  const folder = join(host, 'target/release/bundle/nsis');
  const candidates = (await readdir(folder)).filter(name => name.endsWith('-setup.exe'));
  if (candidates.length !== 1) throw new Error(`Expected one NSIS installer, found ${candidates.length}.`);
  artifact = `Git-View_${config.version}_windows-${process.arch}-setup.exe`;
  await copyFile(join(folder, candidates[0]), join(output, artifact));
} else { throw new Error('Installer packaging supports macOS and Windows only.'); }
const hash = createHash('sha256').update(await readFile(join(output, artifact))).digest('hex');
await writeFile(join(output, `${artifact}.sha256`), `${hash}  ${artifact}\n`);
console.log(JSON.stringify({ artifact: join(output, artifact), sha256: hash }));
