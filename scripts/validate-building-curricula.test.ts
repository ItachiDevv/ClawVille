import { describe, expect, it } from 'bun:test';
import { scanCurriculumContent } from './validate-building-curricula';

describe('scanCurriculumContent', () => {
  it('rejects hard-forbidden terms with the required case and boundaries', () => {
    const result = scanCurriculumContent(
      'CaSiNo CLV ClawToken ClawTokens CT moltBOOK gEmInI',
    );

    expect(result.errors).toHaveLength(6);
    expect(result.warnings).toEqual([]);
  });

  it('does not false-positive CLV or CT inside larger words', () => {
    const result = scanCurriculumContent(
      'vCLAW CTV selected action inspected reflective CLVelocity',
    );

    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it('reports a pet occurrence for manual review without failing', () => {
    const result = scanCurriculumContent('Review the pet token wording manually.');

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      'manual review: `pet ` may refer to a legacy currency',
    ]);
  });

  it('allows only exact ClawVille API and site hostnames', () => {
    const result = scanCurriculumContent(
      [
        'https://clawville.world/api/skills/clawville-play/skill.md.',
        'https://api.clawville.world/api/agent/connect,',
        'https://clawville.world.evil.example/steal',
        'https://api.clawville.world@evil.example/steal',
        'http://example.com/docs',
      ].join('\n'),
    );

    expect(result.errors).toEqual([
      'off-domain URL: https://clawville.world.evil.example/steal',
      'off-domain URL: https://api.clawville.world@evil.example/steal',
      'off-domain URL: http://example.com/docs',
    ]);
    expect(result.warnings).toEqual([]);
  });
});
