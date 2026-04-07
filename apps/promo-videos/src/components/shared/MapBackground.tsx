import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  Easing,
} from "remotion";

type MapBackgroundProps = {
  tintColor?: string;
  tintOpacity?: number;
  zoom?: number;
  zoomRange?: [number, number];
  panX?: number;
  panY?: number;
  panXRange?: [number, number];
  panYRange?: [number, number];
  vignette?: boolean;
};

const MAP_ASPECT = 1590 / 1154;
const MAP_FILE = "map/clawville-map.png";

export const MapBackground: React.FC<MapBackgroundProps> = ({
  tintColor = "rgba(0,0,0,0)",
  tintOpacity = 0,
  zoom = 1.2,
  zoomRange,
  panX = 0,
  panY = 0,
  panXRange,
  panYRange,
  vignette = true,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();

  const currentZoom = zoomRange
    ? interpolate(frame, [0, durationInFrames], zoomRange, {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.inOut(Easing.quad),
      })
    : zoom;

  const currentPanX = panXRange
    ? interpolate(frame, [0, durationInFrames], panXRange, {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.inOut(Easing.quad),
      })
    : panX;
  const currentPanY = panYRange
    ? interpolate(frame, [0, durationInFrames], panYRange, {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.inOut(Easing.quad),
      })
    : panY;

  const viewAspect = width / height;

  let mapW: number;
  let mapH: number;
  if (viewAspect > MAP_ASPECT) {
    mapW = width * currentZoom;
    mapH = mapW / MAP_ASPECT;
  } else {
    mapH = height * currentZoom;
    mapW = mapH * MAP_ASPECT;
  }

  const offsetX = (width - mapW) / 2 + currentPanX * mapW;
  const offsetY = (height - mapH) / 2 + currentPanY * mapH;

  return (
    <AbsoluteFill>
      <Img
        src={staticFile(MAP_FILE)}
        style={{
          position: "absolute",
          left: offsetX,
          top: offsetY,
          width: mapW,
          height: mapH,
          objectFit: "cover",
        }}
      />

      {tintOpacity > 0 && (
        <AbsoluteFill
          style={{
            backgroundColor: tintColor,
            opacity: tintOpacity,
          }}
        />
      )}

      {vignette && (
        <AbsoluteFill
          style={{
            background:
              "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.6) 100%)",
          }}
        />
      )}
    </AbsoluteFill>
  );
};
