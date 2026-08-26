/**
 * §14's bundled demo site — the acceptance harness every milestone is judged against.
 *
 * OWNER: mcp-engineer. Split out of `hub.test.js` under §17.10 when that file passed the
 * budget, along the seam its own header already named: nothing here opens a WebSocket,
 * and nothing in `hub.test.js` serves a file. What is checked is that the harness still
 * SERVES what §14 says it serves — if the demo stops rendering the pill, the banner or
 * the two sources, every DoD from M1 onward is being judged against a different page.
 *
 * The path tests are the security half: `/demo/../../package.json` reaching the disk
 * would make a local static server into a file browser for anything the user can read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDemoPath, HOST, createServer } from '../src/index.js';

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
