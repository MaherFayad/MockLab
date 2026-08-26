/**
 * §10.5's AI-access section: the status dot, §12.3's pairing form, and the one
 * copy-paste command.
 *
 * OWNER: panel-designer. A file of its own for §17.10's ~500-line ceiling — `settings.js`
 * crossed it the moment this section stopped being an inert button and a sentence — and
 * along the seam this panel already uses everywhere else: one screen, one file. The
 * import runs one way, `settings.js` -> here.
 *
 * §17.6: every word here comes from strings.js.
 * §17.7: every colour comes from panel.css.
 * §17.8: every message uses a constant from `background/messages.js`.
 *
 * ── The two facts, and why they are two ─────────────────────────────────────────────
 * `GET_COMPANION` answers `connected` and `paired` separately, and this screen never
 * collapses them (`messages.js` says why where the type is defined):
 *
 *   connected            §11's "Connected — AI agents can control this site", dot green.
 *   paired, not connected the ORDINARY state of a machine whose companion is not running.
 *                        Not an error, and not "Not connected" in the sense the button
 *                        under it offers to fix — saying that would send a person back
 *                        through a pairing they have already completed. It gets the plain
 *                        start command, because what it needs is the companion STARTED.
 *   neither              §11's "Not connected", and the way in.
 *
 * ── And why there are exactly two refusals ──────────────────────────────────────────
 * `companion/src/pairing.js` separates four causes — wrong code, expired window, too many
 * attempts, no window open — and hands the socket ONE indistinguishable answer for all
 * four on purpose: that indistinguishability is MockLab's whole security boundary, and
 * the DETAIL is printed on the terminal of the person who started the companion, who is
 * the only one entitled to it. So `PAIR_FAIL` has two values, this file has two sentences
 * for them, and neither sentence guesses which of the four fired: `pairRefused` sends the
 * person to that terminal, and `pairNoCompanion` — no socket ever opened — names the one
 * remedy that is always right and never says "type the code again".
 */
import { S } from './strings.js';
import { MSG, PAIR_FAIL } from '../background/messages.js';
import { el, spinner } from './dom.js';
import { NO_ANSWER } from './links.js';

/** §12.3's code is six digits. Nothing else is worth sending at the companion. */
const CODE_SHAPE = /^\d{6}$/;

/**
 * How long the panel waits for an answer to a pairing before it stops promising one.
 *
 * `wsClient.pair()` resolves when the socket opens, answers, or dies, and every one of
 * those is immediate over loopback. What it cannot promise is that the SERVICE WORKER
 * survives the round trip: an evicted worker answers nothing at all, and the button would
 * spin for ever under a person who did everything right. 20s is far past any real attempt
 * and far short of a person's patience.
 */
const PAIR_WAIT_MS = 20000;

/** §10.5's companion section, as the panel knows it. `ready` is null until an answer. */
export const EMPTY_COMPANION = {
  /** null before the first answer, then whether the worker handles GET_COMPANION. */
  ready: null,
  /** A socket to the companion is open RIGHT NOW. */
  connected: false,
  /** This browser has a token: §12.3 has been completed here before. */
  paired: false,
  /** The open pairing form: `{code}`. */
  form: null,
  /** One sentence about the last pairing attempt. */
  error: '',
  busy: false
};

/**
 * Every message type this section sends or listens for, declared as a list so a control
 * can check the contract is really there before it promises anything — the same idiom
 * `pick.js`, `probe.js` and `scenarios.js` use, and it has earned its keep three times:
 * each of those tabs was written before its worker half existed and rendered an honest
 * disabled state instead of posting `undefined` at the worker and appearing to hang.
 */
export const COMPANION_CONTRACT = ['PAIR_COMPANION', 'GET_COMPANION', 'COMPANION_CHANGED'];

/** @returns {string[]} contract names `messages.js` does not define. */
export function missingCompanionContract() {
  return COMPANION_CONTRACT.filter((name) => typeof MSG[name] !== 'string');
}

