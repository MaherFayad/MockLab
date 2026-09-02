/**
 * One paused navigation, from `Fetch.requestPaused` to the answer that releases it.
 *
 * OWNER: probe-engineer. The third file of deep mode (PLAN.md §8) and the middle one:
 * `documentData.js` decides what a document's text means, this decides what to do about
 * one request, and `debuggerEngine.js` decides when to be attached at all. The seam is
 * where the risks differ — everything here is about a request that MUST be released,
 * and everything there is about a browser that must not be left wearing a debugging bar.
 *
 * ══ THE ONE INVARIANT ══════════════════════════════════════════════════════════════
 * Every paused request is settled EXACTLY ONCE — fulfilled, or continued. Not settling
 * one is not a missing feature; it is a tab that never finishes loading, with a page the
 * person cannot see and no error anywhere to explain it. So there are three ways out and
 * all three are taken: the decision path, the thrown-error path, and a timer, whichever
 * arrives first. `settled` is what makes it once and not three times.
 *
 * ══ AND THE ONE CLAIM ══════════════════════════════════════════════════════════════
 * `mocked` on a captured source means the site was served MockLab's value instead of its
 * own. It is therefore reported after the fulfil has succeeded or failed, never before:
 * a rewrite that was built and then could not be delivered means the site rendered its
 * REAL data, and a Sources tab that said `mocked` about that load would be MockLab
 * making a false statement about its own work (§17.12's family, one size down).
 */

import { originOf } from './ruleStore.js';
import { overlaysFor } from './effectiveBody.js';
import { normalize } from './signatures.js';
import { planDocument, MAX_DOCUMENT_CHARS } from './documentData.js';

/**
 * How long this code may take to decide about ONE paused navigation before it gives up
 * and lets the request through untouched. Without a budget, a `Fetch.getResponseBody`
 * that never settles is a tab that never loads and a person with no idea why. Missing
 * the budget costs the rewrite, never the page.
 */
export const PAUSE_BUDGET_MS = 2000;

/**
 * @param {{
 *   send: (tabId:number, method:string, params?:any) => Promise<any>,
 *   capture: (tabId:number, record:any) => void,
 *   heldFor: (tabId:number) => {origin:string}|null|undefined,
 *   tally?: {paused:number, rewritten:number, continued:number, lost:number}
 * }} deps
 */
export function createInterceptor(deps) {
  const { send, capture, heldFor } = deps;
  const tally = deps.tally || { paused: 0, rewritten: 0, continued: 0, lost: 0 };

  /**
   * Read the document, work out what it carries and what a Change would do to it, and
   * come back with the `Fetch.fulfillRequest` argument plus the report to file once the
   * outcome is known.
   *
   * `null` for every case that goes through untouched, which is most of them: a redirect,
   * a non-HTML response, an RSC stream (§8's out-of-scope case), a document past the
   * memory ceiling, one with no embedded data, and one whose data nobody has changed.
   * §5.1.2's principle a layer down: with nothing to do, hand back the original rather
   * than a retyped copy of it.
   */
  async function plan(tabId, params) {
    const held = heldFor(tabId);
    if (!held) return null;

    const httpStatus = Number(params.responseStatusCode) || 0;
    if (httpStatus >= 300 && httpStatus < 400) return null; // a redirect has no document in it
    const headers = params.responseHeaders || [];
    const contentType = headerValue(headers, 'content-type');
    if (isStreamedComponent(contentType) || !isHtmlDocument(contentType)) return null;

    const url = (params.request && params.request.url) || '';
    if (originOf(url) !== held.origin) return null;

    const body = await send(tabId, 'Fetch.getResponseBody', { requestId: params.requestId });
    if (!body || typeof body.body !== 'string') return null;
    const html = body.base64Encoded ? fromBase64(body.body) : body.body;
    if (html.length > MAX_DOCUMENT_CHARS) {
      console.warn('[MockLab] deep mode skipped a document of', html.length, 'characters');
      return null;
    }

    const signature = await normalize('GET', url);
    const document = planDocument(html, signature.sigId, await overlaysFor(held.origin));
    if (!document.sources.length) return null;
    if (document.missed.length) {
      // A Change whose path is not in THIS load's data. `setByPath` creates nothing
      // (§5.4), so the page saw its own value — the same silent outcome the MAIN-world
      // patch has for the same reason, said out loud here because deep mode is new.
      console.warn('[MockLab] deep mode: this page has no field at', document.missed.join(', '));
    }

    // The capture is the REAL document's data, before any Change (§5.1.2). `mocked` is
    // its honest pair — what the page was actually served — so this runs only once the
    // fulfil has either happened or failed. See the header.
    const report = (rewritten) => {
      for (const source of document.sources) {
        capture(tabId, {
          sigId: source.sigId,
          signature: { sigId: source.sigId, method: 'GET', urlPattern: signature.urlPattern },
          url,
          status: httpStatus,
          contentType,
          // §1.1, and the one place deep mode can say it: a block MockLab FOUND and
          // cannot put back byte-correctly is reported in §4's unparsed shape, which is
          // what makes the panel draw it as a source with §11's `sources.streamedUnsupported`
          // beside it and no editable field inside. Absent would be a lie by omission;
          // editable would be a lie about what a Change on it would do.
          body: source.editable ? source.body : { __unparsed: true, preview: source.preview },
          bodyBytes: source.bodyBytes,
          ts: Date.now(),
          via: 'document',
          mocked: source.mocked && rewritten,
          // §11's `sources.changeDropped` — "this change didn't reach the page in time,
          // so the site showed its real data". Which is what a failed fulfil is.
          changeDropped: source.mocked && !rewritten
        });
      }
    };

    if (!document.applied) return { fulfil: null, report };
    return {
      report,
      fulfil: {
        requestId: params.requestId,
        responseCode: httpStatus || 200,
        responseHeaders: rewriteHeaders(headers),
        body: toBase64(document.html)
      }
    };
  }

  return {
    /** The tally this interceptor writes into — read by the engine's `counts()`. */
    tally,
    plan,

    /** One `Fetch.requestPaused` event. Never throws; always releases. */
    onPaused(tabId, params) {
      const requestId = params && params.requestId;
      if (!requestId) return;
      tally.paused += 1;

      let settled = false;
      const finish = async (decided) => {
        if (settled) return;
        settled = true;
        let rewritten = false;
        if (decided && decided.fulfil) {
          try {
            await send(tabId, 'Fetch.fulfillRequest', decided.fulfil);
            tally.rewritten += 1;
            rewritten = true;
          } catch (err) {
            console.error('[MockLab] deep mode could not fulfil a document', err);
          }
        }
        if (!rewritten) {
          try {
            await send(tabId, 'Fetch.continueResponse', { requestId });
            tally.continued += 1;
          } catch {
            try {
              // Some builds answer the response stage with continueRequest rather than
              // continueResponse. Trying both is the difference between a page that
              // loads unchanged and a page that never loads at all.
              await send(tabId, 'Fetch.continueRequest', { requestId });
              tally.continued += 1;
            } catch (err) {
              tally.lost += 1;
              console.error('[MockLab] a paused document could not be released', err);
            }
          }
        }
        if (decided && decided.report) decided.report(rewritten);
      };

      const timer = setTimeout(() => void finish(null), PAUSE_BUDGET_MS);
      plan(tabId, params).then(
        (decided) => finish(decided).finally(() => clearTimeout(timer)),
        (err) => {
          console.error('[MockLab] deep mode failed on a document', err);
          return finish(null).finally(() => clearTimeout(timer));
        }
      );
    }
  };
}

