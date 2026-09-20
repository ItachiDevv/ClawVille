import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { tapeVisibleForThoughtLog } from './placement';

const webRoot = resolve(import.meta.dir, '../../../..');
const read = (relativePath: string) => readFileSync(resolve(webRoot, relativePath), 'utf8');

describe('Trading Floor placement and mobile structure', () => {
  test('expanded thought log suppresses the tape', () => {
    expect(tapeVisibleForThoughtLog(true, false)).toBe(false);
    expect(tapeVisibleForThoughtLog(true, true)).toBe(true);
    expect(tapeVisibleForThoughtLog(false, false)).toBe(true);
  });

  test('mobile gating renders nothing until useIsMobile resolves', () => {
    const tape = read('src/components/game/trading-floor/floor-tape.tsx');
    expect(tape).toContain('const isMobile = useIsMobile()');
    expect(tape).toContain('useState(false)');
    expect(tape).toMatch(/!mobileResolved\s*\|\|\s*isMobile/);
  });

  test('tape is a sidebar child without fixed positioning', () => {
    const sidebar = read('src/components/game/sidebar-menu.tsx');
    const tape = read('src/components/game/trading-floor/floor-tape.tsx');
    expect(sidebar).toMatch(/<FloorTape\s*\/>/);
    expect(tape).toContain("maxHeight: 'min(140px, 20vh)'");
    expect(tape).not.toMatch(/position:\s*['\"]fixed['\"]/);
    expect(tape).not.toMatch(/zIndex|z-index/);
  });

  test('tab strip and close primitive declare the touch geometry', () => {
    const exchange = read('src/components/game/exchange-modal.tsx');
    const glow = read('src/components/rpg/glow.css');
    expect(exchange).toContain("overflowX: 'auto'");
    expect(exchange).toContain("flexWrap: 'nowrap'");
    expect(exchange).toContain('flexShrink: 0');
    expect(exchange).toContain('minHeight: 44');
    expect(glow).toMatch(/\.rpg-modal-shell__close\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/);
  });

  test('all current RpgModal users share the 44px close primitive', () => {
    const modalFiles = [
      'src/components/game/activity-lobby-modal.tsx',
      'src/components/game/bounty-board-modal.tsx',
      'src/components/game/building-portal-modal.tsx',
      'src/components/game/cosmetic-drawer.tsx',
      'src/components/game/exchange-modal.tsx',
      'src/components/game/guest-upsell-modal.tsx',
      'src/components/game/leaderboard-modal.tsx',
      'src/components/game/land/land-office-modal.tsx',
      'src/components/game/quest-board-modal.tsx',
      'src/components/game/sidebar-menu.tsx',
      'src/components/game/world-map-modal.tsx',
    ];
    const present = modalFiles.filter((file) => {
      try { return read(file).includes('RpgModal'); } catch { return false; }
    });
    expect(present).toHaveLength(modalFiles.length);
    expect(read('src/components/rpg/glow.css')).toContain('.rpg-modal-shell__close');
  });
});

describe('Trading Floor outward copy and dark card tokens', () => {
  test('new UI source contains no forbidden outward copy', () => {
    const files = [
      'src/components/game/trading-floor/clawpump-templates.tsx',
      'src/components/game/trading-floor/house-traders.tsx',
      // The risk verdict's copy and its arithmetic sentence are BUILT here,
      // so the outward-copy and token rules have to reach the module that
      // writes them, not only the component that mounts the result.
      'src/components/game/trading-floor/house-trader-risk.ts',
      'src/components/game/trading-floor/floor-tape.tsx',
      'src/components/game/trading-floor/trade-row.tsx',
      'src/components/game/trading-floor/trading-floor-tab.tsx',
      'src/components/game/trading-floor/format.ts',
    ];
    for (const file of files) {
      const source = read(file);
      expect(source).not.toContain('—');
      expect(source.toLowerCase()).not.toContain('casino');
      expect(source).not.toMatch(/\bCT\b/);
    }
  });

  test('modified inline JSX copy follows the same copy rules', () => {
    const selectedLines = [
      ...read('src/components/game/exchange-modal.tsx').split(/\r?\n/).filter((line) =>
        /TradingFloor|Trading Floor|Verified on-chain|Live floor/.test(line),
      ),
      ...read('src/components/game/sidebar-menu.tsx').split(/\r?\n/).filter((line) =>
        /Trading Floor|Land · Cosmetics · Trading/.test(line),
      ),
      ...read('src/app/leaderboard/page.tsx').split(/\r?\n/).filter((line) =>
        /data-trader|ClawVille-operated|Verified trading|ANSEM pair|ClawVille pair|Other pair|Per scored trade/.test(line),
      ),
    ].join('\n');
    expect(selectedLines).not.toContain('—');
    expect(selectedLines.toLowerCase()).not.toContain('casino');
    expect(selectedLines).not.toMatch(/\bCT\b/);
  });

  test('no Trading Floor feature flag exists', () => {
    const files = [
      'src/components/game/exchange-modal.tsx',
      'src/components/game/sidebar-menu.tsx',
      'src/hooks/use-trading-floor.ts',
      'src/stores/trade-ticker.ts',
    ];
    for (const file of files) expect(read(file)).not.toContain('NEXT_PUBLIC_TRADING_FLOOR_ENABLED');
  });

  test('hex colors live only in the token module', () => {
    const files = [
      'src/components/game/trading-floor/clawpump-templates.tsx',
      'src/components/game/trading-floor/house-traders.tsx',
      // The risk verdict's copy and its arithmetic sentence are BUILT here,
      // so the outward-copy and token rules have to reach the module that
      // writes them, not only the component that mounts the result.
      'src/components/game/trading-floor/house-trader-risk.ts',
      'src/components/game/trading-floor/floor-tape.tsx',
      'src/components/game/trading-floor/trade-row.tsx',
      'src/components/game/trading-floor/trading-floor-tab.tsx',
      'src/components/game/trading-floor/format.ts',
    ];
    // In-page anchors like href="#clawpump-templates" are not hex colours, so
    // the pattern must keep requiring 3 to 8 HEX digits and a word boundary.
    for (const file of files) expect(read(file)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('Trader column structure', () => {
  test('capability gates header, podium, table and legend', () => {
    const source = read('src/app/leaderboard/page.tsx');
    expect(source).toMatch(/typeof body\.agents\[0\]\?\.breakdown\?\.trades_verified === 'number'/);
    expect(source.match(/hasTradeBreakdown/g)?.length ?? 0).toBeGreaterThan(10);
    expect(source).toContain("import { operatorLabel } from '@/components/game/trading-floor/format'");
    expect(source.match(/const label = operatorLabel\(/g)).toHaveLength(2);
    expect(source.match(/\{label \? \(/g)).toHaveLength(3);
  });

  test('mobile table is two rows and desktop has six tracks', () => {
    const source = read('src/app/leaderboard/page.tsx');
    expect(source).toContain("grid-cols-[48px_1fr_110px_88px_110px_28px]");
    expect(source).toContain("'flex min-h-11 w-full flex-col gap-2");
    expect(source).toContain('justify-end gap-5');
  });
});
