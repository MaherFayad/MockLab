/**
 * PLAN.md §12.3 — the token, the 6-digit code, and the one window in which a code works.
 *
 * OWNER: mcp-engineer.
 *
 * This file is the whole of MockLab's security boundary. Everything the hub will do for
 * a socket — read the user's open tabs, change what a site sees, take a screenshot —
 * stands behind the two functions here, so each one is written to fail CLOSED and to
 * tell a caller as little as possible about why.
 *
 * §12.3, kept literally:
 *   • 32 random bytes, hex, at ~/.mocklab/token (0600, in a 0700 directory).
 *   • the code is derived from the token: `sha256(token) mod 10^6`, six digits.
 *   • one active pairing window, five minutes.
 *   • on a match the companion hands the full token over the loopback socket; the
 *     extension stores it and presents it as `Authorization: Bearer` from then on.
 *
 * Three things it adds, none silently — every one is reported to the orchestrator for
 * README's Deviations, because §12.3 is a minimum and a local WebSocket that controls a
 * browser is worth more than a minimum:
 *
 *   1. ATTEMPT LIMIT. Six digits is a million codes. A wrong-code loop over a loopback
 *      socket runs at thousands a second, so a five-minute window is a five-minute brute
 *      force, not a five-minute window. `MAX_ATTEMPTS` wrong codes close the window; the
 *      user restarts the companion to open another. That turns the attack back into what
 *      §12.3 intends it to be: one guess in a million, per restart the user performs.
 *   2. ONE ANSWER FOR EVERY REFUSAL. "no window open", "window expired", "too many
 *      tries" and "wrong code" are one indistinguishable `false` to the socket. The
 *      DETAIL is printed on the companion's own terminal, where the person who started
 *      it — the only person entitled to it — can read it.
 *   3. CONSTANT-TIME COMPARE. `timingSafeEqual` on the two six-character buffers. The
 *      margin a timing attack would win here is small; writing `===` and reasoning about
 *      why it is fine is how the same code gets copied somewhere it is not.
 *
 * KNOWN WEAKNESS in §12.3 itself, implemented as specified and reported rather than
 * quietly changed: the code is a pure function OF THE TOKEN, so it is the same six
 * digits on this machine for ever. Anybody who ever sees it — a screen share, a shell
 * history, a terminal scrollback — can re-pair at the next window without the token. A
 * code random per window, and unrelated to the token, would cost nothing and leak
 * nothing. Not changed here: §12.3 names the derivation, the extension has no way to
 * learn a different one, and a spec deviation invented inside a security file is exactly
 * the kind nobody notices.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** §12.3: "a random 32-byte hex token". 64 hex characters. */
export const TOKEN_BYTES = 32;
/** §12.3: "single active pairing window of 5 min". */
export const PAIRING_WINDOW_MS = 5 * 60 * 1000;
/** Wrong codes before the window closes itself. See note 1 in the header. */
export const MAX_ATTEMPTS = 5;
/** §12.3's code is six digits, so every comparison is over six bytes. */
export const CODE_DIGITS = 6;

/**
 * Where the token lives. `MOCKLAB_HOME` overrides the home directory so a test can run
 * against a temporary one — the tests here create and destroy real files, and a suite
 * that wrote to the developer's own `~/.mocklab/token` would unpair their browser.
 */
export function mocklabHome() {
  return process.env.MOCKLAB_HOME || path.join(os.homedir(), '.mocklab');
}

export function tokenPath() {
  return path.join(mocklabHome(), 'token');
}

