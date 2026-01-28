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
