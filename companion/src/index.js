#!/usr/bin/env node
/**
 * MockLab companion — CLI entry.
 *
 * Usage: mocklab-companion [--stdio] [--http] [--pair]
 *
 * Four things run here (PLAN.md §12.1), all on 127.0.0.1 and nothing else — never
 * change that (§12.3):
 *
 *   demo site    http://127.0.0.1:8517/demo/     §14's acceptance harness
 *   hub          ws://127.0.0.1:8517/ext         §12.2, the extension's socket
 *   MCP stdio    with --stdio                    what `claude mcp add` launches
 *   MCP http     http://127.0.0.1:8518/mcp       §12.1(c), "always"
 *
 * ── stdout belongs to the protocol ─────────────────────────────────────────────────
 * Under `--stdio` the process's stdout IS the MCP transport: one stray `console.log`
 * corrupts a JSON-RPC stream, and the failure looks like a broken client rather than
 * like a log line. So every message this file prints goes to stderr, always — not only
 * in stdio mode, because a mode-dependent logger is one refactor away from being wrong.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createHub } from './hub.js';
import { createPairing, loadOrCreateToken, mocklabHome } from './pairing.js';
import { createMcpServer } from './mcpServer.js';

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

/* ═══════════════════════════ MCP over Streamable HTTP (§12.1 c) ═══════════════════
 *
 * Stateless: one Server and one transport per POST, closed with the response. A single
 * long-lived session would be simpler and would be wrong here — the hub is the only
 * shared state, MCP clients on a developer's machine come and go, and a session map
 * would keep a dead client's stream open until the process ended.
 *
 * NOT IN §12: the two header checks. `http://127.0.0.1:8518/mcp` is reachable from any
 * page the user has open — a browser will happily POST cross-origin, and while the
 * SAME-ORIGIN POLICY hides the RESPONSE from the page, the CALL still happens. Without
 * these checks any website could `set_value` on any site the user has open, or ask for a
 * reload, blind but real. And a DNS rebinding attack (evil.example resolving to
 * 127.0.0.1) turns "blind" into "readable". So: an Origin header must be absent or
 * loopback, and Host must be loopback. Reported to the orchestrator rather than added
 * quietly — §12.3 asks for this on the hub and says nothing about the HTTP transport,
 * which has exactly the same exposure.
 */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** @returns {string|null} why the request is refused, or null */
export function refuseMcpHttp(req) {
  if (!LOOPBACK_HOST.test(String(req.headers.host || ''))) return 'host';
  const origin = req.headers.origin;
  if (origin !== undefined && !LOOPBACK_ORIGIN.test(String(origin))) return 'origin';
  return null;
}

/** Read a JSON body, or null. Bounded: an unbounded read is a local denial of service. */
function readJsonBody(req, limitBytes = 4 * 1024 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * The MCP HTTP server. Exported so a test can start it on port 0.
 * @param {{hub:any, log:(line:string)=>void}} deps
 */
export function createMcpHttpServer(deps) {
  return http.createServer(async (req, res) => {
    const refused = refuseMcpHttp(req);
    if (refused) {
      deps.log(`refused an MCP HTTP request: bad ${refused} (${req.headers.origin || req.headers.host || '-'})`);
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('MockLab only answers on 127.0.0.1');
      return;
    }
    if ((req.url || '').split('?')[0] !== '/mcp') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    if (body === null) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Expected a JSON body');
      return;
    }

    const server = createMcpServer({ hub: deps.hub });
    // The transport has host/origin checks of its own, deprecated in the SDK and keyed
    // to a fixed port list. They are NOT used: `refuseMcpHttp` above answers the same
    // question one line earlier, for whatever port this server was actually given —
    // and two checks where one is silently port-blind is how a server passes its own
    // test on port 0 and refuses every real request on 8518.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      deps.log(`MCP HTTP request failed: ${String(err && err.message)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('MockLab could not handle that request');
      }
    }
  });
}

/* ══════════════════════════════════ starting up ═══════════════════════════════════ */

/** Remembers only one thing: has any browser ever completed a pairing (§12.3). */
function stateFile() {
  return path.join(mocklabHome(), 'state.json');
}

function readPairedBefore() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8')).pairedBefore === true;
  } catch {
    return false;
  }
}

