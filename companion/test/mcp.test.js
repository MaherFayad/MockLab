/**
 * PLAN.md §12.4 — the fifteen tools, driven by a real MCP client.
 *
 * OWNER: mcp-engineer.
 *
 * The client is the SDK's own, over an in-memory transport pair, so everything here goes
 * through real JSON-RPC: the tool list is the one a client would receive, the errors are
 * the ones it would see, and a progress notification is one it actually delivers. A test
 * that called the handler function directly would prove the handler, not the protocol —
 * and §12.4's audience is a client, not this file.
 *
 * The hub is faked (one function), because what the hub does with a real socket is
 * `hub.test.js`'s subject and proving it twice would only make both slower.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer, TOOL_NAMES, INSTRUCTIONS } from '../src/mcpServer.js';
import { TOOLS, validateArguments, PROBE_TIMEOUT_MS } from '../src/tools.js';
import { HubError, REQUEST_TIMEOUT_MS, EXTENSION_TIMEOUT_MESSAGE, CANCELLED_MESSAGE } from '../src/hub.js';
import { createMcpHttpServer, refuseMcpHttp, HOST } from '../src/index.js';

/** A hub that answers with whatever `answer(op, payload, options)` returns. */
function fakeHub(answer) {
  const calls = [];
  return {
    calls,
    async request(op, payload, options = {}) {
      calls.push({ op, payload, options });
      return answer(op, payload, options);
    }
  };
}

/** A connected client/server pair over the SDK's in-memory transport. */
async function connectClient(hub) {
  const server = createMcpServer({ hub });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    }
  };
}

test('§12.4 a client sees exactly the fifteen tools, in the plan\'s order', async () => {
  const rig = await connectClient(fakeHub(() => ({ ok: true })));
  try {
    const listed = await rig.client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), [...TOOL_NAMES]);
    assert.equal(listed.tools.length, 15);
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} takes an object`);
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} refuses stray arguments`);
      assert.ok(tool.description.length > 40, `${tool.name} is described, not just named`);
    }
  } finally {
    await rig.close();
  }
});

test('§12.4 every tool that targets a page takes tabId, and every mutation takes refresh', async () => {
  const NO_TAB = new Set(['list_tabs', 'delete_preset']);
  const MUTATIONS = new Set(['set_value', 'clear_changes', 'apply_preset']);
  for (const tool of TOOLS) {
    const properties = tool.inputSchema.properties || {};
    if (!NO_TAB.has(tool.name)) {
      assert.ok(properties.tabId, `${tool.name} targets a page and must take tabId`);
      assert.equal(properties.tabId.type, 'integer');
    }
    if (MUTATIONS.has(tool.name)) {
      assert.equal(properties.refresh.default, true, `${tool.name}: §12.4 defaults refresh to true`);
    }
  }
  // The two §12.4 calls out as reading a site rather than a tab.
  assert.ok(TOOLS.find((t) => t.name === 'get_bindings').inputSchema.properties.origin);
  assert.ok(TOOLS.find((t) => t.name === 'list_presets').inputSchema.properties.origin);
  // Neither of those may then REQUIRE tabId, or "{tabId | origin}" would be a lie.
  assert.deepEqual(TOOLS.find((t) => t.name === 'get_bindings').inputSchema.required, undefined);
});

test('§12.4 the happy path is in the instructions, and so is what it cannot promise', () => {
  for (const step of ['list_tabs', 'list_sources', 'search_value', 'set_value', 'reload', 'screenshot']) {
    assert.ok(INSTRUCTIONS.includes(step), `the happy path names ${step}`);
  }
  assert.ok(INSTRUCTIONS.includes('probe_element'), '§12.4: "for guaranteed correctness, probe_element first"');
  assert.match(INSTRUCTIONS, /GUESSES/, 'an agent is told that a value match is not a proof (§0.2)');
});

test('§12.4 a tool call is forwarded to the extension under its own name', async () => {
  const hub = fakeHub((op, payload) => ({ ok: true, op, payload }));
  const rig = await connectClient(hub);
  try {
    const answer = await rig.client.callTool({ name: 'set_value', arguments: { tabId: 3, sigId: 's', path: '$.status', value: 'CANCELLED' } });
    assert.equal(answer.isError, undefined);
    const parsed = JSON.parse(answer.content[0].text);
    assert.equal(parsed.op, 'set_value', 'the op on the wire is the tool name — one vocabulary');
    assert.deepEqual(parsed.payload, { tabId: 3, sigId: 's', path: '$.status', value: 'CANCELLED' });
    assert.equal(hub.calls[0].options.timeoutMs, undefined, 'ordinary tools take §12.2\'s 30s');
  } finally {
    await rig.close();
  }
});

