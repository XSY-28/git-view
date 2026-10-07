import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { duplicateFiles } from './check-duplicate-files.mjs';

test('finds identical and diverged copies without treating standalone numbered names as copies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'git-view-copy-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['apps/web', 'packages/core', 'tests', 'docs', 'apps/desktop/target']) await mkdir(join(root, path), { recursive: true });
  const files = {
    'AGENTS.md': 'original', 'AGENTS 2.md': 'original',
    'apps/web/View.tsx': 'current', 'apps/web/View 2.tsx': 'older',
    'packages/core/query.ts': 'same', 'packages/core/query 12.ts': 'same',
    'tests/flow.spec.ts': 'test', 'tests/flow.spec 2.ts': 'copy',
    'docs/chapter 2.md': 'legitimate standalone numbered name',
    'apps/desktop/target/bundle.json': 'generated', 'apps/desktop/target/bundle 2.json': 'generated',
  };
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  const found = await duplicateFiles(root);
  assert.deepEqual(found.map(path => path.replaceAll('\\', '/')).sort(), ['AGENTS 2.md', 'apps/web/View 2.tsx', 'packages/core/query 12.ts', 'tests/flow.spec 2.ts']);
  for (const path of found) await rm(join(root, path));
  assert.deepEqual(await duplicateFiles(root), []);
});
