/**
 * A document that carries its data the way a Next.js App Router page does (PLAN.md §8).
 *
 * OWNER: probe-engineer. Shared by `flightData.test.js`, `flightDocument.test.js` and
 * `deepFetch.test.js`, because a fixture each of them spells for itself is a fixture
 * that drifts: the day one of them writes its chunk escaping by hand and gets it nearly
 * right, its suite is testing a document no server would send.
 *
 * WHY `testlib` AND NOT `test`: `node --test` runs every .js file under a directory
 * called `test`, so a helper there is reported as a suite containing no tests. See
 * `audit.js` for the fuller note; no file here may be named `test-*.js`.
 *
 * `companion/src/demo/approuter.html` is the FULL fixture — a whole trip card, hydrated
 * by a reader that stands in for React's runtime, with its own header recording which
 * parts of the format are faithful and which are reconstruction. This is the miniature
 * of it: the same escaping and the same cutting, small enough that a failing assertion
 * names one thing.
 */

/**
 * Next.js's own chunk escaping — `JSON.stringify`, then the five characters an HTML
 * document cannot carry raw (`htmlEscapeJsonString`). The `<` and `>` are the ones that
 * matter: a value containing `</script>` would otherwise end the element it lives in.
 *
 * @param {string} text
 * @returns {string} the literal WITH its quotes
 */
export const flightLiteral = (text) =>
  JSON.stringify(text)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

/**
 * A document carrying `stream`, cut into pushes at `cuts`.
 *
 * `cuts` are offsets INTO THE STREAM, so a test says where the server flushed and
 * nothing else has to be spelled out. A cut inside a row is the ordinary case, not the
 * exotic one: that is where a real server's buffer happened to fill.
 *
 * @param {string} stream the concatenated flight text, rows and all
 * @param {number[]} [cuts]
 */
export function flightPage(stream, cuts = [stream.length]) {
  const chunks = [];
  let at = 0;
  for (const cut of cuts) {
    chunks.push(stream.slice(at, cut));
    at = cut;
  }
  if (at < stream.length) chunks.push(stream.slice(at));
  return (
    '<!doctype html><html><body><span id="pill">On time</span>' +
    '<script>(self.__next_f=self.__next_f||[]).push([0])</script>' +
    chunks.map((chunk) => `<script>self.__next_f.push([1,${flightLiteral(chunk)}])</script>`).join('') +
    '</body></html>'
  );
}
