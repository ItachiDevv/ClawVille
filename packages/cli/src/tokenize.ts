/**
 * Strict tokenizer for one install line from the bundled catalog.
 *
 * The CLI never hands a catalog line to a shell. It splits the line on spaces
 * and refuses any token that holds a character outside a small safe set, so a
 * quote, `$`, `;`, `&`, `|`, `<`, `>`, `%`, `!`, `^`, a backtick or a backslash
 * stops the CLI before anything runs. The same check guards the arguments that
 * reach `cmd.exe /c` for a Windows `.cmd` shim (see `exec.ts`).
 */

/** Letters, digits and `@ : . _ / + -`. Enough for every served install line. */
const SAFE_TOKEN = /^[A-Za-z0-9@:._/+-]+$/;

export class UnsafeTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeTokenError';
  }
}

export function isSafeToken(token: string): boolean {
  return SAFE_TOKEN.test(token);
}

/** Split one line into argv. Throws `UnsafeTokenError` on any unsafe character. */
export function tokenizeSnippetLine(line: string): string[] {
  if (/[\r\n]/.test(line)) throw new UnsafeTokenError('An install line must be one line.');
  const tokens = line.split(/[ \t]+/).filter((token) => token.length > 0);
  if (tokens.length === 0) throw new UnsafeTokenError('An install line is empty.');
  for (const token of tokens) {
    if (!isSafeToken(token)) {
      throw new UnsafeTokenError(`Refused install line: the token "${token.slice(0, 40)}" holds a character that is not allowed.`);
    }
  }
  return tokens;
}

/** One snippet (one command per line) to a list of argv arrays. */
export function tokenizeSnippet(snippet: string): string[][] {
  return snippet
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(tokenizeSnippetLine);
}
