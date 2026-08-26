/**
 * The fake page every probe unit suite drives (PLAN.md §7).
 *
 * OWNER: probe-engineer — this file only. `audit.js` beside it belongs to
 * interceptor-engineer and `verifiedChip.js` to panel-designer.
 *
 * It is the demo's own logic, in snapshot form: an enum that becomes a label AND a
 * colour, a banner that exists for two of the values, a status dot with no text at all,
 * a tip box that changes on every load, a wrapper whose text contains its children's,
 * and a second source nothing on the card reads. `render` receives the bodies the page
 * would have been SERVED — the real ones with every enabled Change applied, which is
 * what the in-page patch does — so the fake page is driven by the same mechanism a site
 * is, and a probe that reasons about the captured body instead fails here exactly as it
 * failed in Chromium.
 *
 * WHY IT IS HERE AND NOT IN `test/`: `node --test` runs every .js file under a directory
 * called `test`, so a helper there would be reported as a suite containing no tests.
 * `testlib` is outside that glob — see `audit.js` for the fuller note.
 *
 * The caller must set `globalThis.chrome` (see `fakeChrome.js`) before calling
 * `makeWorld`: nothing in the service-worker modules touches `chrome` at module scope,
 * but everything here touches it at once.
 */

import { setByPath } from '../src/shared/jsonpath.js';
import { createProbeApi } from '../src/background/probe.js';
import { PROBE_MSG, PROBE_PHASE } from '../src/background/messages.js';
import { getChanges, getEnabledChanges } from '../src/background/ruleStore.js';
import assert from 'node:assert/strict';

export const TAB = 7;
export const ORIGIN = 'https://demo.test';
/** The demo's own rendering, as a keyed §7.3 sample (see `content/agent.js`). */
export const LABEL = { ON_TIME: 'On time', DELAYED: 'Delayed', CANCELLED: 'Cancelled' };
export const COLOUR = { ON_TIME: 'rgb(30, 142, 62)', DELAYED: 'rgb(178, 106, 0)', CANCELLED: 'rgb(217, 48, 37)' };
export const BANNER = { DELAYED: 'Your flight is delayed.', CANCELLED: 'Your flight was cancelled' };

export const node = (text, colour) => ({
  tag: 'div',
  text: String(text),
  attrs: {}, cls: [],
  style: { color: colour || 'rgb(30, 30, 36)', display: 'block', visibility: 'visible', opacity: '1' },
  childCount: 0, childTexts: []
});

export function demoPage(bodies, load) {
  const trip = bodies.trip || {};
  const status = String(trip.status);
  const nodes = [{ key: 'div@1.0.1', snapshot: node(LABEL[status] || status, COLOUR[status]) }];
  if (BANNER[status]) nodes.push({ key: 'div@1.2', snapshot: node(BANNER[status]) });
  // Deliberate noise: a different tip on every load, exactly like the demo's tip box.
  nodes.push({ key: 'div@1.3', snapshot: node(`Gate ${trip.flight.gate} · tip ${load}`) });
  nodes.push({ key: 'div@1.4', snapshot: node(`SAR ${Number(trip.price.total).toFixed(2)}`) });
  nodes.push({ key: 'div@1.5', snapshot: node(String(bodies.user.user.displayName)) });
  return nodes;
}

/** Keys the tests name, so an assertion reads as something other than an index path. */
export const KEY = { pill: 'div@1.0.1', banner: 'div@1.2', tip: 'div@1.3', dot: 'span@1.0.0', card: 'div@1.0' };

export const DEMO_BODIES = {
  trip: {
    booking: { reference: 'MKL8842', status: 'ON_TIME' },
    flight: { number: 'SV 1042', gate: 'A17', origin: { code: 'RUH' }, destination: { code: 'JED' } },
    status: 'ON_TIME',
    price: { currency: 'SAR', total: 450, taxRate: 0.15 }
  },
  user: { user: { displayName: 'Nora Al-Amri', tier: 'GOLD', status: 'ACTIVE' } }
};

/** §6.3's ranked guesses for the demo pill, as `candidates.js` really produces them. */
export const PILL_CANDIDATES = [
  { sigId: 'trip', path: '$.status', value: 'ON_TIME', sourceName: 'Trip' },
  { sigId: 'trip', path: '$.booking.status', value: 'ON_TIME', sourceName: 'Trip' },
  { sigId: 'trip', path: '$.flight.origin.code', value: 'RUH', sourceName: 'Trip' },
  { sigId: 'trip', path: '$.flight.destination.code', value: 'JED', sourceName: 'Trip' }
];

/**
 * One tab, one page, one probe. `render` receives the bodies the page would have been
 * served — the real ones with every enabled Change applied, which is what the in-page
 * patch does — so the fake page is driven by the same mechanism a site is.
 */
