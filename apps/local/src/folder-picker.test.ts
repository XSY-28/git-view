import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeFolderPicker } from './folder-picker';

const temporary: string[] = [];
async function helper(body: string) {
  const directory = await mkdtemp(join(tmpdir(), 'git-view-picker-test-')); temporary.push(directory);
  const executable = join(directory, 'helper with spaces.mjs');
  await writeFile(executable, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return { executable, directory };
}
async function waitForFile(path: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await stat(path).catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Test helper did not start.');
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('native folder picker process boundary (no UI launched)', () => {
  it('preserves a selected absolute folder with Unicode, quotes, spaces and newlines', async () => {
    const path = '/tmp/中文 repo/quote\'"/line\nbreak';
    const script = await helper(`process.stdout.write(${JSON.stringify(JSON.stringify({ cancelled: false, path }))});`);
    const picker = createNativeFolderPicker(script.executable, 'darwin');
    expect(await picker()).toEqual({ cancelled: false, path });
  });

  it('treats native cancel as a successful choice, without inventing a repository', async () => {
    const script = await helper('process.stdout.write(JSON.stringify({cancelled:true}));');
    const picker = createNativeFolderPicker(script.executable, 'darwin');
    expect(await picker()).toEqual({ cancelled: true });
    expect(await picker()).toEqual({ cancelled: true });
  });

  it('rejects non-macOS, missing and relative executables with a usable fallback error', async () => {
    await expect(createNativeFolderPicker('/missing/picker', 'linux')()).rejects.toMatchObject({ code: 'PICKER_UNAVAILABLE' });
    await expect(createNativeFolderPicker('/missing/picker', 'darwin')()).rejects.toMatchObject({ code: 'PICKER_UNAVAILABLE' });
    await expect(createNativeFolderPicker('relative/picker', 'darwin')()).rejects.toMatchObject({ code: 'PICKER_UNAVAILABLE' });
  });

  it.each([
    ['malformed JSON', 'process.stdout.write("not JSON");'],
    ['relative selection', 'process.stdout.write(JSON.stringify({cancelled:false,path:"relative"}));'],
    ['NUL selection', 'process.stdout.write(JSON.stringify({cancelled:false,path:"/tmp/a\\0b"}));'],
    ['invalid UTF-8', 'process.stdout.write(Buffer.from([0xff,0xfe]));'],
    ['helper failure', 'process.stderr.write("private diagnostic"); process.exit(1);'],
  ])('rejects %s without exposing helper diagnostics', async (_name, body) => {
    const script = await helper(body);
    await expect(createNativeFolderPicker(script.executable, 'darwin')()).rejects.toMatchObject({ code: 'PICKER_UNAVAILABLE' });
  });

  it('does not spawn after an already-aborted request', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createNativeFolderPicker('/missing/picker', 'darwin')(controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('keeps the gate busy through abort until the original child has exited', async () => {
    const script = await helper(`import {existsSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path'; import {fileURLToPath} from 'node:url';
const marker=join(dirname(fileURLToPath(import.meta.url)), 'ready');
if (existsSync(marker)) { process.stdout.write(JSON.stringify({cancelled:true})); }
else { process.on('SIGTERM', () => setTimeout(()=>process.exit(0), 100)); writeFileSync(marker,String(process.pid)); setInterval(()=>{},1000); }`);
    const controller = new AbortController();
    const picker = createNativeFolderPicker(script.executable, 'darwin', { killGraceMs: 500 });
    const pending = picker(controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await waitForFile(join(script.directory, 'ready'));
    const pid = Number(await readFile(join(script.directory, 'ready'), 'utf8'));
    await expect(picker()).rejects.toMatchObject({ code: 'PICKER_BUSY' });
    controller.abort();
    await expect(picker()).rejects.toMatchObject({ code: 'PICKER_BUSY' });
    await rejected;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await picker()).toEqual({ cancelled: true });
  });

  it('times out and force-kills an unresponsive helper before releasing the gate', async () => {
    const script = await helper(`process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`);
    const picker = createNativeFolderPicker(script.executable, 'darwin', { timeoutMs: 120, killGraceMs: 20 });
    await expect(picker()).rejects.toMatchObject({ code: 'TIMEOUT' });
    // A completed timeout releases the gate; a new invocation reaches its own timeout.
    await expect(picker()).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it.each(['stdout', 'stderr'])('bounds %s output and kills the helper', async stream => {
    const script = await helper(`process.${stream}.write('x'.repeat(1024)); setInterval(()=>{},1000);`);
    await expect(createNativeFolderPicker(script.executable, 'darwin', { maxOutputBytes: 128, killGraceMs: 20 })()).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
  });
});
