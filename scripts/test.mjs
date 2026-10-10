// Bundles the TypeScript test files with esbuild and runs them with node:test.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { build } from 'esbuild';

const entries = readdirSync('tests').filter((f) => f.endsWith('.test.ts')).map((f) => `tests/${f}`);
await build({
  entryPoints: entries,
  outdir: '.test-dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  logLevel: 'warning',
  outExtension: { '.js': '.mjs' },
});
const files = entries.map((e) => `.test-dist/${e.slice(6).replace(/\.ts$/, '.mjs')}`);
const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
