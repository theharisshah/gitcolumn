import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApi, dispatch } from './api.ts';

/**
 * Connect-style middleware exposing the git API over HTTP for browser mode (`npm run web`).
 * Requests must be same-origin JSON POSTs carrying the X-GitColumn header, which a
 * cross-site page can't send without a CORS preflight that we never approve.
 */
export function apiMiddleware() {
  const api = createApi({ electron: false });
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url ?? '';
    if (!url.startsWith('/api/')) return next();
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.headers['x-gitcolumn'] !== '1') return send(403, { ok: false, error: 'Forbidden' });
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(403, { ok: false, error: 'Forbidden' });

    const method = decodeURIComponent(url.slice(5).split('?')[0]);
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const data = await dispatch(api, method, body ? JSON.parse(body) : {});
      send(200, { ok: true, data: data ?? null });
    } catch (e) {
      send(200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
}