function ghost(text, onClick) {
  return el('button', { type: 'button', class: 'btn btn--ghost', text, onClick });
}

/**
 * Read the companion's two facts. Also the section's capability check: a worker with no
 * handler for this type answers nothing, and the whole section renders its not-ready
 * state rather than a button that does nothing.
 */
export async function loadCompanion(ctx) {
  const previous = ctx.state.companion || EMPTY_COMPANION;
  if (missingCompanionContract().length) {
    ctx.state.companion = { ...previous, ready: false, connected: false, paired: false };
    return;
  }
  const res = await ctx.send(MSG.GET_COMPANION, {});
  const ok = Boolean(res && res.ok);
  ctx.state.companion = {
    ...previous,
    ready: ok,
    // `=== true` and not truthiness: a worker that answers `{ok:true}` and nothing else
    // has told this panel nothing about a socket, and a green dot is a claim.
    connected: ok && res.connected === true,
    paired: ok && res.paired === true
  };
}

function setCompanion(ctx, patch) {
  ctx.state.companion = { ...(ctx.state.companion || EMPTY_COMPANION), ...patch };
}

/**
 * §11's sentence for a refusal — one per `PAIR_FAIL` value, and no third one invented.
 *
 * The default is not a fallback for the two above: it is the case where nothing answered
 * at all (an evicted worker, a build with no handler, the timeout), which is a fact about
 * MockLab rather than about the companion, and it says so instead of guessing.
 */
export function pairFailMessage(reason) {
  const fail = PAIR_FAIL || {};
  if (typeof fail.REFUSED === 'string' && reason === fail.REFUSED) return S.companion.pairRefused;
  if (typeof fail.NO_COMPANION === 'string' && reason === fail.NO_COMPANION) return S.companion.pairNoCompanion;
  return S.companion.pairNoAnswer;
}

/**
 * §10.5: "shows one copy-paste command". Selectable either way; the button is a nicety.
 *
 * The note under it is not one: MockLab is not on npm, so what is shown is the command's
 * NAME rather than a line that runs — see `S.companion.command`. It is rendered here, by
 * the one function that draws a command, so no caller can show the name without it.
 */
function commandRow(ctx, command) {
  const copy = el('button', { type: 'button', class: 'btn btn--ghost cmd__copy', text: S.companion.copy });
  copy.addEventListener('click', () => void copyCommand(ctx, command));
  return el(
    'div',
    { class: 'cmd-block' },
    el('div', { class: 'cmd-row' }, el('code', { class: 'cmd mono', text: command }), copy),
    el('p', { class: 'help', text: S.companion.commandNote })
  );
}

async function copyCommand(ctx, command) {
  try {
    await navigator.clipboard.writeText(command);
    ctx.toast(S.companion.copied);
  } catch {
    // A profile with no clipboard permission, or a page that is not focused. The command
    // is on screen either way, so the honest answer names the way that still works.
    ctx.toast(S.companion.copyFailed, true);
  }
}

/** §12.3's form: the command that prints a code, and the box it is typed into. */
function pairForm(ctx) {
  const info = ctx.state.companion || EMPTY_COMPANION;
  const form = info.form || { code: '' };
  const box = el('section', { class: 'editor' });
  box.append(el('h3', { text: S.companion.pairTitle }), el('p', { class: 'help', text: S.companion.pairBody }));
  box.append(commandRow(ctx, S.companion.command));

  const group = el('div', { class: 'editor__group' });
  // A visible label AND the placeholder, from the one string: a placeholder is gone the
  // moment a person starts typing, which is when they most need to know what the box is.
  group.append(el('label', { class: 'editor__label', for: 'pair-code', text: S.companion.pairPlaceholder }));
  const input = el('input', {
    class: 'editor__input',
    id: 'pair-code',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: 6,
    placeholder: S.companion.pairPlaceholder
  });
  input.value = form.code || '';
  input.addEventListener('input', () => {
    form.code = input.value;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submitPair(ctx);
  });
  group.append(input);
  if (info.error) group.append(el('p', { class: 'editor__error', role: 'alert', text: info.error }));
  box.append(group);

  const submit = el('button', { type: 'button', class: 'btn btn--primary' });
  if (info.busy) submit.append(spinner('ml-pair-spin'));
  submit.append(el('span', { text: S.companion.pairSubmit }));
  submit.disabled = info.busy;
  submit.addEventListener('click', () => void submitPair(ctx));
  box.append(
    el(
      'div',
      { class: 'editor__actions' },
      submit,
      ghost(S.editor.cancel, () => {
        setCompanion(ctx, { form: null, error: '', busy: false });
        ctx.rerender();
      })
    )
  );
  return box;
}

