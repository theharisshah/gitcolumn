// Development: Vite dev server (with HMR) for the renderer + Electron pointed at it.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { buildElectron } from './build-electron.mjs';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');

const server = await createServer();
await server.listen();
const url = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5199/';
console.log(`Renderer: ${url}`);

await buildElectron({ dev: true });

const child = spawn(electronBinary, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
child.on('close', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
