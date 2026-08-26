/**
 * `chrome.storage.local`, close enough to the real one to catch real bugs.
 *
 * OWNER: probe-engineer. Used by the probe's unit suites, which drive the whole §7 state
 * machine against a fake page and therefore need a store the modules under test can
 * write to exactly as they write to Chrome's.
 *
 * WHY IT IS HERE AND NOT IN `test/`: `node --test` executes every .js file under a
 * directory called `test`, so a helper module there would be run as a suite containing
 * no tests. `testlib` is outside that glob — see `audit.js` for the fuller note.
 *
 * WHY IT DEEP-CLONES BOTH WAYS: the real API structured-clones across a process
 * boundary, so a caller can never hold a reference into the store. A fake that returned
 * live objects would let a test mutate storage without writing to it, and every
 * read-modify-write race this build has already hit once would become invisible.
 *
 * `changes.test.js` keeps its own copy with a delay hook for the write-lock tests. That
 * duplication is deliberate: it belongs to another owner, and merging them would tie one
 * agent's fixtures to another's.
 */

/** @returns {{__data: Map<string, any>, storage: {local: object}}} */
export function fakeChrome() {
  const data = new Map();
  return {
    __data: data,
    storage: {
      local: {
        async get(key) {
          if (key === null || key === undefined) {
            return Object.fromEntries([...data].map(([k, v]) => [k, structuredClone(v)]));
          }
          const out = {};
          for (const k of Array.isArray(key) ? key : [key]) {
            if (data.has(k)) out[k] = structuredClone(data.get(k));
          }
          return out;
        },
        async set(bag) {
          for (const [k, v] of Object.entries(bag)) data.set(k, structuredClone(v));
        },
        async remove(key) {
          for (const k of Array.isArray(key) ? key : [key]) data.delete(k);
        }
      }
    }
  };
}
