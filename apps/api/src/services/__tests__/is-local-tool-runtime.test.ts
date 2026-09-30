import { describe, expect, it } from 'bun:test';
import { isLocalToolRuntime } from '../agent-session-config';

// Security fix D2 (2026-09-30): the openclaw chat routes skip the direct `client.chat`
// fallback (which posts the caller's verbatim prompt) whenever the wire is a local
// tool/terminal-capable runtime. This guards the exact protocol values used for that
// decision so a future rename cannot silently reopen the verbatim-prompt path.
describe('isLocalToolRuntime', () => {
  it('is true for the server-hosted local runtimes', () => {
    expect(isLocalToolRuntime('hermes-local')).toBe(true);
    expect(isLocalToolRuntime('openclaw-local')).toBe(true);
  });

  it('is false for every remote / inert wire and for empty input', () => {
    for (const p of ['nanoclaw', 'openai-compat', 'hatcher-proxy', 'custom', null, undefined, '']) {
      expect(isLocalToolRuntime(p)).toBe(false);
    }
  });
});
