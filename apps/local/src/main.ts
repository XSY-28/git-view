import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepositoryQueries } from '@git-view/core';
import { createGitAdapter } from '@git-view/git-cli';
import { startLocalServer } from './server';
import { dataDirectory } from './storage';
import { createNativeFolderPicker } from './folder-picker';

try {
  const distribution = dirname(fileURLToPath(import.meta.url));
  const server = await startLocalServer({
    queries: createRepositoryQueries(createGitAdapter()), directory: dataDirectory(),
    webDirectory: join(distribution, 'web'),
    pickFolder: createNativeFolderPicker(join(distribution, 'FolderPicker.app', 'Contents', 'MacOS', 'FolderPicker')),
  });
  const stop = () => { void server.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch {
  // Daemon diagnostics intentionally omit secrets, source, and repository paths.
  process.stderr.write('Git View 本地进程启动失败。\n');
  process.exitCode = 1;
}
