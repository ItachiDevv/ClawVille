/**
 * Generate 8 high-quality pixel art sprite sheets (one per species) for ClawVille.
 * All 8 species are lobster variants with distinct morphology.
 * Each sheet is 1024x1280 (8 cols x 10 rows of 128x128 frames).
 *
 * Row layout:
 * 0: idle (8f)       4: walk-right (8f)   8: block(4f) + dodge(4f)
 * 1: walk-down (8f)  5: attack (8f)       9: special (8f)
 * 2: walk-up (8f)    6: hurt (8f)
 * 3: walk-left (8f)  7: death (8f)
 */

import sharp from "sharp";
import { mkdirSync } from "fs";
import { join } from "path";

const SHEET_W = 1024;
const SHEET_H = 1280;
const FRAME = 128;
const COLS = 8;
const ROWS = 10;

const OUT_DIR = join(__dirname, "..", "apps", "web", "public", "sprites", "pets");

// ═══════════════════════════════════════════════════════════════
// Color System — base, highlight, shadow, outline auto-generated
// ═══════════════════════════════════════════════════════════════

type RGB = [number, number, number];

interface ColorSet {
  base: RGB;
  highlight: RGB;
  shadow: RGB;
  outline: RGB;
}

function lighten(c: RGB, amount: number): RGB {
  return [
    Math.min(255, Math.round(c[0] + (255 - c[0]) * amount)),
    Math.min(255, Math.round(c[1] + (255 - c[1]) * amount)),
    Math.min(255, Math.round(c[2] + (255 - c[2]) * amount)),
  ];
}

function darken(c: RGB, amount: number): RGB {
  return [
    Math.max(0, Math.round(c[0] * (1 - amount))),
    Math.max(0, Math.round(c[1] * (1 - amount))),
    Math.max(0, Math.round(c[2] * (1 - amount))),
  ];
}

function makeColorSet(base: RGB): ColorSet {
  return {
    base,
    highlight: lighten(base, 0.35),
    shadow: darken(base, 0.35),
    outline: darken(base, 0.55),
  };
}

function lerpColor(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// ═══════════════════════════════════════════════════════════════
// Species Definitions — All Lobster Variants
// ═══════════════════════════════════════════════════════════════

interface SpeciesDef {
  name: string;
  label: string;
  body: RGB;
  accent: RGB;
  belly: RGB;
  eye: RGB;
  // Proportions (relative to 128x128 frame)
  headRadius: number;
  bodyRx: number;
  bodyRy: number;
  legLength: number;
  clawSize: number;       // claw scale multiplier (1 = normal, 1.5 = wolf/crusher)
  antennaLength: number;  // antenna length multiplier
  hasShellOnBack: boolean;
  hasBioluminescence: boolean;
  hasRainbowBands: boolean;
  hasBubbles: boolean;
  hasHeavyArmor: boolean;
  walkStyle: "scuttle" | "hop" | "waddle" | "stomp" | "glide";
}

const SPECIES: SpeciesDef[] = [
  {
    name: "cat", label: "Reef Lobster",
    body: [255, 100, 80], accent: [255, 220, 180], belly: [255, 235, 210],
    eye: [60, 200, 80],
    headRadius: 16, bodyRx: 20, bodyRy: 16, legLength: 12, clawSize: 1.0,
    antennaLength: 1.0, hasShellOnBack: false, hasBioluminescence: false,
    hasRainbowBands: false, hasBubbles: false, hasHeavyArmor: false,
    walkStyle: "scuttle",
  },
  {
    name: "dragon", label: "Abyssal Lobster",
    body: [30, 30, 100], accent: [0, 229, 255], belly: [60, 60, 140],
    eye: [255, 220, 40],
    headRadius: 18, bodyRx: 22, bodyRy: 18, legLength: 12, clawSize: 1.1,
    antennaLength: 1.0, hasShellOnBack: false, hasBioluminescence: true,
    hasRainbowBands: false, hasBubbles: false, hasHeavyArmor: false,
    walkStyle: "stomp",
  },
  {
    name: "fox", label: "Spiny Lobster",
    body: [255, 140, 50], accent: [255, 230, 200], belly: [255, 220, 180],
    eye: [40, 40, 40],
    headRadius: 16, bodyRx: 18, bodyRy: 15, legLength: 13, clawSize: 0.9,
    antennaLength: 1.8, hasShellOnBack: false, hasBioluminescence: false,
    hasRainbowBands: false, hasBubbles: false, hasHeavyArmor: false,
    walkStyle: "scuttle",
  },
  {
    name: "owl", label: "Hermit Lobster",
    body: [160, 120, 80], accent: [210, 190, 150], belly: [200, 180, 150],
    eye: [255, 200, 40],
    headRadius: 15, bodyRx: 20, bodyRy: 18, legLength: 10, clawSize: 0.9,
    antennaLength: 0.8, hasShellOnBack: true, hasBioluminescence: false,
    hasRainbowBands: false, hasBubbles: false, hasHeavyArmor: false,
    walkStyle: "waddle",
  },
  {
    name: "wolf", label: "Crusher Lobster",
    body: [140, 30, 30], accent: [160, 160, 170], belly: [180, 80, 80],
    eye: [100, 180, 255],
    headRadius: 17, bodyRx: 22, bodyRy: 18, legLength: 12, clawSize: 1.5,
    antennaLength: 0.9, hasShellOnBack: false, hasBioluminescence: false,
    hasRainbowBands: false, hasBubbles: false, hasHeavyArmor: false,
    walkStyle: "stomp",
  },
  {
    name: "bunny", label: "Bubble Lobster",
    body: [255, 180, 200], accent: [255, 210, 220], belly: [255, 240, 245],
    eye: [180, 60, 100],
    headRadius: 16, bodyRx: 18, bodyRy: 16, legLength: 11, clawSize: 0.8,
    antennaLength: 1.0, hasShellOnBack: false, hasBioluminescence: false,
    hasRainbowBands: false, hasBubbles: true, hasHeavyArmor: false,
    walkStyle: "hop",
  },
  {
    name: "phoenix", label: "Mantis Lobster",
    body: [40, 200, 80], accent: [255, 200, 40], belly: [100, 240, 130],
    eye: [200, 255, 100],
    headRadius: 16, bodyRx: 18, bodyRy: 16, legLength: 13, clawSize: 1.1,
    antennaLength: 1.0, hasShellOnBack: false, hasBioluminescence: false,
    hasRainbowBands: true, hasBubbles: false, hasHeavyArmor: false,
    walkStyle: "glide",
  },
  {
    name: "turtle", label: "Iron Lobster",
    body: [80, 90, 100], accent: [50, 55, 65], belly: [100, 110, 120],
    eye: [40, 40, 40],
    headRadius: 15, bodyRx: 24, bodyRy: 18, legLength: 10, clawSize: 1.2,
    antennaLength: 0.7, hasShellOnBack: false, hasBioluminescence: false,
    hasRainbowBands: false, hasBubbles: false, hasHeavyArmor: true,
    walkStyle: "waddle",
  },
];

// ═══════════════════════════════════════════════════════════════
// Drawing Primitives — Anti-aliased
// ═══════════════════════════════════════════════════════════════

function createBuffer(): Buffer {
  return Buffer.alloc(SHEET_W * SHEET_H * 4, 0);
}

function setPixel(buf: Buffer, x: number, y: number, r: number, g: number, b: number, a = 255) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || ix >= SHEET_W || iy < 0 || iy >= SHEET_H) return;
  const i = (iy * SHEET_W + ix) * 4;
  // Alpha blending
  const existingA = buf[i + 3];
  if (existingA === 0 || a >= 255) {
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = Math.min(255, a);
  } else {
    const srcA = a / 255;
    const dstA = existingA / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA > 0) {
      buf[i] = Math.round((r * srcA + buf[i] * dstA * (1 - srcA)) / outA);
      buf[i + 1] = Math.round((g * srcA + buf[i + 1] * dstA * (1 - srcA)) / outA);
      buf[i + 2] = Math.round((b * srcA + buf[i + 2] * dstA * (1 - srcA)) / outA);
      buf[i + 3] = Math.round(outA * 255);
    }
  }
}

function fillRect(buf: Buffer, x: number, y: number, w: number, h: number, r: number, g: number, b: number, a = 255) {
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      setPixel(buf, x + dx, y + dy, r, g, b, a);
}

/** Anti-aliased filled ellipse */
function fillEllipseAA(buf: Buffer, cx: number, cy: number, rx: number, ry: number, r: number, g: number, b: number, a = 255) {
  if (rx <= 0 || ry <= 0) return;
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  for (let dy = -ry - 1; dy <= ry + 1; dy++) {
    for (let dx = -rx - 1; dx <= rx + 1; dx++) {
      const dist = (dx * dx) / rx2 + (dy * dy) / ry2;
      if (dist <= 1.0) {
        setPixel(buf, cx + dx, cy + dy, r, g, b, a);
      } else if (dist < 1.15) {
        // Anti-alias edge
        const edgeA = Math.round((1 - (dist - 1) / 0.15) * a);
        if (edgeA > 0) setPixel(buf, cx + dx, cy + dy, r, g, b, edgeA);
      }
    }
  }
}

