import React from "react";
import {
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { SPRING_BOUNCY } from "../../constants/timing";
import type { Species } from "../../constants/species";
import { SPECIES_SPRITE_PATH } from "../../constants/species";

type PetSpriteProps = {
  species: Species;
  size?: number;
  enterDelay?: number;
  bob?: boolean;
  flipX?: boolean;
  style?: React.CSSProperties;
};

export const PetSprite: React.FC<PetSpriteProps> = ({
  species,
  size = 120,
  enterDelay = 0,
  bob = true,
  flipX = false,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame,
    fps,
    delay: enterDelay,
    config: SPRING_BOUNCY,
  });

  const scale = interpolate(entrance, [0, 1], [0, 1]);

  const bobOffset = bob
    ? Math.sin(((frame - enterDelay) / fps) * 3 * Math.PI * 2) * 3
    : 0;

  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transform: `scale(${scale}) translateY(${bobOffset}px) scaleX(${flipX ? -1 : 1})`,
        ...style,
      }}
    >
      <Img
        src={staticFile(SPECIES_SPRITE_PATH[species])}
        style={{
          height: size,
          width: "auto",
          objectFit: "contain",
        }}
      />
    </div>
  );
};
