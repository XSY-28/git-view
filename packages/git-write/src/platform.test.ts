import { expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createOperations } from '../../operations/src/index';
import { createGitAdapter } from '../../git-cli/src/index';
import * as platform from './platform';
import { requireIndexWrites, supportsIndexWrites } from './platform';

it('refuses Windows writes until its persistence and index replacement are supported', () => {
  vi.stubEnv('GIT_VIEW_NATIVE_HELPER', undefined);
  expect(supportsIndexWrites('win32')).toBe(false);
  expect(() => requireIndexWrites('win32')).toThrow('Windows 写入需要桌面原生组件');
  expect(() => requireIndexWrites('darwin')).not.toThrow();
  vi.unstubAllEnvs();
});

it('keeps coordinator startup and pending discovery available without creating a Windows write store', async () => {
  const directory = join(tmpdir(), `git-view-disabled-writer-${randomUUID()}`);
  const support = vi.spyOn(platform, 'supportsIndexWrites').mockReturnValue(false);
  try {
    const operations = await createOperations({ directory, read: createGitAdapter() });
    await expect(operations.pending(undefined as never)).resolves.toEqual({ receipts: [] });
    await expect(operations.preview(undefined as never, undefined as never)).rejects.toMatchObject({ code: 'UNSUPPORTED_REPOSITORY' });
    await expect(operations.execute(undefined as never, '', '')).rejects.toMatchObject({ code: 'UNSUPPORTED_REPOSITORY' });
    expect(existsSync(directory)).toBe(false);
  } finally { support.mockRestore(); }
});
