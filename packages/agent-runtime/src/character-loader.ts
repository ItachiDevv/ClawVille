import { templates, type LocationTemplate } from '@elizapets/agent-templates';

export function loadLocationTemplate(locationId: string): LocationTemplate {
  const template = templates[locationId];
  if (!template) {
    // Fall back to a generic template
    return {
      name: 'Shop Keeper',
      description: 'A friendly shop keeper.',
      bio: ['A helpful shopkeeper in Neopia Central.'],
      lore: ['Has worked in this shop for many years.'],
      knowledge: ['Knows about items and services.'],
      topics: ['shopping', 'items', 'neopia'],
      adjectives: ['friendly', 'helpful', 'knowledgeable'],
      messageExamples: [],
      style: { all: ['Be helpful and friendly'], chat: [], post: [] },
      settings: {},
    };
  }
  return template;
}

export function mergeCustomizations(
  template: LocationTemplate,
  customizations?: {
    name?: string;
    personality?: string;
    rules?: string[];
    tone?: string;
  }
) {
  if (!customizations) return { ...template, merged: false };

  const mergedBio = customizations.personality
    ? [...template.bio, customizations.personality]
    : template.bio;

  const mergedStyle = {
    ...template.style,
    all: [...template.style.all, ...(customizations.rules || [])],
  };

  if (customizations.tone) {
    const toneRules: Record<string, string[]> = {
      formal: ['Use formal language', 'Be professional'],
      casual: ['Use casual language', 'Be relaxed'],
      friendly: ['Be warm and approachable'],
      professional: ['Maintain professional demeanor'],
      enthusiastic: ['Speak with high energy and excitement', 'Show genuine passion for the topic'],
      intellectual: ['Use precise, well-chosen language', 'Reference sources and evidence naturally'],
      playful: ['Keep the tone light and fun', 'Use wordplay and humor'],
      warm: ['Speak gently and with care', 'Validate emotions before offering solutions'],
      intense: ['Be direct and confident', 'Use strong, decisive language'],
      whimsical: ['See creative possibilities everywhere', 'Express ideas through vivid imagery'],
      stoic: ['Speak with quiet authority', 'Show strength through restraint'],
      shrewd: ['Be perceptive and strategic', 'Always have an angle'],
      cryptic: ['Imply more than you state directly', 'Speak in layers and metaphor'],
      earnest: ['Be genuine and sincere', 'Prioritize honesty and warmth'],
      rugged: ['Speak plainly and directly', 'Draw wisdom from experience'],
      zany: ['Commit fully to comedic energy', 'Subvert expectations at every turn'],
      contemplative: ['Speak sparingly with deep meaning', 'Let silence carry weight'],
    };
    mergedStyle.all = [...mergedStyle.all, ...(toneRules[customizations.tone] || [])];
  }

  return {
    ...template,
    name: customizations.name || template.name,
    bio: mergedBio,
    style: mergedStyle,
    merged: true,
  };
}
