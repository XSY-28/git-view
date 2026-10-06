import { build } from 'esbuild';
import { build as buildWeb } from 'vite';
import { chmod } from 'node:fs/promises';
import { buildNativePicker } from './build-native.mjs';
await buildNativePicker();
await build({ entryPoints: { server: 'apps/local/src/main.ts', cli: 'apps/cli/src/main.ts', stdio: 'apps/local/src/stdio-main.ts', inspect: 'apps/cli/src/inspect-main.ts' }, outdir: 'dist', outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', target: 'node24', format: 'esm', sourcemap: true, banner: { js: '#!/usr/bin/env node' } });
await buildWeb({ configFile: 'apps/web/vite.config.ts' });
await chmod('dist/cli.mjs', 0o755);
