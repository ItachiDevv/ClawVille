// ClawVille color palette — deep ocean / underwater theme
export const COLORS = {
  // Primary
  primary: "#1B4D89",      // Deep ocean blue
  secondary: "#FF6B35",    // Lobster coral orange
  accent: "#00E5FF",       // Bioluminescent cyan

  // Backgrounds
  bg: "#0A1628",           // Abyss dark
  bgLight: "#142240",      // Deep water
  bgGradient1: "#0D1B2A",  // Gradient start
  bgGradient2: "#1B4D89",  // Gradient mid
  bgGradient3: "#274C77",  // Gradient end

  // UI
  panel: "#E8F1F5",        // Light panel text
  panelBg: "#1A2D42",      // Panel background
  border: "#2E6EB5",       // Panel borders

  // Semantic
  success: "#00E676",      // Mantis green
  warning: "#FFD54F",      // Gold
  danger: "#FF5252",       // Crusher red
  info: "#00B8D4",         // Cyan info

  // Species accents
  reef: "#FF6347",         // Reef Lobster (cat)
  abyssal: "#1A237E",      // Abyssal Lobster (dragon)
  spiny: "#FF8C00",        // Spiny Lobster (fox)
  hermit: "#8D6E63",       // Hermit Lobster (owl)
  crusher: "#B71C1C",      // Crusher Lobster (wolf)
  bubble: "#FF80AB",       // Bubble Lobster (bunny)
  mantis: "#00E676",       // Mantis Lobster (phoenix)
  iron: "#455A64",         // Iron Lobster (turtle)

  // Token
  clawToken: "#FFD700",     // Gold for ClawToken/currency

  // Aliases (for compatibility with showcase videos)
  gold: "#FFD700",
  white: "#FFFFFF",
  green: "#00E676",
  greenDark: "#00C853",
  red: "#FF5252",
  star: "#FFD700",
  panelBorder: "#2E6EB5",
  blue: "#42A5F5",
  darkGreen: "#2E7D32",
} as const;
