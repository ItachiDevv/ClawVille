export interface ArchetypeInfo {
  id: string;
  label: string;
  tone: string;
}

export const ARCHETYPES: ArchetypeInfo[] = [
  { id: "brave-adventurer", label: "Brave Adventurer", tone: "enthusiastic" },
  { id: "curious-scholar", label: "Curious Scholar", tone: "intellectual" },
  { id: "mischievous-trickster", label: "Mischievous Trickster", tone: "playful" },
  { id: "gentle-healer", label: "Gentle Healer", tone: "warm" },
  { id: "fierce-battler", label: "Fierce Battler", tone: "intense" },
  { id: "creative-dreamer", label: "Creative Dreamer", tone: "whimsical" },
  { id: "noble-guardian", label: "Noble Guardian", tone: "stoic" },
  { id: "cunning-trader", label: "Cunning Trader", tone: "shrewd" },
  { id: "mystical-seer", label: "Mystical Seer", tone: "cryptic" },
  { id: "loyal-companion", label: "Loyal Companion", tone: "earnest" },
  { id: "wild-explorer", label: "Wild Explorer", tone: "rugged" },
  { id: "royal-diplomat", label: "Royal Diplomat", tone: "formal" },
  { id: "chaotic-jester", label: "Chaotic Jester", tone: "zany" },
  { id: "quiet-mystic", label: "Quiet Mystic", tone: "contemplative" },
];

// Subset used in Video 1 showcase
export const SHOWCASE_ARCHETYPES = ARCHETYPES.slice(0, 4);
