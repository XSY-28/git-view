import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { OperationInput } from '@git-view/contracts';
import { randomUUID } from 'node:crypto';
import { createGitAdapter } from '../../packages/git-cli/src/index';
import { createOperations } from '../../packages/operations/src/index';
import { cleanupFixtures, repository, temporaryDirectory, fixtureGit as git, write, commit, GIT_OPERATION_TEST_TIMEOUT } from '../fixtures/git';
type WithoutFingerprint<T> = T extends unknown ? Omit<T, 'fingerprint'> : never;
afterAll(cleanupFixtures);
describe('portable repository operations', { timeout: GIT_OPERATION_TEST_TIMEOUT }, () => {
  it('stages canonical LF from CRLF without changing the worktree, then unstages, commits and switches branches', async () => {
    const root=repository(); git(root,['config','user.name','Portable Test']); git(root,['config','user.email','portable@example.invalid']); git(root,['config','commit.gpgsign','false']);
    git(root,['config','core.autocrlf','true']); git(root,['config','core.symlinks','false']); git(root,['config','core.filemode','false']);
    write(root,'中文 文件.txt','V1\r\n'); commit(root);
    write(root,'中文 文件.txt','V2\r\n');
    const read=createGitAdapter(); const session={sessionId:randomUUID(),generation:0,repository:await read.resolveRepository(root)};
    const ops=await createOperations({directory:temporaryDirectory(),read});
    async function preview(input: WithoutFingerprint<OperationInput>) { const overview=await read.readOverview(session.repository); return ops.preview(session,{...input,fingerprint:overview.fingerprint}); }
    async function execute(input: WithoutFingerprint<OperationInput>) { const p=await preview(input); const id=randomUUID(); const receipt=await ops.execute(session,p.previewId,id,true); expect(receipt, JSON.stringify(receipt)).toMatchObject({status:'succeeded'}); expect(await ops.execute(session,p.previewId,id,true)).toEqual(receipt); return receipt; }
    const before=readFileSync(path.join(root,'中文 文件.txt'));
    let overview=await read.readOverview(session.repository); await execute({kind:'stage-files',entryIds:overview.changes.unstaged.map(x=>x.id)});
    expect(git(root,['show',':中文 文件.txt'])).toBe('V2'); expect(readFileSync(path.join(root,'中文 文件.txt'))).toEqual(before);
    overview=await read.readOverview(session.repository); await execute({kind:'unstage-files',entryIds:overview.changes.staged.map(x=>x.id)}); expect(git(root,['show',':中文 文件.txt'])).toBe('V1');
    overview=await read.readOverview(session.repository); await execute({kind:'stage-files',entryIds:overview.changes.unstaged.map(x=>x.id)});
    write(root,'中文 文件.txt','V3\r\n'); await execute({kind:'commit',message:'Portable commit'}); expect(git(root,['show','HEAD:中文 文件.txt'])).toBe('V2'); expect(readFileSync(path.join(root,'中文 文件.txt'),'utf8')).toBe('V3\r\n');
    // Switch requires a clean tree. Discard only this explicitly created fixture's V3.
    git(root,['restore','--','中文 文件.txt']); await execute({kind:'create-branch',branch:'中文-test'}); expect(git(root,['branch','--show-current'])).toBe('main');
    await execute({kind:'switch-branch',branch:'中文-test'}); expect(git(root,['branch','--show-current'])).toBe('中文-test');
    expect(existsSync(path.join(root,'.git/index.lock'))).toBe(false);
  });
  it('rejects changed preview and foreign index locks without losing file content', async()=>{
    const root=repository(); write(root,'file','V1\n'); commit(root); write(root,'file','V2\n');
    const read=createGitAdapter(); const session={sessionId:randomUUID(),generation:0,repository:await read.resolveRepository(root)};
    const ops=await createOperations({directory:temporaryDirectory(),read}); const overview=await read.readOverview(session.repository);
    const p=await ops.preview(session,{kind:'stage-files',entryIds:overview.changes.unstaged.map(x=>x.id),fingerprint:overview.fingerprint});
    write(root,'file','V3\n'); const r=await ops.execute(session,p.previewId,randomUUID()); expect(r.status).toBe('failed'); expect(git(root,['show',':file'])).toBe('V1');
    const updated=await read.readOverview(session.repository); const p2=await ops.preview(session,{kind:'stage-files',entryIds:updated.changes.unstaged.map(x=>x.id),fingerprint:updated.fingerprint});
    writeFileSync(path.join(root,'.git/index.lock'),'foreign-lock'); const r2=await ops.execute(session,p2.previewId,randomUUID()); expect(r2.status).toBe('failed'); expect(readFileSync(path.join(root,'.git/index.lock'),'utf8')).toBe('foreign-lock'); expect(git(root,['show',':file'])).toBe('V1');
  });
});