/** Anti-aliased filled circle */
function fillCircleAA(buf: Buffer, cx: number, cy: number, radius: number, r: number, g: number, b: number, a = 255) {
  fillEllipseAA(buf, cx, cy, radius, radius, r, g, b, a);
}

/** Shaded ellipse — highlight on top-left, shadow on bottom-right */
function fillShadedEllipse(buf: Buffer, cx: number, cy: number, rx: number, ry: number, colors: ColorSet, a = 255) {
  if (rx <= 0 || ry <= 0) return;
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  for (let dy = -ry - 1; dy <= ry + 1; dy++) {
    for (let dx = -rx - 1; dx <= rx + 1; dx++) {
      const dist = (dx * dx) / rx2 + (dy * dy) / ry2;
      if (dist > 1.15) continue;
      // Shading: top-left = highlight, bottom-right = shadow
      const shade = (dx / rx + dy / ry) * 0.5; // -1..1
      let c: RGB;
      if (shade < -0.2) c = lerpColor(colors.base, colors.highlight, Math.min(1, (-shade - 0.2) * 1.5));
      else if (shade > 0.2) c = lerpColor(colors.base, colors.shadow, Math.min(1, (shade - 0.2) * 1.5));
      else c = colors.base;

      if (dist <= 1.0) {
        setPixel(buf, cx + dx, cy + dy, c[0], c[1], c[2], a);
      } else {
        const edgeA = Math.round((1 - (dist - 1) / 0.15) * a);
        if (edgeA > 0) setPixel(buf, cx + dx, cy + dy, c[0], c[1], c[2], edgeA);
      }
    }
  }
}

/** Shaded circle */
function fillShadedCircle(buf: Buffer, cx: number, cy: number, r: number, colors: ColorSet, a = 255) {
  fillShadedEllipse(buf, cx, cy, r, r, colors, a);
}

/** Filled triangle */
function fillTriangle(buf: Buffer, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, r: number, g: number, b: number, a = 255) {
  const minX = Math.floor(Math.min(x1, x2, x3));
  const maxX = Math.ceil(Math.max(x1, x2, x3));
  const minY = Math.floor(Math.min(y1, y2, y3));
  const maxY = Math.ceil(Math.max(y1, y2, y3));
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
      if (d === 0) continue;
      const a1 = ((y2 - y3) * (px - x3) + (x3 - x2) * (py - y3)) / d;
      const b1 = ((y3 - y1) * (px - x3) + (x1 - x3) * (py - y3)) / d;
      const c1 = 1 - a1 - b1;
      if (a1 >= -0.01 && b1 >= -0.01 && c1 >= -0.01) {
        setPixel(buf, px, py, r, g, b, a);
      }
    }
  }
}

/** Draw a thick line */
function drawLine(buf: Buffer, x1: number, y1: number, x2: number, y2: number, thickness: number, r: number, g: number, b: number, a = 255) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.5) return;
  const steps = Math.ceil(len * 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x1 + dx * t;
    const y = y1 + dy * t;
    fillCircleAA(buf, x, y, thickness / 2, r, g, b, a);
  }
}

// ═══════════════════════════════════════════════════════════════
// Body Part Drawing — Lobster Morphology
// ═══════════════════════════════════════════════════════════════

interface BodyPose {
  bodyOffY: number;      // body vertical offset (bob)
  headOffY: number;      // head vertical offset
  headTilt: number;      // head rotation (radians, for future)
  leftLegOff: number;    // left legs wave offset
  rightLegOff: number;   // right legs wave offset
  leftClawOff: number;   // left claw swing
  rightClawOff: number;  // right claw swing
  tailPhase: number;     // tail curl animation phase 0-1
  antennaBounce: number; // antenna bounce offset
  clawOpenPhase: number; // 0 = closed, 1 = fully open
  squashX: number;       // body squash X (1 = normal)
  squashY: number;       // body squash Y (1 = normal)
}

const NEUTRAL_POSE: BodyPose = {
  bodyOffY: 0, headOffY: 0, headTilt: 0,
  leftLegOff: 0, rightLegOff: 0, leftClawOff: 0, rightClawOff: 0,
  tailPhase: 0, antennaBounce: 0, clawOpenPhase: 0.3, squashX: 1, squashY: 1,
};

function getWalkPose(frame: number, sp: SpeciesDef): BodyPose {
  const t = (frame / 8) * Math.PI * 2; // full cycle over 8 frames
  const pose = { ...NEUTRAL_POSE };

  switch (sp.walkStyle) {
    case "hop":
      // Bubble lobster: tail-powered bouncy movement
      pose.bodyOffY = -Math.abs(Math.sin(t)) * 8;
      pose.headOffY = pose.bodyOffY - Math.abs(Math.sin(t)) * 2;
      pose.leftLegOff = Math.sin(t) * 3;
      pose.rightLegOff = Math.sin(t) * 3;
      pose.squashY = 1 + Math.sin(t) * 0.08;
      pose.squashX = 1 - Math.sin(t) * 0.04;
      pose.antennaBounce = Math.sin(t + 0.5) * 4;
      pose.tailPhase = Math.sin(t) * 0.5 + 0.5;
      pose.leftClawOff = Math.sin(t) * 3;
      pose.rightClawOff = Math.sin(t) * 3;
      break;
    case "waddle":
      // Hermit/Iron: slow with shell weight, side-to-side
      pose.bodyOffY = -Math.abs(Math.sin(t * 2)) * 2;
      pose.headOffY = pose.bodyOffY;
      pose.leftLegOff = Math.sin(t) * 4;
      pose.rightLegOff = -Math.sin(t) * 4;
      pose.squashX = 1 + Math.sin(t) * 0.03;
      pose.leftClawOff = Math.sin(t) * 2;
      pose.rightClawOff = -Math.sin(t) * 2;
      break;
    case "stomp":
      // Crusher/Abyssal: heavy deliberate steps, claws swing
      pose.bodyOffY = -Math.abs(Math.sin(t)) * 3;
      pose.headOffY = pose.bodyOffY + 1;
      pose.leftLegOff = Math.sin(t) * 6;
      pose.rightLegOff = -Math.sin(t) * 6;
      pose.leftClawOff = -Math.sin(t) * 5;
      pose.rightClawOff = Math.sin(t) * 5;
      pose.squashY = 1 + Math.abs(Math.sin(t)) * 0.04;
      pose.clawOpenPhase = 0.3 + Math.abs(Math.sin(t)) * 0.2;
      break;
    case "glide":
      // Mantis: smooth swimming motion, legs trail
      pose.bodyOffY = Math.sin(t) * 4;
      pose.headOffY = pose.bodyOffY;
      pose.leftLegOff = Math.sin(t) * 2;
      pose.rightLegOff = -Math.sin(t) * 2;
      pose.leftClawOff = Math.sin(t + 0.5) * 3;
      pose.rightClawOff = -Math.sin(t + 0.5) * 3;
      pose.antennaBounce = Math.sin(t * 0.5) * 2;
      break;
    default:
      // Scuttle (default): side-to-side movement, legs alternate wave
      pose.bodyOffY = -Math.abs(Math.sin(t)) * 4;
      pose.headOffY = pose.bodyOffY - 1;
      pose.leftLegOff = Math.sin(t) * 6;
      pose.rightLegOff = -Math.sin(t) * 6;
      pose.leftClawOff = -Math.sin(t) * 4;
      pose.rightClawOff = Math.sin(t) * 4;
      pose.tailPhase = Math.sin(t * 0.7) * 0.5 + 0.5;
      pose.antennaBounce = Math.sin(t + 1) * 2;
      pose.squashY = 1 + Math.abs(Math.sin(t)) * 0.03;
      pose.squashX = 1 - Math.abs(Math.sin(t)) * 0.015;
      break;
  }

  pose.tailPhase = Math.sin(t * 0.7) * 0.5 + 0.5;
  return pose;
}

function getIdlePose(frame: number, sp: SpeciesDef): BodyPose {
  const t = (frame / 8) * Math.PI * 2;
  const pose = { ...NEUTRAL_POSE };
  // Gentle breathing / slight sway
  pose.bodyOffY = Math.sin(t) * 1.5;
  pose.headOffY = Math.sin(t + 0.3) * 1;
  pose.squashY = 1 + Math.sin(t) * 0.02;
  pose.squashX = 1 - Math.sin(t) * 0.01;
  pose.tailPhase = Math.sin(t * 0.5) * 0.5 + 0.5;
  pose.antennaBounce = Math.sin(t * 0.3) * 1;
  pose.clawOpenPhase = 0.2 + Math.sin(t * 0.5) * 0.1;
  // Claws gently sway
  pose.leftClawOff = Math.sin(t * 0.4) * 1;
  pose.rightClawOff = -Math.sin(t * 0.4) * 1;
  return pose;
}

