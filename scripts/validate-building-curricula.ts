import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SHOP_BUILDINGS } from '../packages/shared/src/constants/building-types';

const DEFAULT_FIXTURE_URL = new URL('./fixtures/building-skills.json', import.meta.url);
const ALLOWED_URL_HOSTS = new Set(['clawville.world', 'api.clawville.world']);
const KEBAB_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const URL_PATTERN = /https?:\/\/[^\s<>"'`\)\]}]+/giu;

interface BuildingCurriculumFixtureRow {
  building_id: string;
  name: string;
  description: string;
  content: string;
  content_hash: string;
  generator_version: number;
  source_article_ids: string[];
}

export interface CurriculumContentScanResult {
  errors: string[];
  warnings: string[];
}

export interface BuildingCurriculaValidationResult {
  errors: string[];
  warnings: string[];
}

interface SkillFrontmatter {
  name: string;
  description: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFixtureRow(value: unknown): value is BuildingCurriculumFixtureRow {
  if (!isRecord(value)) return false;

  return (
    typeof value.building_id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.content === 'string' &&
    typeof value.content_hash === 'string' &&
    Number.isInteger(value.generator_version) &&
    Array.isArray(value.source_article_ids) &&
    value.source_article_ids.every((id) => typeof id === 'string')
  );
}

function extractFrontmatter(content: string): string {
  const normalized = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(
    normalized,
  );
  if (!match?.[1]) {
    throw new Error('content must begin with a closed YAML frontmatter block');
  }
  return match[1];
}

function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const source = extractFrontmatter(content);
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(source);
  } catch (error: unknown) {
    throw new Error(
      `frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error('frontmatter must be a YAML mapping');
  }
  if (typeof parsed.name !== 'string' || typeof parsed.description !== 'string') {
    throw new Error('frontmatter name and description must be strings');
  }

  return { name: parsed.name, description: parsed.description };
}

function validateSkillMetadata(name: string, description: string): string[] {
  const errors: string[] = [];
  if (name.length === 0 || name.length > 64 || !KEBAB_NAME_PATTERN.test(name)) {
    errors.push('name must be kebab-case and contain 1-64 characters');
  }
  if (description.length === 0 || description.length >= 1024) {
    errors.push('description must contain 1-1023 characters');
  }
  return errors;
}

/**
 * Scan agent-facing curriculum text for prohibited legacy terminology and
 * off-domain links. `pet ` is intentionally warning-only for human review.
 */
export function scanCurriculumContent(content: string): CurriculumContentScanResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const forbiddenTerms: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
    ['casino (any case)', /casino/iu],
    ['standalone CLV', /\bCLV\b/u],
    ['ClawToken or ClawTokens', /\bClawTokens?\b/u],
    ['standalone CT', /\bCT\b/u],
    ['moltbook (any case)', /moltbook/iu],
    ['Gemini (any case)', /Gemini/iu],
  ];

  for (const [label, pattern] of forbiddenTerms) {
    if (pattern.test(content)) errors.push(`forbidden term: ${label}`);
  }

  if (/\bpet[ \t]+/iu.test(content)) {
    warnings.push('manual review: `pet ` may refer to a legacy currency');
  }

  for (const match of content.matchAll(URL_PATTERN)) {
    // Sentence punctuation is not part of an otherwise bare URL. Markdown
    // closing delimiters are excluded by URL_PATTERN itself.
    const candidate = match[0].replace(/[.,;:!?]+$/u, '');
    try {
      const hostname = new URL(candidate).hostname.toLowerCase();
      if (!ALLOWED_URL_HOSTS.has(hostname)) {
        errors.push(`off-domain URL: ${candidate}`);
      }
    } catch {
      errors.push(`invalid http(s) URL: ${candidate}`);
    }
  }

  return { errors, warnings };
}

export function validateBuildingCurriculaFixture(
  value: unknown,
): BuildingCurriculaValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Array.isArray(value)) {
    return { errors: ['fixture must be an array'], warnings };
  }
  if (value.length !== SHOP_BUILDINGS.length) {
    errors.push(`fixture must contain exactly ${SHOP_BUILDINGS.length} entries`);
  }

  const rows: BuildingCurriculumFixtureRow[] = [];
  value.forEach((candidate, index) => {
    if (!isFixtureRow(candidate)) {
      errors.push(`entry ${index}: invalid fixture row shape`);
      return;
    }
    rows.push(candidate);
  });

  const canonicalIds = new Set<string>(SHOP_BUILDINGS);
  const actualIds = new Set(rows.map((row) => row.building_id));
  if (actualIds.size !== rows.length) {
    errors.push('fixture contains duplicate building_id values');
  }
  if (actualIds.has('clawville-play')) {
    errors.push('clawville-play is code-generated and must not be in the fixture');
  }
  const missingIds = SHOP_BUILDINGS.filter((id) => !actualIds.has(id));
  const unexpectedIds = [...actualIds].filter((id) => !canonicalIds.has(id));
  if (missingIds.length > 0) errors.push(`missing building IDs: ${missingIds.join(', ')}`);
  if (unexpectedIds.length > 0) {
    errors.push(`unexpected building IDs: ${unexpectedIds.join(', ')}`);
  }

  for (const row of rows) {
    const prefix = row.building_id || '<empty building_id>';
    for (const error of validateSkillMetadata(row.name, row.description)) {
      errors.push(`${prefix}: fixture ${error}`);
    }
    if (row.generator_version !== 3) {
      errors.push(`${prefix}: generator_version must be 3`);
    }
    if (!SHA256_HEX_PATTERN.test(row.content_hash)) {
      errors.push(`${prefix}: content_hash must be a lowercase SHA-256 hex digest`);
    } else {
      const expectedHash = createHash('sha256').update(row.content).digest('hex');
      if (row.content_hash !== expectedHash) {
        errors.push(`${prefix}: content_hash does not match content`);
      }
    }

    try {
      const frontmatter = parseSkillFrontmatter(row.content);
      for (const error of validateSkillMetadata(
        frontmatter.name,
        frontmatter.description,
      )) {
        errors.push(`${prefix}: frontmatter ${error}`);
      }
      if (frontmatter.name !== row.name) {
        errors.push(`${prefix}: frontmatter name does not match fixture name`);
      }
      if (frontmatter.description !== row.description) {
        errors.push(`${prefix}: frontmatter description does not match fixture description`);
      }
    } catch (error: unknown) {
      errors.push(
        `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const scan = scanCurriculumContent(row.content);
    errors.push(...scan.errors.map((error) => `${prefix}: ${error}`));
    warnings.push(...scan.warnings.map((warning) => `${prefix}: ${warning}`));
  }

  return { errors, warnings };
}

/** Validate a parsed fixture, printing warning-only findings and throwing on errors. */
export function assertValidBuildingCurriculaFixture(value: unknown): void {
  const result = validateBuildingCurriculaFixture(value);
  for (const warning of result.warnings) console.warn(`WARNING: ${warning}`);
  if (result.errors.length > 0) {
    throw new Error(`building curricula validation failed:\n- ${result.errors.join('\n- ')}`);
  }
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? fileURLToPath(DEFAULT_FIXTURE_URL);
  const fixture: unknown = JSON.parse(await readFile(path, 'utf8'));
  const result = validateBuildingCurriculaFixture(fixture);

  for (const warning of result.warnings) console.warn(`WARNING: ${warning}`);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`ERROR: ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `building curricula validation passed: ${SHOP_BUILDINGS.length} entries; ${result.warnings.length} warnings`,
  );
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(
      `building curricula validator failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
