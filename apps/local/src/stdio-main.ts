import { createRepositoryQueries } from '@git-view/core';
import { createGitAdapter } from '@git-view/git-cli';
import { runStdio } from './stdio';
import { dataDirectory } from './storage';
try {
  const service = await runStdio(createRepositoryQueries(createGitAdapter()), dataDirectory(), process.stdin, process.stdout);
  const close = () => { service.close(); process.stdin.destroy(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
} catch { process.stderr.write('Git View 桌面查询进程启动失败。\n'); process.exitCode = 1; }