/** 64 lowercase hex characters, and nothing else, is a token. */
export function looksLikeToken(value) {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`).test(value);
}

/**
 * The token for this machine: the one on disk, or a new one written with owner-only
 * permissions.
 *
 * A file that exists but does not hold a token is an ERROR, never a silent overwrite.
 * Overwriting would unpair every browser already paired, at the moment the user can
 * least explain it, and would do it without saying so.
 *
 * @returns {{token:string, created:boolean, file:string}}
 */
export function loadOrCreateToken() {
  const file = tokenPath();
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (!looksLikeToken(existing)) {
      throw new Error(
        `${file} does not hold a MockLab token. Delete the file and start the companion ` +
          'again to make a new one — every browser paired with the old token will have to pair again.'
      );
    }
    return { token: existing, created: false, file };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  // mkdir's `mode` is masked by the process umask, and an existing directory keeps the
  // permissions it already had. Neither is a reason to leave the token world-readable.
  try {
    fs.chmodSync(path.dirname(file), 0o700);
    fs.chmodSync(file, 0o600);
  } catch {
    /* a filesystem without POSIX modes (a Windows share) — the file is still written */
  }
  return { token, created: true, file };
}

/**
 * §12.3's code: `sha256(token) mod 10^6`, left-padded to six digits.
 *
 * READING, stated because §12.3's phrasing ("first 6 digits of sha256(token) mod 10^6")
 * admits two: the whole digest is taken as one big-endian integer and reduced, rather
 * than reducing some prefix of it. Both are six digits and neither is stronger; what
 * matters is that ONE of them is written down, because the companion prints this number
 * and a human types it into a browser that must derive nothing at all.
 */
export function pairingCode(token) {
  const digest = crypto.createHash('sha256').update(String(token)).digest('hex');
  const value = BigInt('0x' + digest) % 1000000n;
  return value.toString().padStart(CODE_DIGITS, '0');
}

/** Six characters, so `timingSafeEqual` always has two equal-length buffers. */
function sixDigits(value) {
  const text = String(value == null ? '' : value).trim();
  return /^[0-9]{6}$/.test(text) ? Buffer.from(text, 'utf8') : null;
}

/**
 * The pairing window: open it once, spend it once.
 *
 * @param {{token:string, now?:() => number, onRefusal?:(detail:string) => void}} options
 */
export function createPairing(options) {
  const now = options.now || Date.now;
  const token = options.token;
  const expected = Buffer.from(pairingCode(token), 'utf8');
  /** @type {{openedAt:number, expiresAt:number, attempts:number}|null} */
  let window = null;
  let pairedAt = 0;

  /** The detail goes to the companion's terminal, never to the socket. */
  function refuse(detail) {
    if (options.onRefusal) options.onRefusal(detail);
    return false;
  }

  return {
    /** §12.3: one window, five minutes. Opening again replaces the one before it. */
    open() {
      window = { openedAt: now(), expiresAt: now() + PAIRING_WINDOW_MS, attempts: 0 };
      return { code: pairingCode(token), expiresAt: window.expiresAt };
    },

    close() {
      window = null;
    },

    isOpen() {
      return Boolean(window) && now() < window.expiresAt && window.attempts < MAX_ATTEMPTS;
    },

    /** Whole numbers of seconds left, or 0 — for the terminal, not for the socket. */
    secondsLeft() {
      if (!window) return 0;
      return Math.max(0, Math.ceil((window.expiresAt - now()) / 1000));
    },

    pairedAt() {
      return pairedAt;
    },

    /**
     * Is this the code? Every refusal returns the same `false`, and every refusal
     * spends an attempt — including a malformed one, which is what a script that has
     * not worked out the format yet sends.
     *
     * @param {unknown} code @returns {string|false} the token, or false
     */
    submit(code) {
      if (!window) return refuse('a pairing code arrived with no pairing window open');
      if (now() >= window.expiresAt) {
        window = null;
        return refuse('a pairing code arrived after the 5 minute window closed');
      }
      window.attempts += 1;
      const given = sixDigits(code);
      const match = given !== null && crypto.timingSafeEqual(given, expected);
      if (match) {
        window = null;
        pairedAt = now();
        return token;
      }
      const spent = window.attempts;
      if (spent >= MAX_ATTEMPTS) {
        window = null;
        return refuse(`wrong pairing code (${spent} of ${MAX_ATTEMPTS}) — the window is now closed`);
      }
      return refuse(`wrong pairing code (${spent} of ${MAX_ATTEMPTS})`);
    },

    /** Does this bearer token match? Constant-time, and length-checked first. */
    isToken(candidate) {
      if (!looksLikeToken(candidate)) return false;
      const a = Buffer.from(candidate, 'utf8');
      const b = Buffer.from(token, 'utf8');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
  };
}