// ═══════════════════════════════════════════════════════════════
// Lobster Drawing Functions
// ═══════════════════════════════════════════════════════════════

function drawLobster(
  buf: Buffer,
  fx: number, fy: number,
  sp: SpeciesDef,
  facing: "front" | "back" | "left" | "right",
  pose: BodyPose,
  eyeState: "open" | "closed" | "x" | "squint" = "open",
) {
  const cx = fx + 64; // center of 128x128 frame
  const bodyCy = fy + 72 + pose.bodyOffY;
  const headCy = bodyCy - sp.bodyRy - sp.headRadius * 0.5 + pose.headOffY;

  const bodyColors = makeColorSet(sp.body);
  const accentColors = makeColorSet(sp.accent);
  const bellyColors = makeColorSet(sp.belly);
  const outlineC = bodyColors.outline;

  const bRx = Math.round(sp.bodyRx * pose.squashX);
  const bRy = Math.round(sp.bodyRy * pose.squashY);

  // --- Shadow on ground ---
  fillEllipseAA(buf, cx, fy + 110, bRx + 6, 4, 0, 0, 0, 40);

  // --- Lobster tail (behind body) ---
  if (facing === "front" || facing === "back" || facing === "left") {
    drawLobsterTail(buf, cx, bodyCy, sp, pose, facing);
  }

  // --- Walking legs (behind body for certain facings) ---
  drawWalkingLegs(buf, cx, bodyCy + bRy - 6, sp, pose, facing);

  // --- Shell on back (hermit lobster - behind body) ---
  if (sp.hasShellOnBack && facing !== "front") {
    drawHermitShell(buf, cx, bodyCy, sp, facing);
  }

  // --- Body: Segmented carapace ---
  drawShellSegments(buf, cx, bodyCy, bRx, bRy, sp, bodyColors, accentColors, outlineC, facing);

  // --- Heavy armor overlay (Iron Lobster) ---
  if (sp.hasHeavyArmor) {
    drawHeavyArmor(buf, cx, bodyCy, bRx, bRy, sp);
  }

  // --- Rainbow bands (Mantis Lobster) ---
  if (sp.hasRainbowBands) {
    drawRainbowBands(buf, cx, bodyCy, bRx, bRy);
  }

  // --- Bioluminescent spots (Abyssal Lobster) ---
  if (sp.hasBioluminescence) {
    drawBioluminescence(buf, cx, bodyCy, bRx, bRy, sp, pose);
  }

  // --- Belly (ventral side) ---
  if (facing === "front") {
    fillShadedEllipse(buf, cx, bodyCy + 4, Math.round(bRx * 0.55), Math.round(bRy * 0.6), bellyColors);
  } else if (facing === "left" || facing === "right") {
    const bellyOff = facing === "left" ? -3 : 3;
    fillShadedEllipse(buf, cx + bellyOff, bodyCy + 4, Math.round(bRx * 0.45), Math.round(bRy * 0.55), bellyColors);
  }

  // --- Claws ---
  drawClaws(buf, cx, bodyCy - 4, sp, pose, facing);

  // --- Shell on back (hermit lobster - in front for front-facing) ---
  if (sp.hasShellOnBack && facing === "front") {
    drawHermitShell(buf, cx, bodyCy, sp, facing);
  }

  // --- Head ---
  const hr = sp.headRadius;
  // Outline
  fillShadedCircle(buf, cx, headCy, hr + 1, { ...bodyColors, base: outlineC, highlight: outlineC, shadow: darken(outlineC, 0.3) });
  // Fill
  fillShadedCircle(buf, cx, headCy, hr, bodyColors);

  // --- Eye stalks ---
  drawEyeStalks(buf, cx, headCy, sp, pose, facing, eyeState);

  // --- Antennae ---
  drawAntennae(buf, cx, headCy, sp, pose, facing);

  // --- Face (mouth parts) ---
  if (facing !== "back") {
    drawFace(buf, cx, headCy, sp, facing, eyeState);
  }

  // --- Tail (in front for right facing) ---
  if (facing === "right") {
    drawLobsterTail(buf, cx, bodyCy, sp, pose, facing);
  }

  // --- Bubbles (Bubble Lobster) ---
  if (sp.hasBubbles) {
    drawBubbles(buf, cx, headCy, sp, pose);
  }
}

// --- Shell Segments (Lobster Carapace) ---

function drawShellSegments(
  buf: Buffer, cx: number, cy: number,
  bRx: number, bRy: number,
  sp: SpeciesDef,
  bodyColors: ColorSet, accentColors: ColorSet, outlineC: RGB,
  facing: string,
) {
  const segmentCount = 4;
  const segHeight = (bRy * 2) / segmentCount;

  for (let i = 0; i < segmentCount; i++) {
    const segCy = cy - bRy + segHeight * i + segHeight / 2;
    const segRx = bRx - i * 0.5; // slight taper toward tail
    const segRy = segHeight / 2 + 1; // slight overlap

    // Outline
    fillShadedEllipse(buf, cx, segCy, segRx + 1, segRy + 1,
      { ...bodyColors, base: outlineC, highlight: outlineC, shadow: darken(outlineC, 0.3) });
    // Fill
    fillShadedEllipse(buf, cx, segCy, segRx, segRy, bodyColors);

    // Segment line highlight at top of each segment
    if (i > 0) {
      const lineY = segCy - segRy + 1;
      for (let dx = -Math.round(segRx * 0.7); dx <= Math.round(segRx * 0.7); dx++) {
        const edgeDist = Math.abs(dx) / (segRx * 0.7);
        const alpha = Math.round(60 * (1 - edgeDist));
        if (alpha > 0) {
          setPixel(buf, cx + dx, lineY, ...bodyColors.highlight, alpha);
        }
      }
    }
  }
}

// --- Heavy Armor (Iron Lobster) ---

function drawHeavyArmor(buf: Buffer, cx: number, cy: number, bRx: number, bRy: number, sp: SpeciesDef) {
  const armorColors = makeColorSet([100, 110, 125] as RGB);
  // Metallic highlight ridges along the top of each segment
  for (let i = 0; i < 3; i++) {
    const ridgeY = cy - bRy + 4 + i * Math.round(bRy * 2 / 3);
    const ridgeRx = Math.round(bRx * (0.9 - i * 0.05));
    // Ridge line
    for (let dx = -ridgeRx; dx <= ridgeRx; dx++) {
      const edgeDist = Math.abs(dx) / ridgeRx;
      const alpha = Math.round(80 * (1 - edgeDist * edgeDist));
      if (alpha > 0) {
        setPixel(buf, cx + dx, ridgeY, 180, 190, 200, alpha);
        setPixel(buf, cx + dx, ridgeY + 1, 140, 150, 165, Math.round(alpha * 0.6));
      }
    }
  }
  // Plate bolts (decorative dots)
  for (let side = -1; side <= 1; side += 2) {
    for (let j = 0; j < 2; j++) {
      const bx = cx + side * Math.round(bRx * 0.6);
      const by = cy - bRy * 0.3 + j * Math.round(bRy * 0.8);
      fillCircleAA(buf, bx, by, 2, 160, 170, 180);
      setPixel(buf, bx - 1, by - 1, 200, 210, 220); // highlight dot
    }
  }
}

// --- Rainbow Bands (Mantis Lobster) ---

function drawRainbowBands(buf: Buffer, cx: number, cy: number, bRx: number, bRy: number) {
  const rainbowColors: RGB[] = [
    [255, 60, 60],    // red
    [255, 160, 40],   // orange
    [255, 255, 60],   // yellow
    [60, 220, 60],    // green
    [60, 160, 255],   // blue
    [160, 80, 255],   // purple
  ];

  for (let i = 0; i < rainbowColors.length; i++) {
    const bandY = cy - bRy + 4 + i * Math.round((bRy * 2) / (rainbowColors.length + 1));
    const bandRx = Math.round(bRx * (0.85 - i * 0.02));
    const col = rainbowColors[i];
    for (let dx = -bandRx; dx <= bandRx; dx++) {
      const edgeDist = Math.abs(dx) / bandRx;
      const alpha = Math.round(70 * (1 - edgeDist));
      if (alpha > 0) {
        setPixel(buf, cx + dx, bandY, ...col, alpha);
        setPixel(buf, cx + dx, bandY + 1, ...col, Math.round(alpha * 0.5));
      }
    }
  }
}

// --- Bioluminescence (Abyssal Lobster) ---