test('§12.4 an extension refusal comes back as a tool error carrying the extension\'s own sentence', async () => {
  const rig = await connectClient(fakeHub(() => ({ ok: false, reason: 'tooNoisy', message: 'This element changes by itself.' })));
  try {
    const answer = await rig.client.callTool({ name: 'probe_element', arguments: { tabId: 1, text: 'On time' } });
    assert.equal(answer.isError, true);
    assert.equal(answer.content[0].text, 'This element changes by itself.', 'the honest reason, not a code');
  } finally {
    await rig.close();
  }
});

test('§12.4 a refusal with no sentence still says which reason, never a bare failure', async () => {
  const rig = await connectClient(fakeHub(() => ({ ok: false, reason: 'no-such-tab' })));
  try {
    const answer = await rig.client.callTool({ name: 'list_sources', arguments: { tabId: 99 } });
    assert.equal(answer.isError, true);
    assert.match(answer.content[0].text, /no-such-tab/);
  } finally {
    await rig.close();
  }
});

test('§12.2 a hub timeout reaches the agent as the sentence §12.2 wrote', async () => {
  const rig = await connectClient(fakeHub(() => {
    throw new HubError('timeout', EXTENSION_TIMEOUT_MESSAGE);
  }));
  try {
    const answer = await rig.client.callTool({ name: 'list_tabs', arguments: {} });
    assert.equal(answer.isError, true);
    assert.equal(answer.content[0].text, EXTENSION_TIMEOUT_MESSAGE);
    assert.ok(REQUEST_TIMEOUT_MS === 30_000, '§12.2 says 30 seconds');
  } finally {
    await rig.close();
  }
});

test('a defect in the companion is reported as a defect, not as a finding about the page', async () => {
  const rig = await connectClient(fakeHub(() => {
    throw new TypeError('cannot read properties of undefined');
  }));
  try {
    const answer = await rig.client.callTool({ name: 'list_tabs', arguments: {} });
    assert.equal(answer.isError, true);
    assert.match(answer.content[0].text, /companion failed/, 'ours, and it says so');
  } finally {
    await rig.close();
  }
});

test('§12.4 #5 progress notifications arrive at the client while the probe runs', async () => {
  const hub = {
    async request(op, payload, options) {
      options.onProgress({ progress: 1, total: 8, message: 'Learning what changes on its own…' });
      options.onProgress({ progress: 4, total: 8, message: 'Double-checking…' });
      return { ok: true, binding: { state: 'candidate' } };
    }
  };
  const rig = await connectClient(hub);
  try {
    const seen = [];
    const answer = await rig.client.callTool(
      { name: 'probe_element', arguments: { tabId: 1, text: 'On time' } },
      undefined,
      { onprogress: (note) => seen.push(note) }
    );
    assert.equal(answer.isError, undefined);
    assert.equal(seen.length, 2, 'both state changes were delivered as notifications');
    assert.deepEqual(seen.map((note) => note.progress), [1, 4]);
    assert.equal(seen[0].total, 8);
    assert.match(seen[0].message, /Learning/);
  } finally {
    await rig.close();
  }
});

test('§7.1 an MCP client that cancels a probe cancels it in the browser', async () => {
  // MCP already has cancellation, so MockLab does not invent a sixteenth tool for it —
  // it forwards the signal it is given. What must be true is that the signal REACHES the
  // hub: a call cancelled only in this process leaves the page reloading in front of
  // whoever is watching it, for up to §7.1's three minutes.
  let handed = null;
  const hub = {
    async request(op, payload, options) {
      handed = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new HubError('cancelled', CANCELLED_MESSAGE)));
      });
    }
  };
  const rig = await connectClient(hub);
  try {
    const controller = new AbortController();
    const call = rig.client.callTool(
      { name: 'probe_element', arguments: { tabId: 1, selector: '#status-pill' } },
      undefined,
      { signal: controller.signal }
    );
    const deadline = Date.now() + 2000;
    while (!handed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(handed, 'the tool call reached the hub with a signal on it');
    assert.equal(handed.aborted, false);

    controller.abort();
    await assert.rejects(call, 'the client\'s own call ends');
    assert.equal(handed.aborted, true, 'and the browser half is told to stop');
  } finally {
    await rig.close();
  }
});

