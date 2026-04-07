export type Species =
  | "cat"
  | "dragon"
  | "fox"
  | "owl"
  | "wolf"
  | "bunny"
  | "phoenix"
  | "turtle";

export const ALL_SPECIES: Species[] = [
  "cat",
  "dragon",
  "fox",
  "owl",
  "wolf",
  "bunny",
  "phoenix",
  "turtle",
];

export const SPECIES_LABELS: Record<Species, string> = {
  cat: "Reef Lobster",
  dragon: "Abyssal Lobster",
  fox: "Spiny Lobster",
  owl: "Hermit Lobster",
  wolf: "Crusher Lobster",
  bunny: "Bubble Lobster",
  phoenix: "Mantis Lobster",
  turtle: "Iron Lobster",
};

export const SPECIES_SPRITE_PATH: Record<Species, string> = {
  cat: "sprites/pets/cat.png",
  dragon: "sprites/pets/dragon.png",
  fox: "sprites/pets/fox.png",
  owl: "sprites/pets/owl.png",
  wolf: "sprites/pets/wolf.png",
  bunny: "sprites/pets/bunny.png",
  phoenix: "sprites/pets/phoenix.png",
  turtle: "sprites/pets/turtle.png",
};

// Species -> lobster body color (hex strings for CSS)
export const SPECIES_COLORS: Record<string, { base: string; accent: string }> = {
  cat: { base: "#FF6347", accent: "#FF7F50" },     // Reef — coral red
  dragon: { base: "#1A237E", accent: "#283593" },   // Abyssal — deep navy
  fox: { base: "#FF8C00", accent: "#FFA726" },      // Spiny — bright orange
  owl: { base: "#8D6E63", accent: "#A1887F" },      // Hermit — brown shell
  wolf: { base: "#B71C1C", accent: "#C62828" },     // Crusher — dark crimson
  bunny: { base: "#FF80AB", accent: "#F48FB1" },    // Bubble — pink
  phoenix: { base: "#00E676", accent: "#76FF03" },   // Mantis — neon green
  turtle: { base: "#455A64", accent: "#546E7A" },    // Iron — gunmetal
};
