import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const roots = ['apps', 'packages', 'tests', 'scripts', 'docs'];
const generated = new Set(['node_modules', '.git', 'dist', 'target', 'resources', 'gen', 'test-results', 'playwright-report']);

/** A numbered sibling of an existing file is a copy candidate, regardless of its contents. */
export async function duplicateFiles(root) {
  const copies = [];
  async function scan(directory, descend = true) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const files = new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name));
    for (const entry of entries) {
      if (entry.isDirectory() && descend && !generated.has(entry.name)) await scan(join(directory, entry.name));
      if (!entry.isFile()) continue;
      const original = entry.name.replace(/ [1-9][0-9]*(?=\.[^.]+$)/, '');
      if (original !== entry.name && files.has(original)) copies.push(relative(root, join(directory, entry.name)));
    }
  }
  await scan(root, false);
  for (const name of roots) await scan(join(root, name));
  return copies.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const copies = await duplicateFiles(process.cwd());
  if (copies.length) {
    console.error(`Numbered file copies found. Compare and archive them outside the project before removing:\n${copies.join('\n')}`);
    process.exitCode = 1;
  } else console.log('No numbered file copies found.');
}