/* ══════════════════════════ the wire, and what may be said on it ══════════════════
 *
 * Everything below was in `documentData.js` until App Router support pushed that file
 * onto §17.10's line budget, and this is where it always belonged: none of it is about
 * what a document MEANS, which is that file's whole subject. It is about the transport —
 * how CDP carries bytes, which headers a rewrite invalidates, and which content types
 * this engine will look at at all. `deepFetch.js` is the only caller of any of it.
 */

/**
 * CDP carries a body as base64 of BYTES, and a document is text — so both directions go
 * through TextEncoder/TextDecoder rather than through `btoa` on a JS string, which throws
 * on any character above U+00FF. A page with an Arabic title is not an edge case (§9.2
 * has this product RTL-ready) and `btoa(html)` throws on the first one.
 *
 * The chunking is not tidiness either: `String.fromCharCode(...bytes)` spreads one
 * argument per byte and blows the call stack somewhere around a hundred thousand of
 * them, which a real document reaches.
 */
const CHUNK = 0x8000;

/** @param {string} text @returns {string} */
export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** @param {string} base64 @returns {string} */
export function fromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/* -------------------------------------------------------------------- the headers */

/**
 * Headers that describe the ENCODING or LENGTH of the body we just replaced, and are
 * therefore lies about the body we are about to send.
 *
 * `content-length` is §8's own instruction. `content-encoding` is the one §8 does not
 * mention and the one that breaks the page hardest: CDP's `Fetch.getResponseBody` hands
 * back the DECODED body, so a document served gzipped comes back as text — fulfil it
 * with `content-encoding: gzip` still on the response and the browser tries to inflate
 * plain HTML and renders nothing at all. `transfer-encoding` and `content-md5` are the
 * same class of claim.
 *
 * CSP is deliberately NOT stripped: MockLab changes the site's data and must not quietly
 * weaken the site's security posture while doing it.
 */
const REWRITTEN_AWAY = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'content-md5']);

/**
 * The response headers to fulfil with: the original ones, minus the ones the rewrite
 * invalidated.
 *
 * @param {{name:string, value:string}[]|undefined} headers  CDP's `responseHeaders`
 * @returns {{name:string, value:string}[]}
 */
export function rewriteHeaders(headers) {
  if (!Array.isArray(headers)) return [];
  return headers.filter((header) => header && !REWRITTEN_AWAY.has(String(header.name).toLowerCase()));
}

/**
 * One header's value, case-insensitively, or ''. CDP does not normalize header case and
 * HTTP/2 lowercases while HTTP/1.1 does not, so every read of one goes through here.
 *
 * @param {{name:string, value:string}[]|undefined} headers
 * @param {string} name
 */
export function headerValue(headers, name) {
  if (!Array.isArray(headers)) return '';
  const wanted = name.toLowerCase();
  for (const header of headers) {
    if (header && String(header.name).toLowerCase() === wanted) return String(header.value || '');
  }
  return '';
}

/**
 * PLAN.md §8, last bullet: React Server Component payloads are OUT OF SCOPE for v1 and
 * are to be DETECTED rather than attempted. Detection is by content type, which is the
 * only thing that is true of every one of them.
 *
 * @param {string} contentType
 */
export const isStreamedComponent = (contentType) => /text\/x-component/i.test(String(contentType || ''));

/** Only an HTML document is scanned; anything else is continued untouched. */
export const isHtmlDocument = (contentType) => /text\/html|application\/xhtml\+xml/i.test(String(contentType || ''));