export function makeWorld(options = {}) {
  chrome.__data.clear();
  const bodies = structuredClone(options.bodies || DEMO_BODIES);
  const missing = new Set(options.missingSources || []);
  const sources = new Map(
    Object.keys(bodies)
      .filter((sigId) => !missing.has(sigId))
      .map((sigId) => [sigId, { sigId, body: structuredClone(bodies[sigId]), signature: { method: 'GET', urlPattern: `${ORIGIN}/api/${sigId}` } }])
  );

  const world = {
    loads: 0, states: [], batches: [], render: options.render || demoPage,
    pickedKey: options.pickedKey || KEY.pill,
    confidence: options.confidence === undefined ? 1 : options.confidence
  };

  async function served() {
    const out = structuredClone(bodies);
    for (const change of await getEnabledChanges(ORIGIN)) {
      if (out[change.sigId]) setByPath(out[change.sigId], change.path, change.value);
    }
    return out;
  }

  const port = {
    postMessage(message) {
      setTimeout(async () => {
        const payload = message.payload || {};
        if (message.type === 'port:probeFingerprints') {
          const answer = () => api.onProbeResult(TAB, {
            requestId: payload.requestId,
            ok: true,
            fingerprints: (payload.keys || []).map((key) => ({
              key,
              fingerprint: { key, css: `#${key}`, textAnchor: key, attrAnchors: [], treePath: [] }
            }))
          });
          // §7.6's round trip, held open on request — the only window in which a cancel
          // can arrive after the proof is complete and before the Binding is written.
          if (world.holdFingerprints) world.releaseFingerprints = answer;
          else answer();
          return;
        }
        const nodes = world.render(await served(), world.loads);
        const picked = nodes.find((entry) => entry.key === world.pickedKey);
        // §7.2's region: the picked element's ancestors and siblings. Two of them matter
        // and neither is in §7.6's page sample. `card` is the wrapper whose text is its
        // children's concatenated (the demo's `.card__body`) — it must never be counted
        // as a place the field affects. `dot` is a status dot with no text at all, whose
        // colour follows the same field — it must be, and only the region carries it.
        const status = String((await served()).trip.status);
        const region = nodes.concat(
          { key: KEY.card, snapshot: node(nodes.filter((e) => e.key !== KEY.tip).map((e) => e.snapshot.text).join(' ')) },
          { key: KEY.dot, snapshot: node('', COLOUR[status]) }
        );
        api.onProbeResult(TAB, {
          requestId: payload.requestId,
          ok: true,
          settled: true,
          confidence: world.confidence,
          elementKey: picked ? picked.key : null,
          element: picked ? picked.snapshot : null,
          region,
          page: payload.page === false ? [] : nodes
        });
      }, 0);
    }
  };

  const api = createProbeApi({
    resolveTabId: async () => TAB,
    portsFor: () => new Set([port]),
    tabRecord: () => { if (world.breakQueue) throw new Error('a bug of ours'); return { origin: ORIGIN, sources }; },
    pickedElement: () => ({
      fingerprint: { css: `#${world.pickedKey}`, textAnchor: world.pickedKey, attrAnchors: [], treePath: [] },
      snapshot: node('picked'),
      candidates: options.candidates === undefined ? PILL_CANDIDATES : options.candidates
    }),
    async reload() {
      world.loads += 1;
      world.batches.push((await getEnabledChanges(ORIGIN)).filter((c) => c.probe).map((c) => `${c.path}=${c.value}`));
      api.onNewDocument(TAB);
      return true;
    },
    notify: (_tabId, state) => world.states.push(state)
  });

  world.api = api;
  world.start = (payload = {}) => api.handle({ type: PROBE_MSG.START_PROBE, payload });
  world.view = () => api.handle({ type: PROBE_MSG.GET_PROBE, payload: {} });
  world.stop = () => api.handle({ type: PROBE_MSG.CANCEL_PROBE, payload: {} });
  return world;
}

/** Run to completion, or fail loudly rather than hanging the suite. */
export async function finish(world, budgetMs = 5000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const view = await world.view();
    if (view.phase !== PROBE_PHASE.RUNNING) return view;
    if (Date.now() > deadline) {
      assert.fail(`the probe never finished — state ${view.state}, ${view.reload.index} reloads`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const probeChanges = async () => (await getChanges(ORIGIN)).filter((change) => change.probe === true);

/** Wait until the run has really mocked the site; a cancel before that proves nothing. */
export async function untilApplied(world, budgetMs = 3000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const applied = await probeChanges();
    if (applied.length) return applied;
    assert.ok(Date.now() < deadline, `the probe never applied anything (state ${(await world.view()).state})`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A probe api with one dependency replaced — for the answers that never start a run. */
export const bespoke = (over) =>
  createProbeApi({
    resolveTabId: async () => TAB,
    portsFor: () => new Set([{ postMessage() {} }]),
    tabRecord: () => ({ origin: ORIGIN, sources: new Map() }),
    pickedElement: () => ({ fingerprint: { css: '#pill' }, snapshot: node('x'), candidates: PILL_CANDIDATES }),
    reload: async () => true,
    notify: () => {},
    ...over
  });
