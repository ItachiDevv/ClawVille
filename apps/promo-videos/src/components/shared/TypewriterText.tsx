import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";

type TypewriterTextProps = {
  text: string;
  startFrame?: number;
  charsPerSecond?: number;
  style?: React.CSSProperties;
};

export const TypewriterText: React.FC<TypewriterTextProps> = ({
  text,
  startFrame = 0,
  charsPerSecond = 30,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const elapsed = Math.max(0, frame - startFrame);
  const charsToShow = Math.floor((elapsed / fps) * charsPerSecond);
  const visibleText = text.slice(0, Math.min(charsToShow, text.length));
  const showCursor = charsToShow < text.length;

  return (
    <span style={style}>
      {visibleText}
      {showCursor && (
        <span style={{ opacity: Math.sin((frame / fps) * 6) > 0 ? 1 : 0 }}>
          |
        </span>
      )}
    </span>
  );
};
