import { afterAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RepositorySession } from '@git-view/contracts';
import { createOperations } from '../../packages/operations/src/index.js';
import { storedReceiptSchema } from '../../packages/operations/src/receipts.js';
import { createGitAdapter } from '../../packages/git-cli/src/index.js';
import { createGitWriteAdapter } from '../../packages/git-write/src/index.js';
import { cleanupFixtures, commit, fixtureGit as git, repository, temporaryDirectory, write } from '../fixtures/git.js';

afterAll(cleanupFixtures);
const posixIt = process.platform === 'win32' ? it.skip : it;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

function runUntilExit(bundle: string, args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; pid: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8000); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Crash fixture timed out before its intentional SIGKILL: ${stderr}`));
    }, 20_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, pid: child.pid! });
    });
  });
}

posixIt('recovers after actual SIGKILL between index installation and final receipt, without executing twice', async () => {
  // Every Git mutation, the bundled child, and its data directory live in fixture
  // roots. No process writes to the source checkout or uses the user's repository.
  const root = repository();
  write(root, 'chosen.txt', 'V1\n'); write(root, 'other.txt', 'unchanged\n'); commit(root);
  write(root, 'chosen.txt', 'V2\n');
  const directory = temporaryDirectory();
  const bundle = path.join(temporaryDirectory(), 'operations-crash-child.mjs');
  const operationId = randomUUID();
  const importPath = (name: string) => JSON.stringify(path.join(projectRoot, `packages/${name}/src/index.ts`));
  await build({
    stdin: {
      sourcefile: 'operations-crash-child.ts', loader: 'ts', resolveDir: projectRoot,
      contents: `
        import { randomUUID } from 'node:crypto';
        import { createGitAdapter } from ${importPath('git-cli')};
        import { createGitWriteAdapter } from ${importPath('git-write')};
        import { createOperations } from ${importPath('operations')};
        const [root, directory, operationId] = process.argv.slice(2);
        const read = createGitAdapter();
        const real = createGitWriteAdapter();
        const writer = {
          ...real,
          async execute(prepared, beforeInstall) {
            await real.execute(prepared, beforeInstall);
            // The real writer has installed and synced its index, and the
            // coordinator's beforeInstall callback has synced recovery evidence.
            // Do not return to its final-receipt or lock-cleanup code.
            process.kill(process.pid, 'SIGKILL');
            await new Promise(() => {});
          },
        };
        const session = { sessionId: randomUUID(), generation: 0, repository: await read.resolveRepository(root) };
        const operations = await createOperations({ directory, read, writer });
        const overview = await read.readOverview(session.repository);
        const chosen = overview.changes.unstaged.find(entry => entry.path === 'chosen.txt');
        if (!chosen) throw new Error('Fixture change is missing.');
        const preview = await operations.preview(session, { kind: 'stage-files', entryIds: [chosen.id], fingerprint: overview.fingerprint });
        await operations.execute(session, preview.previewId, operationId);
        throw new Error('Expected SIGKILL before the coordinator returned.');
      `,
    },
    outfile: bundle, bundle: true, platform: 'node', target: 'node24', format: 'esm',
    tsconfig: path.join(projectRoot, 'tsconfig.json'), logLevel: 'silent',
  });

  const terminated = await runUntilExit(bundle, [root, directory, operationId]);
  expect(terminated, terminated.stderr).toMatchObject({ code: null, signal: 'SIGKILL' });
  const receiptFile = path.join(directory, 'operations', `${hash(operationId)}.json`);
  const pendingFile = path.join(directory, 'operations', 'pending', `${hash(operationId)}.json`);
  const interrupted = storedReceiptSchema.parse(JSON.parse(readFileSync(receiptFile, 'utf8')));
  expect(interrupted.receipt.status).toBe('running');
  expect(interrupted.receipt.finishedAt).toBeUndefined();
  expect(interrupted.pid).toBe(terminated.pid);
  expect(JSON.parse(readFileSync(pendingFile, 'utf8'))).toEqual({ schemaVersion: 1, operationId });
  expect(git(root, ['show', ':chosen.txt'])).toBe('V2');
  expect(git(root, ['show', ':other.txt'])).toBe('unchanged');
  const indexFile = path.join(interrupted.repository.gitDir, 'index');
  const installedIndex = readFileSync(indexFile);
  expect(interrupted.evidence?.expectedIndexHash).toBe(hash(installedIndex));
  const appLock = path.join(directory, 'operations', `${hash(interrupted.repository.gitDir)}.lock`);
  const originalLock = readFileSync(appLock, 'utf8');
  expect(JSON.parse(originalLock).pid).toBe(terminated.pid);

  // This is a new coordinator in a different process from the killed executor.
  // Any accidental write after restart is counted and fails the assertion, while
  // the real verifier still checks the actual repository's saved evidence.
  const read = createGitAdapter();
  const session: RepositorySession = { sessionId: randomUUID(), generation: 0, repository: await read.resolveRepository(root) };
  const real = createGitWriteAdapter(); let executionsAfterRestart = 0;
  const writer = { ...real, execute: async () => { executionsAfterRestart++; throw new Error('An interrupted operation must never execute again.'); } };
  const restarted = await createOperations({ directory, read, writer });
  const recovered = await restarted.pending(session);
  expect(recovered.receipts).toMatchObject([{ operationId, previewId: interrupted.receipt.previewId, status: 'succeeded' }]);
  const receipt = recovered.receipts[0]!;
  expect(await restarted.receipt(session, operationId)).toEqual(receipt);
  expect(await restarted.execute(session, interrupted.receipt.previewId, operationId)).toEqual(receipt);
  expect(await restarted.pending(session)).toEqual({ receipts: [] });
  expect(executionsAfterRestart).toBe(0);
  expect(readFileSync(indexFile)).toEqual(installedIndex);
  expect(readFileSync(path.join(root, 'chosen.txt'), 'utf8')).toBe('V2\n');
  expect(existsSync(pendingFile)).toBe(false);
  expect(JSON.parse(readFileSync(receiptFile, 'utf8')).receipt.status).toBe('succeeded');
  // Recovery confirms the result but deliberately leaves the dead process's
  // application lock for explicit handling; it does not delete foreign locks.
  expect(readFileSync(appLock, 'utf8')).toBe(originalLock);
});
