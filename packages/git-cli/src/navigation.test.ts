import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RepositoryIdentity } from '@git-view/contracts';
import { DEFAULT_READ_LIMITS } from './limits';
import { createNavigationReader } from './navigation';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('uses canonical filesystem paths for navigation while retaining missing worktrees and lock reasons', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'git-view-navigation-path-')); directories.push(directory);
  const root = path.join(directory, 'repository'); mkdirSync(root);
  const alias = path.join(directory, 'repository alias'); symlinkSync(root, alias, 'junction');
  const missing = path.join(directory, 'missing worktree');
  const oid = 'a'.repeat(40);
  const repository: RepositoryIdentity = { repositoryId: 'repo', worktreeId: 'tree', worktreeRoot: await realpath(root), gitDir: root, commonGitDir: root };
  const read = createNavigationReader(async (_repository, args) => args[0] === 'worktree'
    ? Buffer.from(`worktree ${alias}\0HEAD ${oid}\0branch refs/heads/main\0locked 保留\n工作区\0\0worktree ${missing}\0prunable gitdir file points to non-existent location\0\0`)
    : Buffer.alloc(0), async () => ({ kind: 'branch', branch: 'main', oid }), DEFAULT_READ_LIMITS);
  const navigation = await read(repository);
  expect(navigation.worktrees).toEqual([
    { path: repository.worktreeRoot, headOid: oid, branch: 'refs/heads/main', locked: '保留\n工作区' },
    { path: missing, prunable: 'gitdir file points to non-existent location' },
  ]);
});
