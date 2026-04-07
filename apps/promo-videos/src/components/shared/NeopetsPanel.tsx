import React from "react";
import { COLORS } from "../../constants/colors";

type NeopetsPanelProps = {
  children: React.ReactNode;
  width?: number;
  style?: React.CSSProperties;
};

export const NeopetsPanel: React.FC<NeopetsPanelProps> = ({
  children,
  width,
  style,
}) => {
  return (
    <div
      style={{
        background: COLORS.panelBg,
        border: `4px solid ${COLORS.border}`,
        borderRadius: 16,
        padding: "16px 24px",
        boxShadow: "4px 4px 0px rgba(0,0,0,0.3)",
        width,
        ...style,
      }}
    >
      {children}
    </div>
  );
};
