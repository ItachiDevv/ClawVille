/**
 * Skill generation utilities — extracted from openclaw.ts for shared use.
 */

export interface SkillGenOpts {
  avatarName: string;
  species: string;
  archetype: string;
  avatarId: string;
  clawTokens: number;
  bio: string[];
  knowledge: string[];
  topics: string[];
  lore: string[];
  style: any;
  customName?: string;
  customDescription?: string;
  customInstructions?: string;
  selectedKnowledge?: string[];
  format?: 'elizaos' | 'openclaw';
}

// ---------------------------------------------------------------------------
// ElizaOS Character JSON format
// ---------------------------------------------------------------------------
export function generateElizaOsSkill(opts: SkillGenOpts): { markdown: string; characterJson: string; installPath: string; publishCommand: string } {
  const slug = (opts.customName ?? opts.avatarName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const skillName = opts.customName ?? opts.avatarName;
  const description = opts.customDescription ?? `OpenClaw knowledge from ${opts.avatarName}`;
  const knowledgeEntries = opts.selectedKnowledge ?? opts.knowledge;

  const styleRaw = opts.style;
  const style = styleRaw && !Array.isArray(styleRaw)
    ? { all: styleRaw.all ?? [], chat: styleRaw.chat ?? [], post: styleRaw.post ?? [] }
    : { all: Array.isArray(styleRaw) ? styleRaw : [], chat: [] as string[], post: [] as string[] };

  const characterPartial: Record<string, unknown> = {
    name: skillName,
    description,
    bio: opts.bio,
    knowledge: knowledgeEntries,
    topics: opts.topics,
    adjectives: [],
    lore: opts.lore,
    style,
  };

  if (opts.customInstructions) {
    characterPartial.system = opts.customInstructions;
  }

  const characterJson = JSON.stringify(characterPartial, null, 2);
  const exportDate = new Date().toISOString().split('T')[0];

  const lines: string[] = [
    '---',
    `name: ${slug}`,
    `description: "${description}"`,
    'user-invocable: false',
    `format: elizaos-character`,
    '---',
    '',
    `# ${skillName} — ElizaOS Skill`,
    '',
    `> Exported ${exportDate} | ${knowledgeEntries.length} knowledge entries`,
    '',
  ];

  if (knowledgeEntries.length > 0) {
    lines.push('## Core Knowledge', '');
    for (const entry of knowledgeEntries) lines.push(`- ${entry}`);
    lines.push('');
  }

  if (opts.topics.length > 0) {
    lines.push('## Topics', '', opts.topics.join(', '), '');
  }

  if (style.all.length > 0) {
    lines.push('## Style', '');
    for (const s of style.all) lines.push(`- ${s}`);
    lines.push('');
  }

  lines.push('## Character JSON', '', 'Import this into any ElizaOS agent:', '', '```json', characterJson, '```', '');

  const installPath = `characters/${slug}.character.json`;
  const publishCommand = `npx elizaos publish --name "${skillName}"`;

  lines.push('## Install', '', '```bash', `# Save character JSON to your ElizaOS project:`, `# ${installPath}`, `# Then load with: npx elizaos start --character ${installPath}`, '```', '');

  return { markdown: lines.join('\n'), characterJson, installPath, publishCommand };
}

// ---------------------------------------------------------------------------
// OpenClaw SKILL.md format
// ---------------------------------------------------------------------------
export function generateOpenClawSkill(opts: SkillGenOpts): { markdown: string; installPath: string; publishCommand: string } {
  const slug = (opts.customName ?? opts.avatarName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const skillName = `openclaw-${slug}`;
  const description = opts.customDescription ?? `OpenClaw knowledge from ${opts.avatarName} via ClawVille`;
  const knowledgeEntries = opts.selectedKnowledge ?? opts.knowledge;
  const exportDate = new Date().toISOString().split('T')[0];

  const metadata = JSON.stringify({
    openclaw: { requires: {} },
    clawville: {
      avatarId: opts.avatarId,
      species: opts.species,
      archetype: opts.archetype,
      knowledgeCount: knowledgeEntries.length,
      exportedAt: new Date().toISOString(),
    },
  });

  const lines: string[] = [
    '---',
    `name: ${skillName}`,
    `description: "${description}"`,
    'homepage: https://clawville.com',
    'user-invocable: false',
    `metadata: ${metadata}`,
    '---',
    '',
    `# ${opts.avatarName} — OpenClaw Skill`,
    '',
    `> Exported on ${exportDate} | Species: ${opts.species} | Archetype: ${opts.archetype} | vCLAW: ${opts.clawTokens} | Knowledge entries: ${knowledgeEntries.length}`,
    '',
  ];

  if (opts.bio.length > 0) {
    lines.push('## Identity', '', opts.bio.join(' '), '');
  }

  if (opts.customInstructions) {
    lines.push('## Custom Instructions', '', opts.customInstructions, '');
  }

  if (knowledgeEntries.length > 0) {
    lines.push('## Core Knowledge', '');
    const grouped: Record<string, string[]> = {};
    const ungrouped: string[] = [];
    for (const entry of knowledgeEntries) {
      const match = entry.match(/from\s+(.+)$/i);
      if (match) {
        const source = match[1].trim();
        if (!grouped[source]) grouped[source] = [];
        grouped[source].push(entry);
      } else {
        ungrouped.push(entry);
      }
    }
    for (const [source, entries] of Object.entries(grouped)) {
      lines.push(`### ${source}`, '');
      for (const entry of entries) lines.push(`- ${entry}`);
      lines.push('');
    }
    if (ungrouped.length > 0) {
      lines.push('### General', '');
      for (const entry of ungrouped) lines.push(`- ${entry}`);
      lines.push('');
    }
  }

  if (opts.topics.length > 0) {
    lines.push('## Topics of Expertise', '', `This agent has expertise in: ${opts.topics.join(', ')}.`, '');
  }

  if (opts.lore.length > 0 || opts.style) {
    lines.push('## Personality & Style', '');
    if (opts.lore.length > 0) {
      for (const entry of opts.lore) lines.push(`- ${entry}`);
    }
    if (opts.style) {
      const styleEntries = Array.isArray(opts.style) ? opts.style : opts.style?.all ?? [];
      if (styleEntries.length > 0) {
        lines.push('', 'Communication style:');
        for (const s of styleEntries) lines.push(`- ${s}`);
      }
    }
    lines.push('');
  }

  const installPath = `~/.openclaw/workspace/skills/${skillName}/SKILL.md`;
  const publishCommand = `clawhub publish --slug ${skillName} --name "${opts.customName ?? opts.avatarName}" --version 1.0.0 --tags openclaw,agents,ai`;

  lines.push('## Install', '', '```bash', `mkdir -p ~/.openclaw/workspace/skills/${skillName}`, `# Copy SKILL.md into ${installPath}`, '```', '', 'Or publish to ClawHub:', '', '```bash', publishCommand, '```', '');

  return { markdown: lines.join('\n'), installPath, publishCommand };
}

// ---------------------------------------------------------------------------
// Unified skill generator
// ---------------------------------------------------------------------------
export function generateSkillMd(opts: SkillGenOpts): { markdown: string; characterJson?: string; installPath: string; publishCommand: string } {
  const format = opts.format ?? 'elizaos';
  if (format === 'openclaw') {
    return generateOpenClawSkill(opts);
  }
  return generateElizaOsSkill(opts);
}
