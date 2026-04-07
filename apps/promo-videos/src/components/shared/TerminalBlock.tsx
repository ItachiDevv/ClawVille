import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";

type TerminalBlockProps = {
  lines: string[];
  startFrame?: number;
  charsPerSecond?: number;
  width?: number;
};

export const TerminalBlock: React.FC<TerminalBlockProps> = ({
  lines,
  startFrame = 0,
  charsPerSecond = 40,
  width,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const elapsed = Math.max(0, frame - startFrame);
  const totalCharsRevealed = Math.floor((elapsed / fps) * charsPerSecond);

  let charsUsed = 0;
  const renderedLines = lines.map((line) => {
    const remaining = totalCharsRevealed - charsUsed;
    charsUsed += line.length;
    if (remaining <= 0) return null;
    return line.slice(0, Math.min(remaining, line.length));
  });

  const showCursor =
    totalCharsRevealed < lines.reduce((a, b) => a + b.length, 0);

  return (
    <div
      style={{
        background: "#0A1628",
        border: "2px solid #1B4D89",
        borderRadius: 12,
        padding: "16px 20px",
        fontFamily: "'Courier New', monospace",
        fontSize: 16,
        color: "#00E5FF",
        lineHeight: 1.6,
        width,
        boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 6,
          marginBottom: 12,
          paddingBottom: 8,
          borderBottom: "1px solid #1B4D89",
        }}
      >
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#ff5f57" }} />
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#ffbd2e" }} />
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#28c840" }} />
      </div>
      {renderedLines.map(
        (line, i) =>
          line !== null && (
            <div key={i} style={{ whiteSpace: "pre" }}>
              {i === 0 && <span style={{ color: "#555" }}>$ </span>}
              {line}
              {i === renderedLines.filter((l) => l !== null).length - 1 &&
                showCursor && (
                  <span style={{ opacity: Math.sin((frame / fps) * 6) > 0 ? 1 : 0 }}>
                    █
                  </span>
                )}
            </div>
          )
      )}
    </div>
  );
};
