#!/usr/bin/env node
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--dest' || !isAbsolute(args[1]))) throw new Error('用法：node integrations/codex/install.mjs [--dest <absolute-skill-directory>]');
const destination = args[1] || join(homedir(), '.codex', 'skills', 'git-view');
const root = resolve(here, '../..');
await Promise.all(['cli.mjs', 'server.mjs', 'web/index.html'].map(file => lstat(join(root, 'dist', file))));
if (await lstat(destination).catch(() => undefined)) throw new Error('安装目录已存在。请先按 README 卸载旧版，避免覆盖其他文件。');
const temporary = `${destination}.install-${randomUUID()}`;
await mkdir(dirname(destination), { recursive: true });
try {
  await mkdir(join(temporary, 'bin'), { recursive: true });
  await cp(join(root, 'dist'), join(temporary, 'runtime'), { recursive: true });
  const quoteShell = value => `'${value.replaceAll("'", "'\\''")}'`;
  const skill = (await readFile(join(here, 'skill', 'SKILL.md'), 'utf8')).replaceAll('__GIT_VIEW_CLI__', quoteShell(join(destination, 'bin', 'git-view')));
  await writeFile(join(temporary, 'SKILL.md'), skill);
  const nodeExecutable = JSON.stringify(process.execPath);
  await writeFile(join(temporary, 'bin', 'git-view'), `#!/usr/bin/env node\nimport { spawnSync } from 'node:child_process';\nimport { dirname, resolve } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst result = spawnSync(${nodeExecutable}, [resolve(dirname(fileURLToPath(import.meta.url)), '../runtime/cli.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' });\nif (result.error) { process.stderr.write('Git View runtime could not start.\\n'); process.exit(1); }\nprocess.exit(result.status ?? 1);\n`, { mode: 0o755 });
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(temporary, 'INSTALLATION.json'), JSON.stringify({ schemaVersion: 1, installedAt: new Date().toISOString(), nodeExecutable: process.execPath, requires: 'Node.js 24+' }, null, 2));
  await rename(temporary, destination);
} catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
process.stdout.write(`已安装 Git View skill：${destination}\n重新打开 Codex 会话以发现 skill。\n`);
