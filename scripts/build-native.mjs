import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function buildNativePicker() {
  if (process.platform !== 'darwin') {
    process.stdout.write('Native folder picker skipped: this platform uses manual path input.\n');
    return;
  }
  const contents = join(project, 'dist', 'FolderPicker.app', 'Contents');
  const executable = join(contents, 'MacOS', 'FolderPicker');
  const temporary = await mkdtemp(join(tmpdir(), 'git-view-swift-build-'));
  await mkdir(dirname(executable), { recursive: true });
  try {
    const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`;
    await execute('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', '-target', target, '-module-cache-path', join(temporary, 'module-cache'), '-framework', 'AppKit', join(project, 'apps', 'local', 'native', 'FolderPicker.swift'), '-o', executable], { cwd: project, timeout: 120_000, maxBuffer: 1024 * 1024, env: { ...process.env, CLANG_MODULE_CACHE_PATH: join(temporary, 'clang-cache') } });
    await copyFile(join(project, 'apps', 'local', 'native', 'Info.plist'), join(contents, 'Info.plist'));
    await chmod(executable, 0o755);
    process.stdout.write('Built dist/FolderPicker.app (AppKit; no Swift compiler needed at runtime).\n');
  } catch (error) {
    throw new Error('Native folder picker build failed. Install/select Apple Command Line Tools or Xcode, then rerun pnpm build.', { cause: error });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildNativePicker();