function drawBioluminescence(buf: Buffer, cx: number, cy: number, bRx: number, bRy: number, sp: SpeciesDef, pose: BodyPose) {
  const glowColor = sp.accent;
  // Glowing spots along body
  const spotPositions = [
    { dx: -bRx * 0.4, dy: -bRy * 0.3, r: 3 },
    { dx: bRx * 0.3, dy: -bRy * 0.1, r: 2.5 },
    { dx: -bRx * 0.2, dy: bRy * 0.3, r: 2 },
    { dx: bRx * 0.5, dy: bRy * 0.2, r: 3 },
    { dx: 0, dy: -bRy * 0.5, r: 2 },
    { dx: -bRx * 0.5, dy: bRy * 0.1, r: 2.5 },
  ];

  // Pulsing glow based on animation phase
  const pulse = 0.6 + Math.sin(pose.tailPhase * Math.PI * 2) * 0.4;

  for (const spot of spotPositions) {
    const sx = cx + spot.dx;
    const sy = cy + spot.dy;
    const glowR = spot.r + 3;
    // Outer glow
    fillCircleAA(buf, sx, sy, glowR, ...glowColor, Math.round(40 * pulse));
    // Inner bright spot
    fillCircleAA(buf, sx, sy, spot.r, ...glowColor, Math.round(160 * pulse));
    // Center white core
    fillCircleAA(buf, sx, sy, spot.r * 0.4, 255, 255, 255, Math.round(120 * pulse));
  }
}

// --- Hermit Shell (on back) ---

function drawHermitShell(buf: Buffer, cx: number, cy: number, sp: SpeciesDef, facing: string) {
  const shellColors = makeColorSet([180, 150, 110] as RGB);
  const shellHighlight = makeColorSet([210, 190, 150] as RGB);
  const shellOff = facing === "back" ? 0 : (facing === "left" ? 5 : facing === "right" ? -5 : 0);

  // Main shell spiral
  const shellX = cx + shellOff;
  const shellY = cy - 4;
  const shellRx = Math.round(sp.bodyRx * 0.85);
  const shellRy = Math.round(sp.bodyRy * 0.95);

  // Outer shell
  fillShadedEllipse(buf, shellX, shellY, shellRx + 2, shellRy + 2, shellColors);
  // Inner lighter area
  fillShadedEllipse(buf, shellX - 2, shellY - 2, Math.round(shellRx * 0.6), Math.round(shellRy * 0.6), shellHighlight);

  // Spiral lines
  for (let angle = 0; angle < Math.PI * 3; angle += 0.15) {
    const r = 3 + angle * 2.5;
    if (r > shellRx * 0.8) break;
    const px = shellX + Math.cos(angle) * r * 0.8;
    const py = shellY + Math.sin(angle) * r * 0.6;
    const dist = Math.sqrt((px - shellX) * (px - shellX) / (shellRx * shellRx) + (py - shellY) * (py - shellY) / (shellRy * shellRy));
    if (dist < 0.9) {
      setPixel(buf, px, py, ...shellColors.shadow, 100);
    }
  }
}

// --- Lobster Tail (segmented fan) ---

function drawLobsterTail(buf: Buffer, cx: number, bodyCy: number, sp: SpeciesDef, pose: BodyPose, facing: string) {
  const tailColors = makeColorSet(sp.body);
  const accentC = makeColorSet(sp.accent);
  const tailCurl = Math.sin(pose.tailPhase * Math.PI * 2) * 4;
  const segmentCount = 5;

  let tx: number, ty: number, dirX: number, dirY: number;
  if (facing === "right") {
    tx = cx - sp.bodyRx - 2; ty = bodyCy + 2; dirX = -1; dirY = 0.3;
  } else if (facing === "left") {
    tx = cx + sp.bodyRx + 2; ty = bodyCy + 2; dirX = 1; dirY = 0.3;
  } else if (facing === "back") {
    tx = cx; ty = bodyCy + sp.bodyRy + 2; dirX = 0; dirY = 1;
  } else {
    tx = cx + tailCurl * 0.3; ty = bodyCy + sp.bodyRy + 2; dirX = 0; dirY = 1;
  }

  // Draw segments from body outward, decreasing in size
  for (let i = 0; i < segmentCount; i++) {
    const segScale = 1 - i * 0.15;
    const segRx = Math.round(sp.bodyRx * 0.4 * segScale);
    const segRy = Math.round(4 * segScale + 2);
    const segX = tx + dirX * i * 7 + tailCurl * (i / segmentCount) * dirX * 0.3;
    const segY = ty + dirY * i * 7 + tailCurl * (i / segmentCount);

    // Swap rx/ry for side-facing tail (horizontal segments)
    if (facing === "left" || facing === "right") {
      // Outline
      fillShadedEllipse(buf, segX, segY, segRy + 1, segRx + 1,
        { ...tailColors, base: tailColors.outline, highlight: tailColors.outline, shadow: darken(tailColors.outline, 0.3) });
      fillShadedEllipse(buf, segX, segY, segRy, segRx, tailColors);
    } else {
      // Outline
      fillShadedEllipse(buf, segX, segY, segRx + 1, segRy + 1,
        { ...tailColors, base: tailColors.outline, highlight: tailColors.outline, shadow: darken(tailColors.outline, 0.3) });
      fillShadedEllipse(buf, segX, segY, segRx, segRy, tailColors);
    }
  }

  // Tail fan at end
  const fanX = tx + dirX * segmentCount * 7 + tailCurl * dirX * 0.3;
  const fanY = ty + dirY * segmentCount * 7 + tailCurl;

  if (facing === "left" || facing === "right") {
    // Fan spreads vertically for side view
    const fanSpread = 8;
    fillTriangle(buf,
      fanX + dirX * 3, fanY - fanSpread,
      fanX + dirX * 12, fanY,
      fanX + dirX * 3, fanY + fanSpread,
      ...tailColors.base);
    // Center fan piece
    fillTriangle(buf,
      fanX + dirX * 2, fanY - fanSpread * 0.5,
      fanX + dirX * 14, fanY,
      fanX + dirX * 2, fanY + fanSpread * 0.5,
      ...accentC.base, 180);
    // Outer fan pieces
    fillTriangle(buf,
      fanX + dirX * 4, fanY - fanSpread - 2,
      fanX + dirX * 10, fanY - fanSpread + 2,
      fanX + dirX * 4, fanY - fanSpread + 4,
      ...tailColors.shadow);
    fillTriangle(buf,
      fanX + dirX * 4, fanY + fanSpread + 2,
      fanX + dirX * 10, fanY + fanSpread - 2,
      fanX + dirX * 4, fanY + fanSpread - 4,
      ...tailColors.shadow);
  } else {
    // Fan spreads horizontally for front/back view
    const fanSpread = 10;
    fillTriangle(buf,
      fanX - fanSpread, fanY + dirY * 3,
      fanX, fanY + dirY * 12,
      fanX + fanSpread, fanY + dirY * 3,
      ...tailColors.base);
    // Center piece
    fillTriangle(buf,
      fanX - fanSpread * 0.5, fanY + dirY * 2,
      fanX, fanY + dirY * 14,
      fanX + fanSpread * 0.5, fanY + dirY * 2,
      ...accentC.base, 180);
    // Outer pieces
    fillTriangle(buf,
      fanX - fanSpread - 3, fanY + dirY * 4,
      fanX - fanSpread + 3, fanY + dirY * 10,
      fanX - fanSpread + 5, fanY + dirY * 4,
      ...tailColors.shadow);
    fillTriangle(buf,
      fanX + fanSpread + 3, fanY + dirY * 4,
      fanX + fanSpread - 3, fanY + dirY * 10,
      fanX + fanSpread - 5, fanY + dirY * 4,
      ...tailColors.shadow);
  }
}

// --- Walking Legs (8 legs, 4 per side) ---

function drawWalkingLegs(buf: Buffer, cx: number, legTopY: number, sp: SpeciesDef, pose: BodyPose, facing: string) {
  const outC = makeColorSet(sp.body).outline;
  const legC = makeColorSet(sp.body);
  const legH = sp.legLength;
  const legCount = 4; // per side

  if (facing === "front" || facing === "back") {
    for (let i = 0; i < legCount; i++) {
      const spacing = Math.round(sp.bodyRx * (0.3 + i * 0.2));
      const phase = i * 0.7; // wave pattern offset
      const legWave = Math.sin(pose.leftLegOff * 0.2 + phase) * 3;

      // Left side legs
      const lx = cx - spacing;
      const ly = legTopY + Math.abs(legWave) * 0.3 - i * 1;
      // Upper segment
      drawLine(buf, lx, ly, lx - 4 - i * 1.5, ly + legH * 0.5, 2, ...legC.base);
      // Lower segment (foot)
      drawLine(buf, lx - 4 - i * 1.5, ly + legH * 0.5, lx - 6 - i * 2 + legWave, ly + legH, 1.5, ...legC.shadow);
      // Foot dot
      fillCircleAA(buf, lx - 6 - i * 2 + legWave, ly + legH, 1.5, ...outC);

      // Right side legs
      const rx = cx + spacing;
      const ry = legTopY + Math.abs(-legWave) * 0.3 - i * 1;
      drawLine(buf, rx, ry, rx + 4 + i * 1.5, ry + legH * 0.5, 2, ...legC.base);
      drawLine(buf, rx + 4 + i * 1.5, ry + legH * 0.5, rx + 6 + i * 2 - legWave, ry + legH, 1.5, ...legC.shadow);
      fillCircleAA(buf, rx + 6 + i * 2 - legWave, ry + legH, 1.5, ...outC);
    }
  } else {
    // Side view — show all legs on visible side
    const dir = facing === "left" ? -1 : 1;
    for (let i = 0; i < legCount; i++) {
      const baseX = cx + dir * Math.round(sp.bodyRx * (0.1 + i * 0.15));
      const phase = i * 0.7;
      const legWave = Math.sin(pose.leftLegOff * 0.2 + phase) * 4;
      const ly = legTopY - i * 2;

      // Far side legs (darker, behind body)
      const farBaseX = cx - dir * Math.round(sp.bodyRx * (0.05 + i * 0.1));
      drawLine(buf, farBaseX, ly, farBaseX - dir * 3, ly + legH * 0.5, 1.5, ...legC.shadow);
      drawLine(buf, farBaseX - dir * 3, ly + legH * 0.5, farBaseX - dir * 4 + legWave * 0.5, ly + legH - 1, 1, ...darken(legC.shadow, 0.2));

      // Near side legs (brighter, in front)
      drawLine(buf, baseX, ly, baseX + dir * 5, ly + legH * 0.5, 2, ...legC.base);
      drawLine(buf, baseX + dir * 5, ly + legH * 0.5, baseX + dir * 7 + legWave, ly + legH, 1.5, ...legC.shadow);
      fillCircleAA(buf, baseX + dir * 7 + legWave, ly + legH, 1.5, ...outC);
    }
  }
}

