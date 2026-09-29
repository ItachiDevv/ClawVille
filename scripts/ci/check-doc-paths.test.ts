import { describe, expect, test } from 'bun:test';
import { diffBaseline, extractPaths } from './check-doc-paths';

describe('doc path extraction', () => {
  test('strips line, anchor, symbol, and query suffixes', () => {
    expect([...extractPaths('`apps/web/src/app/page.tsx:12#top` `docs/guide.md::section?raw=1` `branding/assets/`')].sort())
      .toEqual(['apps/web/src/app/page.tsx', 'branding/assets/', 'docs/guide.md']);
  });

  test('ignores templates, globs, spaces, and unrelated tokens', () => {
    expect([...extractPaths('`apps/a/*.ts` `docs/{name}.md` `ops/<id>/` `scripts/a...b.ts` `apps/$name.ts` `docs/my file.md` `README.md` `apps/web/src`')])
      .toEqual([]);
  });

  test('accepts each allowed root', () => {
    expect([...extractPaths('`apps/a.ts` `packages/a.ts` `scripts/a.ts` `docs/a.md` `branding/a.svg` `contracts/a.sol` `.github/a.yml` `ops/a.sh`')].sort())
      .toEqual(['.github/a.yml', 'apps/a.ts', 'branding/a.svg', 'contracts/a.sol', 'docs/a.md', 'ops/a.sh', 'packages/a.ts', 'scripts/a.ts']);
  });

  test('accepts doc-local prefixes only when given', () => {
    const source = '`assets/logos/a.svg` `graphics/b.html`';
    expect([...extractPaths(source)]).toEqual([]);
    expect([...extractPaths(source, ['assets', 'graphics'])].sort()).toEqual(['assets/logos/a.svg', 'graphics/b.html']);
  });
});

test('baseline diff reports new missing and stale entries', () => {
  const references = new Set(['doc\tnew.ts', 'doc\trepaired.ts', 'doc\told.ts']);
  const missing = new Set(['doc\tnew.ts', 'doc\told.ts']);
  const baseline = new Set(['doc\told.ts', 'doc\trepaired.ts', 'doc\tremoved.ts']);
  expect(diffBaseline(references, missing, baseline)).toEqual({
    added: ['doc\tnew.ts'],
    stale: ['doc\tremoved.ts', 'doc\trepaired.ts'],
  });
});
