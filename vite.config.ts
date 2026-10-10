import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { apiMiddleware } from './server/http.ts';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      // Strict CSP for the packaged app (dev needs Vite's inline HMR preamble).
      name: 'gitcolumn-csp',
      apply: 'build',
      transformIndexHtml: (html) =>
        html.replace(
          '<meta charset="UTF-8" />',
          `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'" />`,
        ),
    },
    {
      name: 'gitcolumn-api',
      configureServer(server) {
        server.middlewares.use(apiMiddleware());
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5199, strictPort: true },
  // highlight.js's common language bundle is large but loads from disk in the desktop app.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
