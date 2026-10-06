import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  resolve: { alias: {
    '@git-view/contracts': source('./packages/contracts/src/index.ts'),
    '@git-view/core': source('./packages/core/src/index.ts'),
    '@git-view/git-cli': source('./packages/git-cli/src/index.ts'),
    '@git-view/graph-layout': source('./packages/graph-layout/src/index.ts'),
  } },
  test: { include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/integration/**/*.test.ts'], testTimeout: 30000, hookTimeout: 30000, maxWorkers: 3 },
});
