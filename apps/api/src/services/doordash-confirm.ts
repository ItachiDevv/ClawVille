import { createHash, randomInt } from 'node:crypto';

/**
 * The confirmation code that turns a priced preview into a real charge.
 *
 * THE INVARIANT THIS FILE EXISTS FOR: the code must originate in the
 * REQUESTER'S input, never in the RESPONDER'S output. A language model that
 * writes `[ACTION: DOORDASH_SUBMIT(confirm=A1B2C3)]` can simply echo a code it
 * just produced a moment earlier, so the check never reads the model's reply.
 * It reads the raw request body the route captured before any model ran.
 */

// No 0/O/1/I/S/5/B/8/2/Z — a code gets read off a screen and typed back, and a
// misread character must fail closed rather than land on a different live code.
const ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';
const CODE_LENGTH = 6;

export function mintConfirmCode(): string {
  let code = '';
  // randomInt is the CSPRNG path. Math.random here would make a code guessable
  // by anyone who could see one, which on this path costs the founder money.
  for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

export function hashConfirmCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase(), 'utf8').digest('hex');
}

export function isWellFormedConfirmCode(code: string): boolean {
  return new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`).test(code.trim().toUpperCase());
}

/**
 * Did the code appear in the human's own words?
 *
 * Case-insensitive substring is the right test: the founder may type "yes,
 * A1B2C3, tip 4" or paste the whole sentence back. What matters is only that
 * the characters came from the request body rather than the model's reply.
 */
export function codeStatedByRequester(requesterTurn: string, code: string): boolean {
  if (!isWellFormedConfirmCode(code)) return false;
  return requesterTurn.toUpperCase().includes(code.trim().toUpperCase());
}

/**
 * Blank out every occurrence of the confirmation code in the turn.
 *
 * THIS IS LOAD BEARING, not tidiness. The code alphabet contains the digits
 * 3, 4, 6, 7 and 9, and the tip check searches the SAME turn the code must
 * appear in — so without this, the code itself is a guaranteed digit source on
 * every order. A code of `K7Y46D` would let a model claim a $46 tip against a
 * turn that says only "yes K7Y46D", and about 72% of codes carry at least one
 * digit. Masking first means the tip has to come from the human's own words.
 *
 * Literal and case-insensitive on purpose: the code is validated against a
 * fixed alphabet before it reaches here, but building a RegExp out of caller
 * input is a habit worth not having.
 */
export function maskConfirmCode(turn: string, code: string): string {
  const needle = code.trim().toUpperCase();
  if (!needle) return turn;
  let masked = '';
  let rest = turn;
  for (;;) {
    const at = rest.toUpperCase().indexOf(needle);
    if (at === -1) return masked + rest;
    masked += `${rest.slice(0, at)} `;
    rest = rest.slice(at + needle.length);
  }
}

/**
 * Did the human state this tip amount?
 *
 * The founder ruled that the tip is never defaulted and never model-chosen, so
 * the amount has to be traceable to the requester's turn the same way the code
 * is. Accepts the natural ways a person writes it: `4`, `$4`, `4.00`, `4.50`,
 * or the raw cents value, plus "no tip" for zero.
 *
 * CALL THIS WITH THE CODE ALREADY MASKED OUT (see maskConfirmCode). Passing the
 * raw turn lets the code's own digits authorise a tip.
 *
 * KNOWN LIMITATION, stated rather than hidden: this asks whether the NUMBER
 * appears, not whether it appears as the tip. A turn like "add 4 garlic knots"
 * would satisfy a claimed tip of $4. That one is an incidental coincidence in
 * the human's own words, it is bounded by the per-order and per-day caps and by
 * the Telegram notification on every submit, and the check's real job — stopping
 * a model inventing an amount out of nothing — still holds.
 */
export function tipStatedByRequester(requesterTurn: string, tipCents: number): boolean {
  if (!Number.isSafeInteger(tipCents) || tipCents < 0) return false;
  if (tipCents === 0 && /\b(?:no|zero|without\s+a|skip\s+the)\s+tip\b/i.test(requesterTurn)) return true;
  const dollars = tipCents / 100;
  const candidates = new Set<string>([String(tipCents), dollars.toFixed(2), String(dollars)]);
  for (const candidate of candidates) {
    const escaped = candidate.replace(/\./g, '\\.');
    // The match has to be the WHOLE number, never a piece of a longer one.
    // "45" must not satisfy a claimed $4 tip, and neither must "4.50" — that
    // second case is why the lookahead also rejects a following ".<digit>",
    // while still allowing a sentence that simply ends "tip 4".
    if (new RegExp(`(?<![\\d.])${escaped}(?!\\d|\\.\\d)`).test(requesterTurn)) return true;
  }
  return false;
}