// --- Claws (Pincers) ---

function drawClaws(buf: Buffer, cx: number, clawTopY: number, sp: SpeciesDef, pose: BodyPose, facing: string) {
  const clawC = makeColorSet(sp.body);
  const accentC = makeColorSet(sp.accent);
  const clawScale = sp.clawSize;
  const openPhase = pose.clawOpenPhase;

  if (facing === "front") {
    // Both claws visible
    drawSingleClaw(buf, cx - sp.bodyRx - 4, clawTopY + pose.leftClawOff, -1, clawScale, openPhase, clawC, accentC, sp);
    drawSingleClaw(buf, cx + sp.bodyRx + 4, clawTopY + pose.rightClawOff, 1, clawScale, openPhase, clawC, accentC, sp);
  } else if (facing === "back") {
    // Both claws behind, slightly visible at sides
    drawSingleClaw(buf, cx - sp.bodyRx - 2, clawTopY + pose.leftClawOff, -1, clawScale * 0.7, openPhase, clawC, accentC, sp);
    drawSingleClaw(buf, cx + sp.bodyRx + 2, clawTopY + pose.rightClawOff, 1, clawScale * 0.7, openPhase, clawC, accentC, sp);
  } else if (facing === "left") {
    // Left claw prominent in front, right claw behind
    drawSingleClaw(buf, cx + 6, clawTopY + pose.rightClawOff, -1, clawScale * 0.6, openPhase, clawC, accentC, sp);
    drawSingleClaw(buf, cx - 8, clawTopY + pose.leftClawOff, -1, clawScale, openPhase, clawC, accentC, sp);
  } else {
    // Right claw prominent
    drawSingleClaw(buf, cx - 6, clawTopY + pose.leftClawOff, 1, clawScale * 0.6, openPhase, clawC, accentC, sp);
    drawSingleClaw(buf, cx + 8, clawTopY + pose.rightClawOff, 1, clawScale, openPhase, clawC, accentC, sp);
  }
}

function drawSingleClaw(
  buf: Buffer, x: number, y: number, dir: number, scale: number,
  openPhase: number, clawC: ColorSet, accentC: ColorSet, sp: SpeciesDef,
) {
  const armLen = 12 * scale;
  const clawLen = 10 * scale;
  const clawWidth = 5 * scale;

  // Arm segment (from body to claw joint)
  const jointX = x + dir * armLen;
  const jointY = y - 2;
  drawLine(buf, x, y, jointX, jointY, 3 * scale, ...clawC.base);
  // Joint circle
  fillShadedCircle(buf, jointX, jointY, 3 * scale, clawC);

  // Pincer — two triangles forming a claw shape
  const openAngle = openPhase * 0.4; // 0 = closed, 0.4 rad = open

  // Upper pincer jaw
  const upperTipX = jointX + dir * clawLen;
  const upperTipY = jointY - clawWidth - openAngle * 8;
  fillTriangle(buf,
    jointX, jointY - 1,
    upperTipX, upperTipY,
    jointX + dir * clawLen * 0.3, jointY - clawWidth * 0.3,
    ...clawC.base);
  // Upper jaw inner edge (darker)
  fillTriangle(buf,
    jointX + dir * 2, jointY,
    upperTipX - dir * 1, upperTipY + 1,
    jointX + dir * clawLen * 0.3, jointY - clawWidth * 0.2,
    ...clawC.shadow, 120);

  // Lower pincer jaw
  const lowerTipX = jointX + dir * clawLen;
  const lowerTipY = jointY + clawWidth + openAngle * 8;
  fillTriangle(buf,
    jointX, jointY + 1,
    lowerTipX, lowerTipY,
    jointX + dir * clawLen * 0.3, jointY + clawWidth * 0.3,
    ...clawC.base);
  // Lower jaw inner edge
  fillTriangle(buf,
    jointX + dir * 2, jointY,
    lowerTipX - dir * 1, lowerTipY - 1,
    jointX + dir * clawLen * 0.3, jointY + clawWidth * 0.2,
    ...clawC.shadow, 120);

  // Claw tip highlights
  setPixel(buf, upperTipX, upperTipY, ...accentC.highlight);
  setPixel(buf, lowerTipX, lowerTipY, ...accentC.highlight);

  // Serrated inner edge (teeth) when open
  if (openPhase > 0.2) {
    const teethCount = Math.round(3 * scale);
    for (let t = 0; t < teethCount; t++) {
      const tt = (t + 0.5) / teethCount;
      // Upper teeth
      const utx = jointX + dir * clawLen * tt;
      const uty = jointY - 1 - openAngle * 4 * tt;
      setPixel(buf, utx, uty, 255, 255, 255, 160);
      // Lower teeth
      const ltx = jointX + dir * clawLen * tt;
      const lty = jointY + 1 + openAngle * 4 * tt;
      setPixel(buf, ltx, lty, 255, 255, 255, 160);
    }
  }
}

// --- Eye Stalks ---

function drawEyeStalks(
  buf: Buffer, cx: number, headCy: number,
  sp: SpeciesDef, pose: BodyPose,
  facing: string, eyeState: string,
) {
  const hr = sp.headRadius;
  const stalkLen = 8;
  const eyeOff = facing === "left" ? -3 : facing === "right" ? 3 : 0;
  const bounce = pose.antennaBounce * 0.3;

  // Retract on hurt
  const retract = eyeState === "squint" ? 3 : (eyeState === "x" ? 5 : 0);
  const actualStalkLen = stalkLen - retract;

  if (facing === "front" || facing === "back") {
    const eyeSpacing = Math.round(hr * 0.5);

    // Left stalk
    const lsx = cx - eyeSpacing + eyeOff;
    const lsy1 = headCy - hr + 2;
    const lsy2 = lsy1 - actualStalkLen + bounce;
    drawLine(buf, lsx, lsy1, lsx - 1, lsy2, 1.5, ...makeColorSet(sp.body).base);

    // Right stalk
    const rsx = cx + eyeSpacing + eyeOff;
    const rsy1 = headCy - hr + 2;
    const rsy2 = rsy1 - actualStalkLen - bounce * 0.5;
    drawLine(buf, rsx, rsy1, rsx + 1, rsy2, 1.5, ...makeColorSet(sp.body).base);

    if (facing === "front") {
      drawEyeball(buf, lsx - 1, lsy2, sp, eyeState, -1);
      drawEyeball(buf, rsx + 1, rsy2, sp, eyeState, 1);
    } else {
      // Back view — just the stalk tips
      fillCircleAA(buf, lsx - 1, lsy2, 2.5, ...makeColorSet(sp.body).shadow);
      fillCircleAA(buf, rsx + 1, rsy2, 2.5, ...makeColorSet(sp.body).shadow);
    }
  } else {
    // Side view — one eye prominent
    const dir = facing === "left" ? -1 : 1;
    const frontStalkX = cx + dir * Math.round(hr * 0.3) + eyeOff;
    const frontStalkY1 = headCy - hr + 2;
    const frontStalkY2 = frontStalkY1 - actualStalkLen + bounce;
    drawLine(buf, frontStalkX, frontStalkY1, frontStalkX + dir * 2, frontStalkY2, 1.5, ...makeColorSet(sp.body).base);
    drawEyeball(buf, frontStalkX + dir * 2, frontStalkY2, sp, eyeState, dir);

    // Back eye (partially visible)
    const backStalkX = cx - dir * Math.round(hr * 0.15) + eyeOff;
    const backStalkY2 = frontStalkY1 - actualStalkLen * 0.7 - bounce * 0.5;
    drawLine(buf, backStalkX, frontStalkY1, backStalkX - dir * 1, backStalkY2, 1, ...makeColorSet(sp.body).shadow);
    fillCircleAA(buf, backStalkX - dir * 1, backStalkY2, 2, ...makeColorSet(sp.body).shadow);
  }
}

