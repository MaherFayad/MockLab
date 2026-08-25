#!/usr/bin/env node
/**
 * MockLab companion — CLI entry.
 *
 * Usage: mocklab-companion [--stdio] [--http]
 *
 * Milestone M0 ships the piece the rest of the build is tested against: the static
 * demo site on http://127.0.0.1:8517/demo/ (PLAN.md §14). The WebSocket hub (§12.2),
 * pairing (§12.3) and the MCP server (§12.4) are wired in at M6 — until then the
 * flags are accepted and reported so the CLI contract never changes.
 *
 * Everything binds to 127.0.0.1 only. Never change that (PLAN.md §12.3).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO_ROOT = path.join(HERE, 'demo');

export const HOST = '127.0.0.1';
export const HUB_PORT = 8517;
export const MCP_HTTP_PORT = 8518;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/**
 * Map a request path under /demo to a file inside DEMO_ROOT.
 * Returns null for anything that escapes the demo directory (path traversal) or
 * is not under /demo at all. Exported so it can be unit-tested without a socket.
 *
 * @param {string} urlPath
 * @returns {string|null}
 */
export function resolveDemoPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (decoded !== '/demo' && !decoded.startsWith('/demo/')) return null;

  let rel = decoded.slice('/demo'.length);
  if (rel === '' || rel === '/') rel = '/index.html';
  if (rel.endsWith('/')) rel += 'index.html';

  const full = path.join(DEMO_ROOT, rel);
  const normalized = path.normalize(full);
  if (normalized !== DEMO_ROOT && !normalized.startsWith(DEMO_ROOT + path.sep)) return null;
  return normalized;
}

/** @param {http.ServerResponse} res @param {number} code @param {string} body */
function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, {
    'content-type': type,
    // The demo must never be cached: probe runs reload it many times and every
    // reload has to actually hit the interceptor again.
    'cache-control': 'no-store'
  });
  res.end(body);
}

/** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
export function handleRequest(req, res) {
  const url = req.url || '/';

  if (url === '/' || url === '/index.html') {
    res.writeHead(302, { location: '/demo/' });
    res.end();
    return;
  }

  // The demo's console is the console every milestone's acceptance is judged in, so it
  // must be clean. Without this, Chrome's automatic favicon request 404s on every load
  // and every page gets a red console error that has nothing to do with MockLab.
  if (url === '/favicon.ico') {
    res.writeHead(204, { 'cache-control': 'max-age=86400' });
    res.end();
    return;
  }

  if (url === '/health') {
    send(res, 200, JSON.stringify({ ok: true, demo: `http://${HOST}:${HUB_PORT}/demo/` }), MIME['.json']);
    return;
  }

  const file = resolveDemoPath(url);
  if (!file) {
    send(res, 404, 'Not found');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      send(res, 404, 'Not found');
      return;
    }
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

export function createServer() {
  return http.createServer(handleRequest);
}

function main() {
  const server = createServer();
  server.listen(HUB_PORT, HOST, () => {
    console.log(`MockLab companion`);
    console.log(`  demo site   http://${HOST}:${HUB_PORT}/demo/`);
    console.log(`  hub         ws://${HOST}:${HUB_PORT}/ext          (wired at M6)`);
    console.log(`  mcp (http)  http://${HOST}:${MCP_HTTP_PORT}/mcp   (wired at M6)`);
    console.log(`\nOpen the demo site, then click the MockLab icon in Chrome.`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${HUB_PORT} is already in use — is another MockLab companion running?`);
      process.exit(1);
    }
    throw err;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
