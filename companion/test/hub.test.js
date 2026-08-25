/**
 * Companion tests (PLAN.md §12, §14).
 *
 * OWNER: mcp-engineer. Milestone M6 adds hub framing, pairing and MCP tool-schema
 * tests. The demo-serving tests below are the M0 acceptance harness and must keep
 * passing for the rest of the build.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDemoPath, HOST, HUB_PORT, createServer } from '../src/index.js';
import { TOOL_NAMES } from '../src/mcpServer.js';

test('demo paths resolve inside the demo directory', () => {
  assert.match(resolveDemoPath('/demo/')  ?? '', /demo[\\/]index\.html$/);
  assert.match(resolveDemoPath('/demo')   ?? '', /demo[\\/]index\.html$/);
  assert.match(resolveDemoPath('/demo/app.js') ?? '', /demo[\\/]app\.js$/);
  assert.match(resolveDemoPath('/demo/api/trip.json') ?? '', /api[\\/]trip\.json$/);
});

test('paths outside the demo directory are refused', () => {
  assert.equal(resolveDemoPath('/'), null);
  assert.equal(resolveDemoPath('/etc/passwd'), null);
  assert.equal(resolveDemoPath('/demo/../../package.json'), null);
  assert.equal(resolveDemoPath('/demo/%2e%2e/%2e%2e/package.json'), null);
});

test('the companion binds to loopback only (PLAN.md §12.3)', () => {
  assert.equal(HOST, '127.0.0.1');
  assert.equal(HUB_PORT, 8517);
});

test('the demo site serves the trip card and its two data sources', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  const base = `http://${HOST}:${server.address().port}`;
  try {
    const page = await fetch(`${base}/demo/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="status-pill"/);
    assert.match(html, /id="alert-banner"/);

    const trip = await (await fetch(`${base}/demo/api/trip.json`)).json();
    assert.equal(trip.status, 'ON_TIME');
    assert.equal(trip.price.total, 450);

    const user = await (await fetch(`${base}/demo/api/user.json`)).json();
    assert.equal(user.user.displayName, 'Nora Al-Amri');

    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the 15 MCP tool names in PLAN.md §12.4 are declared', () => {
  assert.equal(TOOL_NAMES.length, 15);
  assert.ok(TOOL_NAMES.includes('probe_element'));
  assert.equal(new Set(TOOL_NAMES).size, 15);
});