test('§7.1 an ordinary tool call is given a signal that nobody aborted', async () => {
  const hub = fakeHub(() => ({ ok: true }));
  const rig = await connectClient(hub);
  try {
    await rig.client.callTool({ name: 'list_tabs', arguments: {} });
    const signal = hub.calls[0].options.signal;
    assert.ok(signal, 'every call carries the client\'s cancellation, not only the long ones');
    assert.equal(signal.aborted, false);
  } finally {
    await rig.close();
  }
});

test('§12.4 #5 the probe is given the probe\'s own time budget, not §12.2\'s 30 seconds', async () => {
  const hub = fakeHub(() => ({ ok: true }));
  const rig = await connectClient(hub);
  try {
    await rig.client.callTool({ name: 'probe_element', arguments: { tabId: 1, selector: '#p' } });
    assert.equal(hub.calls[0].options.timeoutMs, PROBE_TIMEOUT_MS);
    assert.ok(PROBE_TIMEOUT_MS > 180_000, '§7.1 caps a whole probe at 3 minutes; the wait must outlast it');
  } finally {
    await rig.close();
  }
});

test('§12.4 #14 a screenshot comes back as an image a model can look at', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUg==';
  const rig = await connectClient(fakeHub(() => ({ ok: true, tabId: 2, mimeType: 'image/png', image: png })));
  try {
    const answer = await rig.client.callTool({ name: 'screenshot', arguments: { tabId: 2 } });
    assert.equal(answer.content[0].type, 'image');
    assert.equal(answer.content[0].data, png);
    assert.equal(answer.content[0].mimeType, 'image/png');
    const parsed = JSON.parse(answer.content[1].text);
    assert.equal(parsed.tabId, 2);
    assert.ok(!parsed.image.startsWith(png), 'the base64 is not repeated into the transcript');
  } finally {
    await rig.close();
  }
});

test('§12.4 #14 fullPage is refused rather than quietly answered with a viewport shot', async () => {
  const hub = fakeHub(() => ({ ok: true, image: 'x' }));
  const rig = await connectClient(hub);
  try {
    const answer = await rig.client.callTool({ name: 'screenshot', arguments: { tabId: 1, fullPage: true } });
    assert.equal(answer.isError, true);
    assert.match(answer.content[0].text, /visible part/);
    assert.equal(hub.calls.length, 0, 'and the browser is never asked to do the thing it cannot do');
  } finally {
    await rig.close();
  }
});

test('§12.4 #5 needs a selector or text, and says so before touching the browser', async () => {
  const hub = fakeHub(() => ({ ok: true }));
  const rig = await connectClient(hub);
  try {
    const answer = await rig.client.callTool({ name: 'probe_element', arguments: { tabId: 1 } });
    assert.equal(answer.isError, true);
    assert.match(answer.content[0].text, /selector or the exact text/);
    assert.equal(hub.calls.length, 0);
  } finally {
    await rig.close();
  }
});

test('§1.6 the panel affordances an agent could not reach are reachable now, unchanged', async () => {
  // Three optional arguments, added after M6 closed. Each one existed on a screen and
  // nowhere else, and `additionalProperties:false` meant an agent that tried was refused
  // rather than ignored — so this is the difference between "cannot" and "can".
  const hub = fakeHub((op, payload) => ({ ok: true, op, payload }));
  const rig = await connectClient(hub);
  try {
    const off = await rig.client.callTool({
      name: 'set_value',
      arguments: { tabId: 1, sigId: 's', path: '$.status', value: 'CANCELLED', enabled: false }
    });
    assert.equal(off.isError, undefined, off.content[0].text);
    assert.equal(JSON.parse(off.content[0].text).payload.enabled, false, '§10.2\'s per-row switch');

    const careful = await rig.client.callTool({
      name: 'probe_element',
      arguments: { tabId: 1, selector: '#p', exhaustive: true, paranoid: true }
    });
    assert.equal(careful.isError, undefined, careful.content[0].text);
    const sent = JSON.parse(careful.content[0].text).payload;
    assert.equal(sent.exhaustive, true, '§10.1D\'s "Check all fields (slower)"');
    assert.equal(sent.paranoid, true, '§10.5\'s "Extra-careful checking"');

    // The names are still exactly §12.4's fifteen: an argument was added, not a tool.
    assert.equal((await rig.client.listTools()).tools.length, 15);
    // And the schema is no looser than it was: a neighbouring misspelling is still refused.
    const typo = await rig.client.callTool({ name: 'probe_element', arguments: { tabId: 1, selector: '#p', paranoyd: true } });
    assert.equal(typo.isError, true);
    assert.match(typo.content[0].text, /does not take paranoyd/);
    assert.equal(hub.calls.length, 2, 'and the refused call never reached the browser');
  } finally {
    await rig.close();
  }
});