function drawEyeball(buf: Buffer, ex: number, ey: number, sp: SpeciesDef, eyeState: string, dir: number) {
  if (eyeState === "open") {
    // White sclera
    fillCircleAA(buf, ex, ey, 3.5, 255, 255, 255);
    // Iris
    fillCircleAA(buf, ex + dir * 0.5, ey, 2, ...sp.eye);
    // Pupil
    setPixel(buf, ex + dir * 0.5, ey, 10, 10, 10);
    // Eye shine
    setPixel(buf, ex - 1, ey - 1, 255, 255, 255);
  } else if (eyeState === "closed") {
    fillCircleAA(buf, ex, ey, 3, ...makeColorSet(sp.body).base);
    drawLine(buf, ex - 2, ey, ex + 2, ey, 0.8, 40, 40, 40);
  } else if (eyeState === "x") {
    fillCircleAA(buf, ex, ey, 3, 255, 255, 255);
    for (let i = -2; i <= 2; i++) {
      setPixel(buf, ex + i, ey + i, 0, 0, 0);
      setPixel(buf, ex + i, ey - i, 0, 0, 0);
    }
  } else if (eyeState === "squint") {
    fillCircleAA(buf, ex, ey, 3, 255, 255, 255, 180);
    drawLine(buf, ex - 2, ey + 1, ex + 2, ey - 1, 0.8, 40, 40, 40);
  }
}

// --- Antennae ---

function drawAntennae(buf: Buffer, cx: number, headCy: number, sp: SpeciesDef, pose: BodyPose, facing: string) {
  const hr = sp.headRadius;
  const bounce = pose.antennaBounce;
  const antennaLen = Math.round(20 * sp.antennaLength);
  const bodyC = makeColorSet(sp.body);

  if (facing === "back") {
    // Antennae point away from camera
    const baseY = headCy - hr + 1;
    drawLine(buf, cx - 4, baseY, cx - 6, baseY - antennaLen * 0.4 + bounce, 1, ...bodyC.shadow);
    drawLine(buf, cx + 4, baseY, cx + 6, baseY - antennaLen * 0.4 - bounce * 0.5, 1, ...bodyC.shadow);
    return;
  }

  const baseY = headCy - hr;

  // Left antenna — curves outward and up
  const la1x = cx - hr * 0.5;
  const la2x = la1x - antennaLen * 0.4 + bounce * 0.5;
  const la2y = baseY - antennaLen * 0.7 + bounce;
  const la3x = la2x - antennaLen * 0.3;
  const la3y = la2y - antennaLen * 0.3 + bounce * 0.3;
  // Draw in segments for curve effect
  const laSteps = 12;
  for (let i = 0; i < laSteps; i++) {
    const t1 = i / laSteps;
    const t2 = (i + 1) / laSteps;
    // Quadratic bezier: base -> control -> tip
    const x1 = (1 - t1) * (1 - t1) * la1x + 2 * (1 - t1) * t1 * la2x + t1 * t1 * la3x;
    const y1 = (1 - t1) * (1 - t1) * baseY + 2 * (1 - t1) * t1 * la2y + t1 * t1 * la3y;
    const x2 = (1 - t2) * (1 - t2) * la1x + 2 * (1 - t2) * t2 * la2x + t2 * t2 * la3x;
    const y2 = (1 - t2) * (1 - t2) * baseY + 2 * (1 - t2) * t2 * la2y + t2 * t2 * la3y;
    const thickness = 1.5 * (1 - t1 * 0.6);
    drawLine(buf, x1, y1, x2, y2, thickness, ...bodyC.base);
  }

  // Right antenna
  const ra1x = cx + hr * 0.5;
  const ra2x = ra1x + antennaLen * 0.4 - bounce * 0.3;
  const ra2y = baseY - antennaLen * 0.7 - bounce * 0.5;
  const ra3x = ra2x + antennaLen * 0.3;
  const ra3y = ra2y - antennaLen * 0.3 - bounce * 0.2;
  for (let i = 0; i < laSteps; i++) {
    const t1 = i / laSteps;
    const t2 = (i + 1) / laSteps;
    const x1 = (1 - t1) * (1 - t1) * ra1x + 2 * (1 - t1) * t1 * ra2x + t1 * t1 * ra3x;
    const y1 = (1 - t1) * (1 - t1) * baseY + 2 * (1 - t1) * t1 * ra2y + t1 * t1 * ra3y;
    const x2 = (1 - t2) * (1 - t2) * ra1x + 2 * (1 - t2) * t2 * ra2x + t2 * t2 * ra3x;
    const y2 = (1 - t2) * (1 - t2) * baseY + 2 * (1 - t2) * t2 * ra2y + t2 * t2 * ra3y;
    const thickness = 1.5 * (1 - t1 * 0.6);
    drawLine(buf, x1, y1, x2, y2, thickness, ...bodyC.base);
  }

  // Fox/Spiny variant: add small spines along antennae
  if (sp.name === "fox") {
    for (let i = 2; i < laSteps - 1; i += 2) {
      const t = i / laSteps;
      const lx = (1 - t) * (1 - t) * la1x + 2 * (1 - t) * t * la2x + t * t * la3x;
      const ly = (1 - t) * (1 - t) * baseY + 2 * (1 - t) * t * la2y + t * t * la3y;
      setPixel(buf, lx - 1, ly - 1, ...bodyC.highlight);
      setPixel(buf, lx - 2, ly - 2, ...bodyC.highlight, 120);

      const rx = (1 - t) * (1 - t) * ra1x + 2 * (1 - t) * t * ra2x + t * t * ra3x;
      const ry = (1 - t) * (1 - t) * baseY + 2 * (1 - t) * t * ra2y + t * t * ra3y;
      setPixel(buf, rx + 1, ry - 1, ...bodyC.highlight);
      setPixel(buf, rx + 2, ry - 2, ...bodyC.highlight, 120);
    }
  }
}

// --- Face (mouth parts — mandibles/maxillipeds) ---

function drawFace(buf: Buffer, cx: number, headCy: number, sp: SpeciesDef, facing: string, eyeState: string) {
  const hr = sp.headRadius;
  const eyeOff = facing === "left" ? -3 : facing === "right" ? 3 : 0;
  const bodyC = makeColorSet(sp.body);
  const accentC = makeColorSet(sp.accent);

  // Mouth parts — small mandibles below the head
  const mouthY = headCy + hr * 0.5;

  // Two small mandible appendages
  drawLine(buf, cx + eyeOff - 3, mouthY - 1, cx + eyeOff - 5, mouthY + 3, 1.2, ...bodyC.shadow);
  drawLine(buf, cx + eyeOff + 3, mouthY - 1, cx + eyeOff + 5, mouthY + 3, 1.2, ...bodyC.shadow);

  // Maxillipeds (feeder legs near mouth)
  drawLine(buf, cx + eyeOff - 2, mouthY, cx + eyeOff - 4, mouthY + 5, 0.8, ...accentC.shadow);
  drawLine(buf, cx + eyeOff + 2, mouthY, cx + eyeOff + 4, mouthY + 5, 0.8, ...accentC.shadow);

  // Rostrum (pointed nose ridge between eyes)
  const rostrumTipY = headCy - hr * 0.1;
  fillTriangle(buf,
    cx + eyeOff - 2, headCy - hr * 0.3,
    cx + eyeOff, rostrumTipY - 3,
    cx + eyeOff + 2, headCy - hr * 0.3,
    ...bodyC.shadow);

  // Cheek accents (bunny/bubble lobster — cute blush)
  if (sp.name === "bunny") {
    fillCircleAA(buf, cx - hr + 3, headCy + 1, 3, ...sp.accent, 100);
    fillCircleAA(buf, cx + hr - 3, headCy + 1, 3, ...sp.accent, 100);
  }
}

// --- Bubbles (Bubble Lobster decoration) ---

function drawBubbles(buf: Buffer, cx: number, headCy: number, sp: SpeciesDef, pose: BodyPose) {
  const bubblePhase = pose.tailPhase;
  const bubblePositions = [
    { dx: -14, dy: -8, r: 3, speed: 1.2 },
    { dx: 10, dy: -14, r: 2.5, speed: 0.8 },
    { dx: -8, dy: -20, r: 2, speed: 1.0 },
    { dx: 16, dy: -6, r: 1.5, speed: 1.4 },
    { dx: 4, dy: -24, r: 2, speed: 0.9 },
    { dx: -18, dy: -16, r: 1.5, speed: 1.1 },
  ];

  for (const bub of bubblePositions) {
    const floatY = Math.sin(bubblePhase * Math.PI * 2 * bub.speed) * 3;
    const bx = cx + bub.dx;
    const by = headCy + bub.dy + floatY;

    // Bubble outline
    fillCircleAA(buf, bx, by, bub.r + 0.5, 200, 220, 255, 60);
    // Bubble interior
    fillCircleAA(buf, bx, by, bub.r, 220, 240, 255, 40);
    // Bubble shine
    setPixel(buf, bx - 1, by - 1, 255, 255, 255, 120);
  }
}

