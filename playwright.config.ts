import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 60000, fullyParallel: false, workers: 1,
  reporter: 'list', use: { browserName: 'chromium', channel: 'chrome', headless: true, viewport: { width: 1440, height: 960 }, trace: 'retain-on-failure' },
});
