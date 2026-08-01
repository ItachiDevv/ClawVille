/**
 * Classifier + accounting tests for the cold-load ledger (rung-0 review
 * blocker 2): URL normalization across schemes, per-URL aggregation of
 * duplicate requests, the animation role split, shared player/wanderer VRM
 * demand under fixtures, and the lobster_plush shared flag.
 */
import { describe, expect, it } from 'bun:test';
import { buildLedger, canonicalUrl, classifyRole } from '../cold-load-ledger.mjs';

const req = (url: string, wireBytes: number, cls = 'VRM') => ({ url, wireBytes, cls, failed: false });

describe('canonicalUrl', () => {
  it('normalizes http localhost and https staging to the same canonical form', () => {
    expect(canonicalUrl('http://localhost:3010/avatars/tekk.vrm?v=2')).toBe('/avatars/tekk.vrm?v=2');
    expect(canonicalUrl('https://staging.clawville.world/avatars/tekk.vrm?v=2')).toBe('/avatars/tekk.vrm?v=2');
  });
  it('excludes blob/data/malformed urls', () => {
    expect(canonicalUrl('blob:https://x/abc')).toBeNull();
    expect(canonicalUrl('data:image/webp;base64,AAA')).toBeNull();
    expect(canonicalUrl('not a url')).toBeNull();
  });
  it('a ?v=N cache-bust never changes a URL role', () => {
    expect(classifyRole('/avatars/adinero.vrm?v=1').lane).toBe('post-ambient-vrm');
    expect(classifyRole('/avatars/adinero.vrm').lane).toBe('post-ambient-vrm');
  });
});

describe('classifyRole — animation split', () => {
  it('shared base locomotion is reveal-core', () => {
    expect(classifyRole('/avatars/animations/idle.glb').lane).toBe('reveal-core');
    expect(classifyRole('/avatars/animations/walk.glb').lane).toBe('reveal-core');
  });
  it('character-specific clip dirs are post-anim-char with shared demand', () => {
    const r = classifyRole('/avatars/animations/chibi/idle.glb');
    expect(r.lane).toBe('post-anim-char');
    expect(r.sharedDemand).toBe(true);
  });
});

describe('classifyRole — models', () => {
  it('location characters are post-location; lobster_plush carries the shared flag', () => {
    expect(classifyRole('/models/characters/spongebob-ktx.glb').sharedDemand).toBe(false);
    const plush = classifyRole('/models/lobster_plush-ktx.glb?v=2');
    expect(plush.lane).toBe('post-location');
    expect(plush.sharedDemand).toBe(true);
  });
  it('buildings stay reveal-core', () => {
    expect(classifyRole('/models/pineapple-house-opt1-ktx.glb?v=3').lane).toBe('reveal-core');
  });
});

describe('buildLedger', () => {
  it('aggregates duplicate requests for one canonical URL across schemes', () => {
    const ledger = buildLedger({
      requests: [
        req('http://localhost:3010/avatars/tekk.vrm?v=2', 1000),
        req('http://localhost:3010/avatars/tekk.vrm?v=2', 1000),
      ],
    });
    const row = ledger.rows.find((r: any) => r.url === '/avatars/tekk.vrm?v=2')!;
    expect(row.requestCount).toBe(2);
    expect(row.beforeBytes).toBe(2000);
    expect(ledger.rows.length).toBe(1);
  });

  it('fixture-critical shared VRM stays reveal-gated and is NOT subtracted from M1', () => {
    const ledger = buildLedger({
      requests: [
        req('https://staging.clawville.world/avatars/milady-official-5.vrm', 600_000),
        req('https://staging.clawville.world/avatars/milady-official-1.vrm', 200_000),
      ],
    }, 'guest-default');
    const critical = ledger.rows.find((r: any) => r.url.includes('milady-official-5'))!;
    const ambient = ledger.rows.find((r: any) => r.url.includes('milady-official-1'))!;
    expect(critical.effectiveLane).toBe('reveal-core');
    expect(critical.postExclusive).toBe(false);
    expect(ambient.postExclusive).toBe(true);
    // M1 = total − post-exclusive only ⇒ the critical 600k stays.
    expect(ledger.milestones.m1RevealProjectionMB).toBeCloseTo(600_000 / 1048576, 3);
  });

  it('ansem-owner fixture pins ansem + sword + ansem clips as critical', () => {
    const ledger = buildLedger({
      requests: [
        req('https://x/avatars/ansem.vrm?v=1', 100),
        req('https://x/avatars/ansem-sword.glb', 100, 'GLB'),
        req('https://x/avatars/animations/ansem/idle.glb', 100, 'GLB'),
        req('https://x/avatars/adinero.vrm?v=1', 100),
      ],
    }, 'ansem-owner');
    for (const url of ['ansem.vrm', 'ansem-sword', '/animations/ansem/']) {
      const row = ledger.rows.find((r: any) => r.url.includes(url))!;
      expect(row.fixtureCritical).toBe(true);
      expect(row.effectiveLane).toBe('reveal-core');
    }
    expect(ledger.rows.find((r: any) => r.url.includes('adinero'))!.postExclusive).toBe(true);
  });

  it('never credits deferral toward the queue-drained total', () => {
    const ledger = buildLedger({
      requests: [req('https://x/models/characters/pearl-ktx.glb', 1_048_576, 'GLB')],
    });
    // No diet applied: total after == total before even though the row is deferred.
    expect(ledger.milestones.queueDrainedTotalMB).toBe(1);
    expect(ledger.milestones.m1RevealProjectionMB).toBe(0);
  });

  it('reconciles failed requests as excluded-by-reason bytes (never silently absent)', () => {
    const ledger = buildLedger({
      requests: [req('https://x/models/a.glb', 1000, 'GLB')],
      failedRequests: [{ url: 'https://x/config.json', wireBytes: 300, cls: 'JSON', failed: true }],
    });
    expect(ledger.accounting.reportTotalBytes).toBe(1300);
    expect(ledger.accounting.excludedByReason.failed).toBe(300);
    expect(ledger.accounting.includedBytes + ledger.accounting.excludedBytes).toBe(1300);
  });

  it('applies diets by canonical url with and without the query', () => {
    const ledger = buildLedger({
      requests: [req('https://x/models/lobster_plush-ktx.glb?v=2', 1_048_576, 'GLB')],
    }, 'guest-default', { '/models/lobster_plush-ktx.glb': 200_000 });
    expect(ledger.rows[0].afterBytes).toBe(200_000);
    expect(ledger.milestones.queueDrainedTotalMB).toBeCloseTo(200_000 / 1048576, 3);
  });
});