// ═══════════════════════════════════════════════════════════════
// State-Specific Effect Overlays
// ═══════════════════════════════════════════════════════════════

function drawAttackEffects(buf: Buffer, fx: number, fy: number, sp: SpeciesDef, frame: number) {
  const cx = fx + 64;
  const cy = fy + 64;
  if (frame < 2) return; // windup — no effects

  if (frame < 4) {
    // Claw snap — pincer strike arc
    const progress = (frame - 2) / 2;
    for (let i = 0; i < 12; i++) {
      const angle = -0.5 + progress * 2.0 + i * 0.08;
      const r = 20 + i * 2;
      const px = cx + Math.cos(angle) * r;
      const py = cy - 10 + Math.sin(angle) * r;
      const alpha = Math.max(50, 255 - i * 18);
      setPixel(buf, px, py, 255, 255, 255, alpha);
      setPixel(buf, px + 1, py, 255, 255, 200, alpha);
      setPixel(buf, px, py + 1, 255, 255, 200, Math.round(alpha * 0.7));
    }
    // Snap lines (claw closing)
    for (let i = 0; i < 3; i++) {
      const sx = cx + 20 + progress * 10;
      const sy = cy - 5 + i * 4;
      drawLine(buf, sx, sy, sx + 6, sy + (i - 1) * 2, 1, 255, 255, 200, 180);
    }
  } else if (frame < 6) {
    // Impact — water splash + stars
    fillCircleAA(buf, cx + 24, cy - 6, 6, 200, 230, 255, 120 - frame * 10);
    for (let s = 0; s < 5; s++) {
      const a = (s / 5) * Math.PI * 2 + frame * 0.5;
      const r = 12 + frame * 3;
      const sx = cx + 24 + Math.cos(a) * r;
      const sy = cy - 6 + Math.sin(a) * r;
      // Water droplets
      fillCircleAA(buf, sx, sy, 1.5, 180, 220, 255, 200);
    }
  }
}

function drawHurtEffects(buf: Buffer, fx: number, fy: number, sp: SpeciesDef, frame: number) {
  const cx = fx + 64;
  const cy = fy + 50;

  // Red flash on early frames
  if (frame < 4 && frame % 2 === 0) {
    fillCircleAA(buf, cx, cy, 30, 255, 0, 0, 30);
  }

  // Shell crack particles
  if (frame >= 2 && frame < 6) {
    for (let s = 0; s < 4; s++) {
      const a = (s / 4) * Math.PI * 2 + frame * 0.8;
      const r = 14 + frame * 2;
      const sx = cx + Math.cos(a) * r;
      const sy = cy - 16 + Math.sin(a) * r;
      // Shell fragment
      fillRect(buf, sx - 1, sy - 1, 3, 2, ...makeColorSet(sp.body).shadow, 200);
    }
  }

  // Pain stars
  if (frame >= 1 && frame < 5) {
    for (let s = 0; s < 3; s++) {
      const a = (s / 3) * Math.PI * 2 + frame * 0.8;
      const r = 16 + frame * 2;
      const sx = cx + Math.cos(a) * r;
      const sy = cy - 20 + Math.sin(a) * r;
      for (let d = -2; d <= 2; d++) {
        setPixel(buf, sx + d, sy, 255, 255, 100);
        setPixel(buf, sx, sy + d, 255, 255, 100);
      }
    }
  }
}

function drawDeathEffects(buf: Buffer, fx: number, fy: number, sp: SpeciesDef, frame: number) {
  const cx = fx + 64;
  const cy = fy + 64;

  // Bubble wisps rising (lobster death = underwater feel)
  if (frame >= 3) {
    const bubbleCount = 3 + frame - 3;
    for (let i = 0; i < bubbleCount; i++) {
      const bx = cx - 12 + Math.sin(i * 2.3 + frame * 0.5) * 16;
      const by = cy - 16 - i * 5 - (frame - 3) * 5;
      const bR = 2 + Math.sin(i * 1.7) * 1;
      fillCircleAA(buf, bx, by, bR, 200, 220, 255, Math.max(40, 120 - i * 15));
      // Bubble shine
      setPixel(buf, bx - 1, by - 1, 255, 255, 255, Math.max(20, 80 - i * 10));
    }
  }

  // Ground line (lobster flipped on back)
  if (frame >= 2) {
    const gy = fy + 110 + Math.min(frame - 2, 4);
    fillRect(buf, fx + 20, Math.min(gy, fy + 118), 88, 2,
      ...makeColorSet(sp.body).outline, 160);
  }

  // Legs curl up (small lines above body on later frames)
  if (frame >= 5) {
    for (let i = 0; i < 4; i++) {
      const lx = cx - 15 + i * 10;
      const ly = cy - 8 - (frame - 5) * 2;
      drawLine(buf, lx, ly + 5, lx + 2, ly, 1, ...makeColorSet(sp.body).shadow, 120);
    }
  }
}

function drawBlockEffects(buf: Buffer, fx: number, fy: number, sp: SpeciesDef, frame: number) {
  const cx = fx + 64;
  const cy = fy + 60;

  // Tail curled forward as shield
  const tailShieldX = cx + 18;
  const tailShieldY = cy - 4;
  // Tail segments forming shield arc
  for (let i = 0; i < 4; i++) {
    const angle = -0.6 + i * 0.4;
    const segX = tailShieldX + Math.cos(angle) * 8;
    const segY = tailShieldY + Math.sin(angle) * 12;
    fillShadedEllipse(buf, segX, segY, 4, 6, makeColorSet(sp.body), 200 - frame * 8);
  }

  // Shield glow
  fillShadedEllipse(buf, tailShieldX, cy, 10, 14,
    makeColorSet([100, 200, 220] as RGB), 160 - frame * 10);

  // Sparks on impact frame
  if (frame >= 2) {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI + frame * 0.5;
      setPixel(buf, tailShieldX + Math.cos(a) * 14, cy + Math.sin(a) * 14, 180, 240, 255);
    }
  }
}

function drawDodgeEffects(buf: Buffer, fx: number, fy: number, sp: SpeciesDef, frame: number) {
  const cx = fx + 64;
  const cy = fy + 64;

  // Tail flip motion blur (lobsters escape backward)
  for (let i = 0; i < 6; i++) {
    const ly = cy - 16 + i * 8;
    const alpha = Math.max(40, 150 - frame * 30 - i * 10);
    for (let lx = cx - 24; lx < cx - 8; lx++) {
      setPixel(buf, lx, ly, 180, 220, 255, alpha);
    }
  }

  // Water turbulence trail
  if (frame >= 1 && frame <= 3) {
    for (let i = 0; i < 4; i++) {
      const wx = cx - 18 - frame * 4 + i * 6;
      const wy = cy + Math.sin(i + frame) * 6;
      fillCircleAA(buf, wx, wy, 2, 200, 230, 255, 80 - frame * 15);
    }
  }

  // Afterimage on frame 1-2
  if (frame >= 1 && frame <= 2) {
    fillEllipseAA(buf, cx - 20, cy, 12, 16, ...sp.body, 50);
  }
}

function drawSpecialEffects(buf: Buffer, fx: number, fy: number, sp: SpeciesDef, frame: number) {
  const cx = fx + 64;
  const cy = fy + 56;

  // Energy ring (water vortex for lobster)
  const ringR = 10 + frame * 4;
  const ringAlpha = Math.max(60, 200 - frame * 20);
  for (let angle = 0; angle < 16; angle++) {
    const a = (angle / 16) * Math.PI * 2 + frame * 0.4;
    const px = cx + Math.cos(a) * ringR;
    const py = cy + Math.sin(a) * ringR;
    fillCircleAA(buf, px, py, 3, ...sp.accent, ringAlpha);
  }

  // Inner glow
  fillCircleAA(buf, cx, cy, 8 + frame, 255, 255, 255, Math.min(150, 40 + frame * 18));

  // Species-specific special:
  if (sp.hasBioluminescence) {
    // Abyssal: bioluminescent pulse
    for (let ring = 0; ring < 3; ring++) {
      const rr = ringR + ring * 6;
      for (let a = 0; a < 8; a++) {
        const angle = (a / 8) * Math.PI * 2 + frame * 0.3 + ring * 0.5;
        const px = cx + Math.cos(angle) * rr;
        const py = cy + Math.sin(angle) * rr;
        fillCircleAA(buf, px, py, 2, ...sp.accent, Math.max(40, ringAlpha - ring * 30));
      }
    }
  } else if (sp.hasRainbowBands) {
    // Mantis: rainbow burst
    const rainbowColors: RGB[] = [[255, 60, 60], [255, 160, 40], [255, 255, 60], [60, 220, 60], [60, 160, 255], [160, 80, 255]];
    for (let c = 0; c < rainbowColors.length; c++) {
      const rr = ringR + 2 + c * 3;
      const angle = (c / rainbowColors.length) * Math.PI * 2 + frame * 0.6;
      const px = cx + Math.cos(angle) * rr;
      const py = cy + Math.sin(angle) * rr;
      fillCircleAA(buf, px, py, 3, ...rainbowColors[c], ringAlpha);
    }
  }

  // Sparkles / water droplets
  for (let s = 0; s < 4 + frame; s++) {
    const sa = (s / 8) * Math.PI * 2 + frame * 0.7;
    const sr = ringR + 6 + s * 2;
    const spx = cx + Math.cos(sa) * sr;
    const spy = cy + Math.sin(sa) * sr;
    setPixel(buf, spx, spy, 200, 240, 255);
    setPixel(buf, spx + 1, spy, 220, 245, 255);
    setPixel(buf, spx, spy + 1, 220, 245, 255);
  }
}

