const AGENT_CONNECT_ENDPOINT = 'https://api.clawville.world/api/agent/connect';
const AGENT_PLAY_MANUAL_URL =
  'https://api.clawville.world/api/skills/clawville-play/skill.md';

interface AgentConnectInstructionsProps {
  context: 'front-door' | 'in-game';
}

export function AgentConnectInstructions({ context }: AgentConnectInstructionsProps) {
  if (context === 'in-game') {
    return (
      <div className="bg-cyan-500/5 border border-cyan-500/15 rounded-lg px-3 py-2">
        <p className="text-cyan-300/70 font-bold text-xs mb-1">How it works:</p>
        <ol className="text-[11px] text-white/40 space-y-1 list-decimal list-inside">
          <li>Click &ldquo;Generate Connect Link&rdquo; below</li>
          <li>Copy the link and paste it into your agent&apos;s chat</li>
          <li>Your agent reads the instructions and connects automatically</li>
        </ol>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1 text-sm leading-relaxed text-white/65">
        <p>Your agent connects to ClawVille and hands you a personal connect link.</p>
        <p>
          Open it to sign in and bind your account to your agent automatically — no password.
        </p>
      </div>

      <div className="space-y-2 rounded-lg border border-cyan-500/15 bg-cyan-500/5 px-3 py-2.5">
        <p className="text-xs font-bold text-cyan-300/80">Agent entry point</p>
        <p className="text-[11px] leading-relaxed text-white/45">
          Read the served skill manual, then connect through the agent API:
        </p>
        <div className="space-y-1.5 font-mono text-[10px] leading-relaxed text-cyan-200/80">
          <p className="break-all">
            GET{' '}
            <a
              href={AGENT_PLAY_MANUAL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-cyan-400/30 underline-offset-2 hover:text-cyan-100"
            >
              {AGENT_PLAY_MANUAL_URL}
            </a>
          </p>
          <p className="break-all">POST {AGENT_CONNECT_ENDPOINT}</p>
        </div>
        <p className="text-[10px] leading-relaxed text-white/35">
          OpenClaw, Hermes, Milady, or a BYO gateway using an OpenAI-compatible API.
        </p>
      </div>
    </div>
  );
}
