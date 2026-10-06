import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultPreferences, preferencesSchema, requestSchema } from '@git-view/contracts';
import { PreferencesStore } from './storage';
import { startLocalServer, type RepositoryQueries } from './server';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'git-view-language-')); directories.push(path); return path; }

describe('application language preferences', () => {
  it('defaults to English and restores the last saved language from disk', async () => {
    const path = await directory();
    const store = new PreferencesStore(path);
    expect(await store.read()).toEqual(defaultPreferences);
    await store.setLanguage('zh-CN');
    expect(await new PreferencesStore(path).read()).toEqual({ schemaVersion: 1, language: 'zh-CN' });
    await store.setLanguage('en');
    expect(await new PreferencesStore(path).read()).toEqual(defaultPreferences);
    // Windows stat does not represent separate owner/group/other permissions.
    // Persistence above is cross-platform; the private mode is a POSIX check.
    if (process.platform !== 'win32') {
      expect((await stat(join(path, 'preferences.json'))).mode & 0o777).toBe(0o600);
    }
  });
  it('serializes rapid changes and can save again after a failed write', async () => {
    const path = await directory(); const store = new PreferencesStore(path);
    await Promise.all([store.setLanguage('zh-CN'), store.setLanguage('en'), store.setLanguage('zh-CN')]);
    expect((await store.read()).language).toBe('zh-CN');
    // A directory cannot be atomically replaced with a settings file.
    await rm(join(path, 'preferences.json')); await mkdir(join(path, 'preferences.json'));
    await expect(store.setLanguage('en')).rejects.toThrow();
    await rm(join(path, 'preferences.json'), { recursive: true });
    await store.setLanguage('zh-CN');
    expect((await store.read()).language).toBe('zh-CN');
  });
  it('uses English for corrupt, unsupported, or future settings without rewriting them', async () => {
    const path = await directory(); const file = join(path, 'preferences.json');
    for (const content of ['invalid json', '{"schemaVersion":1,"language":"fr"}', '{"schemaVersion":2,"language":"zh-CN"}']) {
      await writeFile(file, content);
      expect(await new PreferencesStore(path).read()).toEqual(defaultPreferences);
      expect(await readFile(file, 'utf8')).toBe(content);
    }
  });
  it('validates supported language values at the transport boundary', () => {
    const request = { schemaVersion: 1, action: 'set-language', requestId: 'language' };
    expect(requestSchema.safeParse({ ...request, language: 'zh-CN' }).success).toBe(true);
    expect(requestSchema.safeParse({ ...request, language: 'fr' }).success).toBe(false);
    expect(requestSchema.safeParse({ ...request, language: 'en', path: '/repo' }).success).toBe(false);
    expect(preferencesSchema.safeParse({ schemaVersion: 1, language: 'en' }).success).toBe(true);
  });
  it('requires authentication and restores preferences when the local host restarts', async () => {
    const path = await directory();
    const queries: RepositoryQueries = {
      open: async () => { throw new Error('No repository needed for language preferences'); },
      getSession: () => { throw new Error('No repository needed for language preferences'); },
      execute: async () => { throw new Error('Preferences must be handled by the application service'); },
    };
    let server = await startLocalServer({ directory: path, queries });
    const request = async (action: string, language?: string, authorized = true) => fetch(`${server.origin}/api`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${server.record.cliToken}` } : {}) },
      body: JSON.stringify({ schemaVersion: 1, requestId: 'language', action, ...(language ? { language } : {}) }),
    });
    try {
      expect((await request('preferences', undefined, false)).status).toBe(403);
      expect((await request('set-language', 'zh-CN', false)).status).toBe(403);
      expect((await (await request('preferences')).json()).data.language).toBe('en');
      expect((await request('set-language', 'fr')).status).toBe(400);
      expect((await (await request('set-language', 'zh-CN')).json()).data.language).toBe('zh-CN');
      await server.close(); server = await startLocalServer({ directory: path, queries });
      expect((await (await request('preferences')).json()).data.language).toBe('zh-CN');
    } finally { await server.close(); }
  });
});