/**
 * §12.3, from the panel's side. The answer is one of `PAIR_FAIL`'s two values or nothing
 * at all, and each gets its own sentence — see `pairFailMessage`.
 */
async function submitPair(ctx) {
  const info = ctx.state.companion || EMPTY_COMPANION;
  if (!info.form || info.busy) return;
  const code = String(info.form.code || '').trim();
  if (!CODE_SHAPE.test(code)) {
    // Refused here, before the socket: a five-character code cannot be right, and
    // spending one of §12.3's five attempts on it would close the window sooner.
    setCompanion(ctx, { error: S.companion.codeFormat });
    ctx.rerender();
    return;
  }
  setCompanion(ctx, { busy: true, error: '' });
  ctx.rerender();

  const res = await Promise.race([
    ctx.send(MSG.PAIR_COMPANION, { code }),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: NO_ANSWER }), PAIR_WAIT_MS))
  ]);

  if (!res || !res.ok) {
    setCompanion(ctx, { busy: false, error: pairFailMessage(res && res.reason) });
    ctx.rerender();
    return;
  }
  setCompanion(ctx, { busy: false, form: null, error: '' });
  ctx.toast(S.companion.paired);
  // The dot follows the FACT, not this click: the socket opens a moment after the token
  // is stored, and `COMPANION_CHANGED` brings the panel the rest of the way (panel.js).
  await loadCompanion(ctx);
  ctx.rerender();
}

/** §10.5's AI-access section: the status dot, and the way in. */
export function renderCompanion(root, ctx) {
  const info = ctx.state.companion || EMPTY_COMPANION;
  const row = el(
    'div',
    { class: 'info-row' },
    el('span', { class: info.connected ? 'dot dot--on' : 'dot' }),
    el(
      'span',
      { class: 'check-row__text' },
      el('span', {
        class: 'check-row__label',
        text: info.connected ? S.companion.connected : info.paired ? S.companion.idle : S.companion.disconnected
      }),
      info.paired && !info.connected && el('span', { class: 'check-row__help', text: S.companion.idleHelp })
    )
  );
  root.append(row);

  if (!info.ready) {
    // Nothing is known about the companion, so nothing is offered. The button is present
    // and switched off with its reason in the sentence right after it, which is the shape
    // the a11y sweep requires of every disabled control on this screen.
    root.append(
      el('button', { type: 'button', class: 'btn btn--secondary', disabled: true, text: S.companion.setup }),
      el('p', { class: 'help', text: S.notYet })
    );
    return;
  }
  if (info.form) {
    root.append(pairForm(ctx));
    return;
  }
  // A paired browser whose companion is not running needs it STARTED, not paired again —
  // so the command here is the plain one, and §12.3's pairing command is inside the form.
  if (info.paired && !info.connected) root.append(commandRow(ctx, S.companion.start));
  if (!info.connected) {
    const open = el('button', { type: 'button', class: 'btn btn--secondary', text: S.companion.setup });
    open.addEventListener('click', () => {
      setCompanion(ctx, { form: { code: '' }, error: '' });
      ctx.rerender();
    });
    root.append(open);
  }
}