function rememberPaired() {
  try {
    fs.mkdirSync(mocklabHome(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile(), JSON.stringify({ pairedBefore: true }, null, 2) + '\n', { mode: 0o600 });
  } catch {
    /* the worst case is that the next start opens a pairing window nobody uses */
  }
}

/** Every line this process prints. stderr, always — see the header. */
const log = (line) => process.stderr.write(`${line}\n`);

/**
 * Start everything. Returns the pieces so a test can drive them and close them.
 *
 * @param {{stdio?:boolean, pair?:boolean, hubPort?:number, mcpPort?:number}} options
 */
export async function startCompanion(options = {}) {
  const { token, created, file } = loadOrCreateToken();
  const pairing = createPairing({
    token,
    onRefusal: (detail) => log(`  ${detail}`),
    onPaired: rememberPaired
  });
  const hub = createHub({ pairing, log: (line) => log(`  ${line}`) });

  const site = createServer();
  hub.attach(site);
  const mcpHttp = createMcpHttpServer({ hub, log: (line) => log(`  ${line}`) });

  // §12.1 fixes the two ports, and they are what a user gets. The environment overrides
  // exist for one reason and are documented as such: a test must be able to start the
  // whole process — the CLI, not a library call — without colliding with a companion the
  // developer already has running, and without either of §12.1's numbers being free.
  const hubPort = options.hubPort === undefined ? Number(process.env.MOCKLAB_HUB_PORT ?? HUB_PORT) : options.hubPort;
  const mcpPort = options.mcpPort === undefined ? Number(process.env.MOCKLAB_MCP_PORT ?? MCP_HTTP_PORT) : options.mcpPort;
  await listen(site, hubPort, 'the demo site and the extension hub');
  await listen(mcpHttp, mcpPort, 'the MCP HTTP endpoint');

  /**
   * §12.3's window. It is opened on a FIRST RUN and when the user asks for it with
   * --pair, and NOT on every ordinary start — a window that is open every time the
   * companion runs is a window an attacker can wait for, and a browser that has already
   * paired never needs one. Reported to the orchestrator; §12.3 does not say either way.
   */
  const wantsPairing = options.pair === true || created || !readPairedBefore();
  const code = wantsPairing ? pairing.open().code : null;

  let stdioServer = null;
  if (options.stdio) {
    stdioServer = createMcpServer({ hub });
    await stdioServer.connect(new StdioServerTransport());
  }

  return {
    hub,
    pairing,
    site,
    mcpHttp,
    stdioServer,
    tokenFile: file,
    /** §12.3's six digits, or null when no window was opened. Printed by `main`. */
    pairingCode: code,
    ports: { hub: site.address().port, mcp: mcpHttp.address().port },
    async close() {
      hub.close();
      if (stdioServer) await stdioServer.close();
      await new Promise((resolve) => site.close(resolve));
      await new Promise((resolve) => mcpHttp.close(resolve));
    }
  };
}

function listen(server, port, what) {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use — is another MockLab companion running? (${what})`));
        return;
      }
      reject(err);
    });
    server.listen(port, HOST, resolve);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const options = { stdio: argv.includes('--stdio'), pair: argv.includes('--pair') };
  let running;
  try {
    running = await startCompanion(options);
  } catch (err) {
    log(String((err && err.message) || err));
    process.exit(1);
    return;
  }
  log('MockLab companion');
  log(`  demo site   http://${HOST}:${running.ports.hub}/demo/`);
  log(`  hub         ws://${HOST}:${running.ports.hub}/ext`);
  log(`  mcp (http)  http://${HOST}:${running.ports.mcp}/mcp`);
  if (options.stdio) log('  mcp (stdio) connected to this process');
  log('');
  if (running.pairingCode) {
    // The panel's own label for this control is NOT quoted here, and that is deliberate
    // rather than a wording choice. §17.6 keeps every user-visible string in one file,
    // `extension/src/panel/strings.js`, and this package cannot import it: the companion
    // is published on its own (`npx mocklab-companion`) and would carry a dangling path.
    // A copy of the label here would be a second place to translate and a second place
    // to rot the day the button is renamed — the M2 `'Data'` defect, in a terminal.
    log('  To let an AI agent use this browser: open MockLab in Chrome, go to its');
    log('  settings, choose the AI access option, and enter this code within 5 minutes:');
    log('');
    log(`        ${running.pairingCode}`);
    log('');
  } else {
    log('  already paired — run `mocklab-companion --pair` to pair another browser');
    log('');
  }
  log('Open the demo site, then click the MockLab icon in Chrome.');

  const stop = () => {
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main();
}
