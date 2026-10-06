import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, lstatSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// All fixture mutations are confined to directories created here, never the user's checkout.
const fixtureRoots = new Set<string>();
let isolation: { config: string; hooks: string } | undefined;
function fixtureConfiguration() {
  if (!isolation) {
    const directory = temporaryDirectory();
    const config = path.join(directory, 'empty.config');
    const hooks = path.join(directory, 'empty-hooks');
    writeFileSync(config, ''); mkdirSync(hooks);
    isolation = { config, hooks };
  }
  return isolation;
}
export function temporaryDirectory(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'git-view-fixture-'));
  fixtureRoots.add(root);
  return root;
}
function assertFixture(root: string) {
  if (![...fixtureRoots].some((fixture) => root === fixture || root.startsWith(`${fixture}${path.sep}`))) throw new Error('Git writes must stay inside an explicitly created temporary fixture.');
}
export function fixtureGit(root: string, args: string[], input?: string | Buffer): string {
  assertFixture(root);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  const isolated = fixtureConfiguration();
  return execFileSync('git', ['-c', `core.hooksPath=${isolated.hooks}`, '-c', 'commit.gpgsign=false', ...args], {
    cwd: root, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: isolated.config, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
  }).trim();
}
export function repository(): string {
  const root = temporaryDirectory();
  fixtureGit(root, ['init', '-b', 'main']);
  return root;
}
export function write(root: string, name: string, content: string | Buffer) {
  assertFixture(root);
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  writeFileSync(path.join(root, name), content);
}
export function commit(root: string, message = 'fixture commit'): string {
  fixtureGit(root, ['add', '--all']);
  fixtureGit(root, ['commit', '-m', message]);
  return fixtureGit(root, ['rev-parse', 'HEAD']);
}
export function fingerprint(root: string): string {
  const digest = createHash('sha256');
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const stat = lstatSync(full);
      digest.update(path.relative(root, full)).update(String(stat.mode));
      if (stat.isSymbolicLink()) digest.update(readlinkSync(full));
      else if (stat.isDirectory()) visit(full);
      else digest.update(readFileSync(full));
    }
  };
  visit(root);
  return digest.digest('hex');
}
export function cleanupFixtures() {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  fixtureRoots.clear();
  isolation = undefined;
}
