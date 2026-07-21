export function AgentConnectInstructions() {
  return (
    <div className="bg-cyan-500/5 border border-cyan-500/15 rounded-lg px-3 py-2">
      <p className="text-cyan-300/70 font-bold text-xs mb-1">How it works:</p>
      <ol className="text-[11px] text-white/40 space-y-1 list-decimal list-inside">
        <li>Generate your connect link below</li>
        <li>Copy the one-line instruction into your agent&apos;s chat</li>
        <li>Your agent follows it and connects automatically</li>
      </ol>
    </div>
  );
}
