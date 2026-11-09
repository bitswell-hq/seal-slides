#!/usr/bin/env node
// A static file server for looking at a built site locally (npm run dev).
// The published site needs no server; this only stands in for GitHub Pages.
// Usage: node scripts/serve.mjs [dir=site] [port=8080]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

export function serve(dir, port = 0) {
  const root = path.resolve(dir);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let p = path.join(root, decodeURIComponent(url.pathname));
      if (!p.startsWith(root)) { res.writeHead(403).end(); return; }
      let s = await stat(p).catch(() => null);
      if (s && s.isDirectory()) {
        if (!url.pathname.endsWith('/')) { res.writeHead(301, { Location: url.pathname + '/' + url.search }).end(); return; }
        p = path.join(p, 'index.html');
        s = await stat(p).catch(() => null);
      }
      if (!s) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await readFile(p));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(e));
    }
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] || 'site';
  const port = Number(process.argv[3] || process.env.PORT || 8080);
  const server = await serve(dir, port);
  console.log(`serving ${dir} at http://127.0.0.1:${server.address().port}/`);
}
