// Bundles the Electron main + preload scripts (and the git backend they import) to CommonJS.
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

export async function buildElectron({ dev = false } = {}) {
  await build({
    entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' },
    outdir: 'dist-electron',
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: dev ? 'inline' : false,
    minify: !dev,
    logLevel: 'warning',
  });
}

// Run directly (not imported by scripts/dev.mjs). pathToFileURL: Windows paths and spaces.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildElectron();
  console.log('Built dist-electron/');
}
