import { test as base, expect } from '@playwright/test';

// Existing interaction suites exercise the Chinese UI explicitly. Language
// defaults and persistence have their own suite using the unmodified fixture.
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route('**/api', async route => {
      const request = route.request();
      if (request.method() === 'POST' && request.postDataJSON().action === 'preferences') {
        await route.fetch({ postData: JSON.stringify({ schemaVersion: 1, requestId: 'test-language', action: 'set-language', language: 'zh-CN' }) });
      }
      await route.fallback();
    });
    await use(context);
  },
});
export { expect };
