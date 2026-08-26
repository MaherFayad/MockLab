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
import {
  planDocument,
  rewriteHeaders,
  headerValue,
  toBase64,
  fromBase64,
  isHtmlDocument,
  isStreamedComponent,
  MAX_DOCUMENT_CHARS
} from './documentData.js';

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
          body: source.body,
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
