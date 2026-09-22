import { createHash, randomInt } from 'node:crypto';

/**
 * The confirmation code that turns a priced preview into a real charge.
 *
 * THE INVARIANT THIS FILE EXISTS FOR: the code must originate in the
 * REQUESTER'S input, never in the RESPONDER'S output. A language model that
 * writes `[ACTION: DOORDASH_SUBMIT(confirm=ACDEFG)]` can simply echo a code it
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
 * ACDEFG, tip 4" or paste the whole sentence back. What matters is only that
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
 * is. Require an explicit tip phrase. Bare amounts mean dollars; cents need
 * an explicit cents unit. Unrelated item quantities never authorize money.
 *
 * CALL THIS WITH THE CODE ALREADY MASKED OUT (see maskConfirmCode). The code
 * must not be parsed as part of the tip amount or confirmation grammar.
 *
 * Conflicting amounts, negated amounts, and percentages require clarification.
 * This is deliberately narrower than a model's interpretation of the message.
 */
export function tipStatedByRequester(requesterTurn: string, tipCents: number): boolean {
  if (!Number.isSafeInteger(tipCents) || tipCents < 0) return false;
  if (/\b(?:not|never|don['’]?t|do\s+not|or|maybe|about|around|approximately|if)\b|[?%]|\bpercent\b/i.test(requesterTurn)) return false;
  // Multiple numeric values can be a range, a correction, a decimal comma,
  // or a thousands separator. Require a new unambiguous confirmation turn.
  const numbers = requesterTurn.match(/\d+(?:\.\d+)?/g) ?? [];
  if (numbers.length > 1) return false;
  const amounts: number[] = [];
  // Parse the whole masked turn. An arbitrary prefix can cancel or question
  // an otherwise valid amount ("cancel the order, tip 4"). Refuse rather than
  // trying to classify every possible negation in natural language.
  const beginning = String.raw`^[\s.,;!:]*(?:(?:yes|yeah|ok|okay|confirm|confirmed|code|please|place\s+it|place\s+the\s+order|order\s+it|go\s+ahead|and|with|a|i\s+choose\s+to|i\s+want\s+to|i\s+would\s+like\s+to)[\s.,;!:]+)*`;
  const ending = String.raw`(?:[\s.,;!]*(?:please|thanks|thank\s+you|confirm|place\s+it|order\s+it|go\s+ahead|now))*[\s.,;!]*$`;
  if (new RegExp(String.raw`${beginning}(?:no|zero|without\s+a|skip\s+the)\s+tip${ending}`, 'i').test(requesterTurn)) {
    if (numbers.length > 0) return false;
    amounts.push(0);
  }
  const amount = String.raw`(\$?)(\d+(?:\.\d{1,2})?)(?:\s*(cents?|dollars?|usd))?`;
  const before = new RegExp(String.raw`${beginning}tip\s*(?:of\s+|is\s+|:\s*)?${amount}${ending}`, 'gi');
  const after = new RegExp(String.raw`${beginning}${amount}\s+(?:for\s+(?:the\s+)?)?tip\b${ending}`, 'gi');
  for (const pattern of [before, after]) {
    for (const match of requesterTurn.matchAll(pattern)) {
      const [, dollarSign, value, unit] = match;
      const cents = unit?.toLowerCase().startsWith('cent') === true;
      if (cents && (dollarSign || value.includes('.'))) return false;
      const [whole, decimal = ''] = value.split('.');
      const parsed = cents ? Number(whole) : Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
      if (!Number.isSafeInteger(parsed)) return false;
      amounts.push(parsed);
    }
  }
  return amounts.length > 0 && amounts.every((amount) => amount === tipCents);
}
