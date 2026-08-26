/**
 * PLAN.md §12.3 — the token, the code, and the window.
 *
 * OWNER: mcp-engineer.
 *
 * Every test here is written so that REMOVING the rule it names makes it fail. The three
 * that matter most, and what breaks them:
 *   • deleting the attempt limit          -> "a wrong code can be guessed at for ever"
 *   • returning a reason with a refusal   -> "every refusal looks the same"
 *   • reusing a spent window              -> "one window, one pairing"
 * A test that only asserted today's output would pass with all three removed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  createPairing,
  loadOrCreateToken,
  looksLikeToken,
  pairingCode,
  tokenPath,
  MAX_ATTEMPTS,
  PAIRING_WINDOW_MS,
  TOKEN_BYTES
} from '../src/pairing.js';

/** Every test that touches disk runs against its own home directory. */
function withHome(run) {
  const previous = process.env.MOCKLAB_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklab-home-'));
  process.env.MOCKLAB_HOME = home;
  try {
    return run(home);
  } finally {
    if (previous === undefined) delete process.env.MOCKLAB_HOME;
    else process.env.MOCKLAB_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('§12.3 the token is 32 random bytes, written owner-only, and never regenerated', () => {
  withHome(() => {
    const first = loadOrCreateToken();
    assert.equal(first.created, true);
    assert.equal(looksLikeToken(first.token), true);
    assert.equal(first.token.length, TOKEN_BYTES * 2);

    const second = loadOrCreateToken();
    assert.equal(second.created, false);
    assert.equal(second.token, first.token, 'a second start must not unpair every browser');

    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(tokenPath()).mode & 0o777, 0o600, 'the token is not world-readable');
      assert.equal(fs.statSync(path.dirname(tokenPath())).mode & 0o777, 0o700);
    }
  });
});

test('§12.3 a file that is not a token is an error, never a silent new pairing', () => {
  withHome(() => {
    fs.mkdirSync(path.dirname(tokenPath()), { recursive: true });
    fs.writeFileSync(tokenPath(), 'not a token');
    assert.throws(() => loadOrCreateToken(), /does not hold a MockLab token/);
  });
});

test('§12.3 the code is six digits, derived from the token, and stable', () => {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const code = pairingCode(token);
  assert.match(code, /^[0-9]{6}$/);
  assert.equal(pairingCode(token), code, 'the companion prints it; the person types it later');
  assert.notEqual(pairingCode(crypto.randomBytes(TOKEN_BYTES).toString('hex')), code);
});

test('§12.3 a code that is 6 digits after padding keeps its leading zeros', () => {
  // The digest is reduced mod 10^6, so one token in ten produces fewer than six digits.
  // A code printed as "4213" and typed as "004213" would never match.
  let padded = null;
  for (let i = 0; i < 4000 && !padded; i += 1) {
    const code = pairingCode(crypto.randomBytes(TOKEN_BYTES).toString('hex'));
    if (code.startsWith('0')) padded = code;
  }
  assert.ok(padded, 'expected at least one code below 100000 in 4000 tries');
  assert.equal(padded.length, 6);
});

test('§16 M6 DoD: a wrong pairing code is rejected, and says nothing else', () => {
  const refusals = [];
  const pairing = createPairing({ token: 'a'.repeat(64), onRefusal: (why) => refusals.push(why) });
  const { code } = pairing.open();
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');

  assert.equal(pairing.submit(wrong), false);
  assert.equal(pairing.submit('abcdef'), false, 'a malformed code is refused, not thrown at');
  assert.equal(pairing.submit(''), false);
  assert.equal(pairing.submit(undefined), false);
  // Every refusal is the same value: `false`. Nothing distinguishes "wrong code" from
  // "no window" from "expired" to whoever is asking.
  assert.equal(new Set([pairing.submit(wrong)]).size, 1);
  // The DETAIL exists — on the companion's own terminal, for the person who started it.
  assert.ok(refusals.length >= 4);
  assert.ok(refusals.every((line) => !line.includes(code)), 'a refusal never echoes the real code');
});

test('§12.3 the right code hands over the token, and the window is then spent', () => {
  const token = 'b'.repeat(64);
  const pairing = createPairing({ token });
  const { code } = pairing.open();
  assert.equal(pairing.isOpen(), true);
  assert.equal(pairing.submit(code), token);
  assert.equal(pairing.isOpen(), false, 'one window, one pairing');
  assert.equal(pairing.submit(code), false, 'the same code cannot pair a second client');
  assert.ok(pairing.pairedAt() > 0);
});

test('§12.3 two clients racing the same window: the first correct code wins, alone', () => {
  const token = 'c'.repeat(64);
  const pairing = createPairing({ token });
  const { code } = pairing.open();
  const first = pairing.submit(code);
  const second = pairing.submit(code);
  assert.equal(first, token);
  assert.equal(second, false);
});

test('the attempt limit closes the window — six digits is not a password', () => {
  // The limit is asserted to be SMALL before it is used as a loop bound. A test that
  // simply counted to MAX_ATTEMPTS would loop for ever if somebody raised it to a number
  // that makes the limit meaningless — the mutation this test exists to catch.
  assert.ok(MAX_ATTEMPTS >= 3 && MAX_ATTEMPTS <= 10, `${MAX_ATTEMPTS} guesses is not a limit`);
  const pairing = createPairing({ token: 'd'.repeat(64) });
  const { code } = pairing.open();
  const wrong = String((Number(code) + 7) % 1000000).padStart(6, '0');
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) assert.equal(pairing.submit(wrong), false);
  assert.equal(pairing.isOpen(), false, `${MAX_ATTEMPTS} wrong codes must close the window`);
  assert.equal(pairing.submit(code), false, 'and the RIGHT code no longer works either');
});

test('§12.3 the window is five minutes, and a late code is refused', () => {
  let clock = 1_000_000;
  const pairing = createPairing({ token: 'e'.repeat(64), now: () => clock });
  const { code, expiresAt } = pairing.open();
  assert.equal(expiresAt - clock, PAIRING_WINDOW_MS);
  clock += PAIRING_WINDOW_MS - 1;
  assert.equal(pairing.isOpen(), true);
  clock += 2;
  assert.equal(pairing.isOpen(), false);
  assert.equal(pairing.submit(code), false, 'the code is right and the window is over');
});

test('a bearer token is compared whole, and only the real one matches', () => {
  const token = 'f'.repeat(64);
  const pairing = createPairing({ token });
  assert.equal(pairing.isToken(token), true);
  assert.equal(pairing.isToken(token.slice(0, 63)), false, 'a prefix is not a token');
  assert.equal(pairing.isToken(token + '0'), false);
  assert.equal(pairing.isToken(token.toUpperCase()), false, 'the stored form is lowercase hex');
  assert.equal(pairing.isToken(''), false);
  assert.equal(pairing.isToken(null), false);
  assert.equal(pairing.isToken('g'.repeat(64)), false, 'not hex');
  assert.equal(pairing.isToken('0'.repeat(64)), false);
});