// ═══════════════════════════════════════════════════════════════
// Sheet Generation
// ═══════════════════════════════════════════════════════════════

interface RowConfig {
  state: string;
  facing: "front" | "back" | "left" | "right";
}

const STATE_ROWS: RowConfig[] = [
  { state: "idle", facing: "front" },
  { state: "walk", facing: "front" },
  { state: "walk", facing: "back" },
  { state: "walk", facing: "left" },
  { state: "walk", facing: "right" },
  { state: "attack", facing: "right" },
  { state: "hurt", facing: "front" },
  { state: "death", facing: "front" },
  { state: "block_dodge", facing: "front" },
  { state: "special", facing: "front" },
];

async function generateSheet(sp: SpeciesDef): Promise<void> {
  const buf = createBuffer();

  for (let row = 0; row < ROWS; row++) {
    const { state, facing } = STATE_ROWS[row];

    for (let col = 0; col < COLS; col++) {
      const fx = col * FRAME;
      const fy = row * FRAME;

      if (state === "idle") {
        const pose = getIdlePose(col, sp);
        const eye = col === 3 ? "closed" : "open"; // blink on frame 3
        drawLobster(buf, fx, fy, sp, facing, pose, eye);
      } else if (state === "walk") {
        const pose = getWalkPose(col, sp);
        drawLobster(buf, fx, fy, sp, facing, pose, "open");
      } else if (state === "attack") {
        // Claw strike animation
        const pose = { ...NEUTRAL_POSE };
        if (col < 2) {
          // Windup — pull claw back, lean back
          pose.bodyOffY = col * 2;
          pose.rightClawOff = -col * 8;
          pose.squashX = 1 - col * 0.03;
          pose.clawOpenPhase = 0.8; // claw wide open
        } else if (col < 4) {
          // Snap forward — claw extends and closes
          pose.bodyOffY = -3;
          pose.rightClawOff = (col - 2) * 10;
          pose.squashX = 1 + (col - 2) * 0.04;
          pose.clawOpenPhase = 0.8 - (col - 2) * 0.35; // closing
        } else if (col < 6) {
          // Impact — claw closed, maximum extension
          pose.bodyOffY = -2;
          pose.rightClawOff = 14;
          pose.squashX = 1.06 - (col - 4) * 0.03;
          pose.clawOpenPhase = 0.05; // snapped shut
        } else {
          // Recovery — retract claw
          pose.bodyOffY = (col - 6) * 1;
          pose.rightClawOff = 14 - (col - 6) * 7;
          pose.squashX = 1;
          pose.clawOpenPhase = 0.1 + (col - 6) * 0.1;
        }
        drawLobster(buf, fx, fy, sp, facing, pose, "open");
        drawAttackEffects(buf, fx, fy, sp, col);
      } else if (state === "hurt") {
        const pose = { ...NEUTRAL_POSE };
        if (col < 2) {
          pose.bodyOffY = -col * 3;
          pose.squashX = 1 + col * 0.04;
          pose.antennaBounce = col * 3; // antennae flail
        } else if (col < 4) {
          pose.bodyOffY = -4 + (col - 2) * 2;
          pose.squashY = 0.92 + (col - 2) * 0.04;
          pose.antennaBounce = 6 - (col - 2) * 2;
        } else if (col < 6) {
          pose.bodyOffY = (col - 4) * -1;
          pose.antennaBounce = 2 - (col - 4);
        }
        // Claws guard position on hurt
        pose.leftClawOff = -4;
        pose.rightClawOff = -4;
        pose.clawOpenPhase = 0.1; // claws closed defensively
        const eye = col < 6 ? "squint" : "open";
        drawLobster(buf, fx, fy, sp, facing, pose, eye);
        drawHurtEffects(buf, fx, fy, sp, col);
      } else if (state === "death") {
        // Lobster flips onto back
        const pose = { ...NEUTRAL_POSE };
        const fallProgress = Math.min(1, col / 5);
        pose.bodyOffY = fallProgress * 22;
        pose.squashY = 1 - fallProgress * 0.35;
        pose.squashX = 1 + fallProgress * 0.25;
        pose.antennaBounce = -fallProgress * 4; // antennae droop
        pose.leftClawOff = fallProgress * 6; // claws splay
        pose.rightClawOff = fallProgress * 6;
        pose.clawOpenPhase = fallProgress * 0.5; // claws go limp open
        pose.tailPhase = 0.5 + fallProgress * 0.3; // tail curls
        const eye = col < 4 ? "squint" : "x";
        drawLobster(buf, fx, fy, sp, facing, pose, eye);
        drawDeathEffects(buf, fx, fy, sp, col);
      } else if (state === "block_dodge") {
        if (col < 4) {
          // Block: tail curled forward as shield, claws guard
          const pose = { ...NEUTRAL_POSE };
          pose.squashX = 1 + col * 0.02;
          pose.bodyOffY = col * 1;
          pose.tailPhase = 0.2 + col * 0.15; // curl tail forward
          pose.leftClawOff = -col * 2; // guard position
          pose.rightClawOff = -col * 2;
          pose.clawOpenPhase = 0.1;
          drawLobster(buf, fx, fy, sp, "right", pose, "open");
          drawBlockEffects(buf, fx, fy, sp, col);
        } else {
          // Dodge: rapid tail flip (lobsters escape backward)
          const dodgeFrame = col - 4;
          const pose = { ...NEUTRAL_POSE };
          pose.bodyOffY = -dodgeFrame * 3;
          pose.squashX = 1 + dodgeFrame * 0.03;
          pose.tailPhase = 0.8 + dodgeFrame * 0.05; // tail fully engaged
          pose.antennaBounce = -dodgeFrame * 2; // antennae stream backward
          const xShift = dodgeFrame * 8;
          drawLobster(buf, fx + xShift, fy, sp, "right", pose, "closed");
          drawDodgeEffects(buf, fx, fy, sp, dodgeFrame);
        }
      } else if (state === "special") {
        // All legs spread, antennae glow, species-specific
        const pose = { ...NEUTRAL_POSE };
        if (col < 2) {
          // Energy gather — crouch, spread legs
          pose.bodyOffY = col * 2;
          pose.squashY = 0.96;
          pose.clawOpenPhase = 0.3 + col * 0.2;
        } else if (col < 4) {
          // Burst — stretch up, claws wide
          pose.bodyOffY = -4;
          pose.squashY = 1.08;
          pose.clawOpenPhase = 0.9; // fully open
          pose.leftClawOff = -(col - 2) * 4;
          pose.rightClawOff = -(col - 2) * 4;
        } else {
          // Glow + settle
          pose.bodyOffY = -(7 - col);
          pose.clawOpenPhase = 0.9 - (col - 4) * 0.15;
          pose.leftClawOff = -4 + (col - 4) * 1;
          pose.rightClawOff = -4 + (col - 4) * 1;
        }
        pose.antennaBounce = Math.sin(col * 0.8) * 3;
        drawLobster(buf, fx, fy, sp, facing, pose, col < 2 ? "closed" : "open");
        drawSpecialEffects(buf, fx, fy, sp, col);
      }
    }
  }

  const outPath = join(OUT_DIR, `${sp.name}-sheet.png`);
  await sharp(buf, { raw: { width: SHEET_W, height: SHEET_H, channels: 4 } })
    .png()
    .toFile(outPath);

  console.log(`  Generated: ${sp.name}-sheet.png (${sp.label}) (${SHEET_W}x${SHEET_H})`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Generating ${SPECIES.length} lobster sprite sheets (${SHEET_W}x${SHEET_H}, ${COLS}x${ROWS} @ ${FRAME}px)...\n`);

  for (const sp of SPECIES) {
    console.log(`  Drawing ${sp.name} (${sp.label})...`);
    await generateSheet(sp);
  }

  console.log(`\nDone! All ${SPECIES.length} lobster sprite sheets generated.`);
}

main().catch(console.error);
