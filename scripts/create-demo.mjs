// Creates an isolated disposable repository; never edits the caller's repository.
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = await mkdtemp(join(tmpdir(), 'git-view-demo-'));
const git = args => execFileSync('git', ['-c', 'user.name=Git View Demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git(['init', '-b', 'main']);
await writeFile(join(root, 'hello.txt'), 'version one\n');
git(['add', '--', 'hello.txt']); git(['commit', '-m', '首次提交：写下 version one']);
await writeFile(join(root, 'hello.txt'), 'version two staged\n'); git(['add', '--', 'hello.txt']);
await writeFile(join(root, 'hello.txt'), 'version three working\n');
await writeFile(join(root, '尚未跟踪.txt'), '这个文件还没有进入暂存区。\n');
process.stdout.write(`${root}\n`);
