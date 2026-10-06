import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias: {
    '@git-view/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
    '@git-view/graph-layout': fileURLToPath(new URL('../../packages/graph-layout/src/index.ts', import.meta.url)),
  } },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