test('arguments are checked: a missing one and a misspelled one both get a sentence', () => {
  const setValue = TOOLS.find((tool) => tool.name === 'set_value');
  assert.match(validateArguments(setValue, { tabId: 1, path: '$.a', value: 2 }), /needs sigId/);
  assert.match(validateArguments(setValue, { tabId: 1, sigId: 's', path: '$.a', valeu: 2 }), /does not take valeu/);
  assert.equal(validateArguments(setValue, { tabId: 1, sigId: 's', path: '$.a', value: 2 }), null);
  // A value of `null` or `false` is a value: `value: null` must not read as absent.
  assert.equal(validateArguments(setValue, { tabId: 1, sigId: 's', path: '$.a', value: null }), null);
  assert.equal(validateArguments(setValue, { tabId: 1, sigId: 's', path: '$.a', value: false }), null);
});

test('a tool MockLab does not have is refused by name', async () => {
  const rig = await connectClient(fakeHub(() => ({ ok: true })));
  try {
    const answer = await rig.client.callTool({ name: 'delete_everything', arguments: {} });
    assert.equal(answer.isError, true);
    assert.match(answer.content[0].text, /no tool called delete_everything/);
  } finally {
    await rig.close();
  }
});

/* ════════════════ §12.1(c) — MCP over HTTP, and who may reach it ═════════════════ */

test('the MCP HTTP endpoint refuses a foreign Origin or Host before doing anything', () => {
  assert.equal(refuseMcpHttp({ headers: { host: '127.0.0.1:8518' } }), null);
  assert.equal(refuseMcpHttp({ headers: { host: 'localhost:8518', origin: 'http://localhost:8518' } }), null);
  assert.equal(refuseMcpHttp({ headers: { host: '127.0.0.1:8518', origin: 'https://evil.example' } }), 'origin',
    'a web page can POST here cross-origin; it cannot read the answer, but the CALL would happen');
  assert.equal(refuseMcpHttp({ headers: { host: 'evil.example' } }), 'host', 'DNS rebinding');
  assert.equal(refuseMcpHttp({ headers: {} }), 'host');
});

test('§12.1 the MCP HTTP endpoint answers a real initialize on loopback, and 403s a page', async () => {
  const server = createMcpHttpServer({ hub: fakeHub(() => ({ ok: true })), log: () => {} });
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  const base = `http://${HOST}:${server.address().port}`;
  try {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }
    };
    const ok = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body)
    });
    assert.equal(ok.status, 200);
    const text = await ok.text();
    assert.match(text, /"serverInfo"/, 'a real MCP initialize result came back');
    assert.match(text, /MockLab lets you change/, 'and it carries §12.4\'s instructions');

    const fromPage = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify(body)
    });
    assert.equal(fromPage.status, 403);

    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* ═══════ the two halves of §12.2's wire, written in two workspaces, are one list ═══ */

test('§12.2 both ends of the socket use the same close codes, ops and subprotocols', async () => {
  const { CLOSE, HUB_OP, KIND, SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX } = await import('../src/hub.js');
  const extension = await import('../../extension/src/background/wsClient.js');
  assert.deepEqual(extension.CLOSE, CLOSE, 'a close code the extension reads differently is a close code that does nothing');
  // Same for the op vocabulary: `cancel` written here and read as something else there
  // would be a probe that keeps running with nobody left to answer it.
  assert.deepEqual(extension.HUB_OP, HUB_OP, 'the non-tool ops are one table written twice');
  assert.deepEqual(extension.KIND, KIND);
  assert.equal(extension.SUBPROTOCOL, SUBPROTOCOL);
  assert.equal(extension.TOKEN_SUBPROTOCOL_PREFIX, TOKEN_SUBPROTOCOL_PREFIX);
});

test('§1.6 the extension implements exactly the fifteen ops the tools send', async () => {
  // Cross-workspace on purpose: the op vocabulary is a CONTRACT between two packages,
  // and a contract nobody compares is two vocabularies. `wsOps.js` builds its table from
  // the same names, so a tool added on one side with no op on the other fails here
  // rather than at the first call an agent makes.
  const { createOps } = await import('../../extension/src/background/wsOps.js');
  const ops = createOps({
    dispatch: async () => ({ ok: true }),
    portsFor: () => null,
    tabRecord: () => null,
    onPicked: () => {},
    chrome: {}
  });
  assert.deepEqual(Object.keys(ops).sort(), [...TOOL_NAMES].sort());
});

/* ═════════════════════ §12.1 — the process itself: ports, stdout, pairing ═════════ */

/** Run `body` with a fresh MOCKLAB_HOME, so no test touches the developer's own token. */
async function withHome(body) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const previous = process.env.MOCKLAB_HOME;
  const home = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'mocklab-cli-'));
  process.env.MOCKLAB_HOME = home;
  try {
    return await body(home);
  } finally {
    if (previous === undefined) delete process.env.MOCKLAB_HOME;
    else process.env.MOCKLAB_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('§12.1 under --stdio the process writes JSON-RPC to stdout and nothing else', async (t) => {
  // The REAL process, spawned. This cannot be checked in-process: `node --test` writes
  // its own report to stdout, so a stubbed `process.stdout.write` catches the runner's
  // traffic and proves nothing about ours. And it has to be checked somewhere — one
  // `console.log` in this package corrupts the transport for every MCP client, and the
  // symptom is a client that says MockLab is broken, with no line to point at.
  const { spawn } = await import('node:child_process');
  const pathMod = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const entry = pathMod.join(pathMod.dirname(fileURLToPath(import.meta.url)), '../src/index.js');

  await withHome(async (home) => {
    const child = spawn(process.execPath, [entry, '--stdio'], {
      env: { ...process.env, MOCKLAB_HOME: home, MOCKLAB_HUB_PORT: '0', MOCKLAB_MCP_PORT: '0' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    try {
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }
      }) + '\n');
      const deadline = Date.now() + 15000;
      while (!out.includes('serverInfo') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    } finally {
      child.kill('SIGTERM');
    }
    t.diagnostic(`stderr said: ${err.split('\n')[0]}`);
    const lines = out.split('\n').filter((line) => line.trim() !== '');
    assert.ok(lines.length >= 1, `the process answered nothing on stdout (stderr: ${err})`);
    for (const line of lines) {
      const parsed = JSON.parse(line);   // throws on a stray log line, which is the point
      assert.equal(parsed.jsonrpc, '2.0');
    }
    assert.match(out, /"serverInfo"/, 'a real MCP initialize was answered');
    // The human-readable half went somewhere — just not into the protocol.
    assert.match(err, /MockLab companion/);
    assert.match(err, /[0-9]{6}/, 'and the first run printed a pairing code (§12.3)');
  });
});

test('§12.3 a pairing window opens on the first run and on --pair, not on every start', async () => {
  await withHome(async () => {
    const { startCompanion } = await import('../src/index.js');
    // Every start is closed in a `finally`. A failed assertion that skipped a close
    // would leave two listening servers behind and `node --test` would hang after
    // reporting — a red test that looks like a broken harness instead of a finding.
    const started = [];
    const start = async (options) => {
      const running = await startCompanion({ hubPort: 0, mcpPort: 0, ...options });
      started.push(running);
      return running;
    };
    try {
      const first = await start({});
      assert.match(String(first.pairingCode), /^[0-9]{6}$/, 'first run: there is nothing paired yet');
      assert.equal(first.pairing.isOpen(), true);
      // Pair for real, the way the extension does, so the companion remembers.
      assert.ok(first.pairing.submit(first.pairingCode));
      await first.close();

      const second = await start({});
      assert.equal(second.pairingCode, null, 'an ordinary start leaves no window for anyone to guess at');
      assert.equal(second.pairing.isOpen(), false);
      await second.close();

      const asked = await start({ pair: true });
      assert.match(String(asked.pairingCode), /^[0-9]{6}$/, '--pair is how a second browser is paired');
    } finally {
      for (const running of started) await running.close().catch(() => {});
    }
  });
});
