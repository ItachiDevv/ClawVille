/**
 * Token Economy tab — renders the canonical scoring + reward + bundle config
 * from shared constants + live DexScreener price for $CLAWVILLE.
 *
 * No new API needed; reads constants directly + one outbound DexScreener call
 * on render (5-min cache via Next fetch revalidate).
 */

import { cookies } from 'next/headers';
import { TUTORIAL_QUEST_REWARDS, TUTORIAL_QUEST_TOTAL_REWARD } from '@clawville/shared';

interface EconomyData {
  fingerprintCoverage24h: { total: number; withFp: number; pct: number };
  tokenFlow30d: { reason: string; credits: number; debits: number; totalTx: number }[];
  dailyLogin: { lifetimeCt: number; lifetimeClaims: number; last24hClaims: number };
  generatedAt: string;
}

async function fetchEconomy(): Promise<EconomyData | null> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? '';
  if (!apiBase) return null;
  const cookieStore = await cookies();
  try {
    const res = await fetch(`${apiBase}/api/dashboard/economy`, {
      headers: { cookie: cookieStore.toString() },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as EconomyData;
  } catch {
    return null;
  }
}

const CLV_MINT = 'Epht7Fw4Sgh6fdcJj6afWXuNcAUmLLMc3MSthUqELiZA';

// Mirror of apps/api/src/routes/leaderboard.ts AGENT_SCORE_WEIGHTS — the
// dashboard cannot import from apps/api directly, so we duplicate. Both are
// referenced in CLAUDE.md Brand Identity §Priority #3, which is the single
// source-of-truth contract.
const AGENT_SCORE_WEIGHTS = {
  buildingVisit: 3,
  teacherChat: 10,
  collaboration: 40,
  skillFetch: 1,
  session: 1,
  identityIssued: 5,
} as const;

const ACTIVITY_PLACEMENT_WEIGHTS = {
  '1st': 12,
  '2nd': 6,
  '3rd': 3,
  default: 1,
} as const;

const DAILY_CAPS = {
  buildingVisit: 10,
  teacherChat: 50,
  collaboration: 50,
  skillFetch: 11,
  activity: 10,
} as const;

// Q3 plan §0 L21 — locked CT bundle structure.
const CT_BUNDLES = [
  { tier: 'Starter', ct: 500,  usd: 4.99,  perCt: 0.0100 },
  { tier: 'Popular', ct: 1200, usd: 9.99,  perCt: 0.0083 },
  { tier: 'Big',     ct: 3500, usd: 20,    perCt: 0.0057 },
  { tier: 'Whale',   ct: 8000, usd: 30,    perCt: 0.0038 },
];

interface DexScreenerPair {
  priceUsd?: string;
  priceChange?: { h24?: number };
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  fdv?: number;
}

async function fetchClvPrice(): Promise<DexScreenerPair | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${CLV_MINT}`,
      { next: { revalidate: 300 } }, // 5-min cache
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { pairs?: DexScreenerPair[] };
    return json.pairs?.[0] ?? null;
  } catch {
    return null;
  }
}

export default async function TokenEconomyTab() {
  const [clv, econ] = await Promise.all([fetchClvPrice(), fetchEconomy()]);

  return (
    <div className="space-y-10">
      {/* ANTI-FARM FINGERPRINT COVERAGE */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">Anti-farm coverage (last 24h)</h2>
        <p className="mb-3 text-xs font-mono text-slate-500">
          Phase 1 §2.1-2.4 · every event row should carry sha256-salted{' '}
          <code>fp_hash</code> + <code>ip_prefix_hash</code>. Coverage gaps =
          emitter sites still using plain <code>logEvent()</code> instead of{' '}
          <code>logEventFromContext(c, ...)</code>.
        </p>
        {econ ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <MiniStat
              label="fp_hash coverage"
              value={`${econ.fingerprintCoverage24h.pct}%`}
              delta={econ.fingerprintCoverage24h.pct >= 95 ? 0.01 : -0.01}
            />
            <MiniStat
              label="Events 24h"
              value={econ.fingerprintCoverage24h.total.toLocaleString()}
            />
            <MiniStat
              label="With fp_hash"
              value={econ.fingerprintCoverage24h.withFp.toLocaleString()}
            />
          </div>
        ) : (
          <div className="rounded border border-slate-700/50 bg-slate-900/30 p-3 text-xs text-slate-400">
            Live coverage unavailable.
          </div>
        )}
      </section>

      {/* CT FLOW (sources + sinks) */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">ClawToken flow (last 30d)</h2>
        <p className="mb-3 text-xs font-mono text-slate-500">
          From <code>claw_token_transactions</code> grouped by{' '}
          <code>reason</code>. Credits = tokens entering the economy
          (daily-login, chat rewards, quest completions, tutorial claims,
          activity matches). Debits = tokens leaving (book purchases,
          paused-marketplace ledger entries).
        </p>
        {econ && econ.tokenFlow30d.length > 0 ? (
          <Table
            head={['Reason', 'Credits (CT in)', 'Debits (CT out)', 'Tx count']}
            rows={econ.tokenFlow30d.map((r) => [
              r.reason,
              r.credits > 0 ? `+${r.credits.toLocaleString()}` : '—',
              r.debits > 0 ? `-${r.debits.toLocaleString()}` : '—',
              r.totalTx.toLocaleString(),
            ])}
          />
        ) : (
          <div className="rounded border border-slate-700/50 bg-slate-900/30 p-3 text-xs text-slate-400">
            No CT transactions in the last 30 days.
          </div>
        )}
      </section>

      {/* DAILY LOGIN */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">Daily login</h2>
        <p className="mb-3 text-xs font-mono text-slate-500">
          Streak formula: <code>10 + streak × 5</code>, capped at{' '}
          <code>100 CT/day</code>. Resets on missed day.
          POST <code>/api/avatars/me/daily-login</code>.
        </p>
        {econ ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <MiniStat label="Lifetime CT issued" value={econ.dailyLogin.lifetimeCt.toLocaleString()} />
            <MiniStat label="Lifetime claims" value={econ.dailyLogin.lifetimeClaims.toLocaleString()} />
            <MiniStat label="Last 24h claims" value={econ.dailyLogin.last24hClaims.toLocaleString()} />
          </div>
        ) : null}
      </section>

      {/* SCORE WEIGHTS */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">Leaderboard score weights</h2>
        <p className="mb-3 text-xs font-mono text-slate-500">
          Q3 plan §2.4 rebalance · keep in sync with{' '}
          <code>apps/api/src/routes/leaderboard.ts</code>{' '}
          <code>AGENT_SCORE_WEIGHTS</code> + <code>ACTIVITY_PLACEMENT_WEIGHTS</code>
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <Table
            head={['Event', 'Weight (pts)', 'Daily cap']}
            rows={[
              ['building.visited',          AGENT_SCORE_WEIGHTS.buildingVisit, DAILY_CAPS.buildingVisit],
              ['agent.chat.turn',           AGENT_SCORE_WEIGHTS.teacherChat,   DAILY_CAPS.teacherChat],
              ['agent.collaboration.turn',  AGENT_SCORE_WEIGHTS.collaboration, DAILY_CAPS.collaboration],
              ['skill_md.fetched',          AGENT_SCORE_WEIGHTS.skillFetch,    DAILY_CAPS.skillFetch],
              ['agent.connected (DISTINCT session)', AGENT_SCORE_WEIGHTS.session, '—'],
              ['identity.issued (one-shot)', AGENT_SCORE_WEIGHTS.identityIssued, '—'],
            ]}
          />
          <Table
            head={['Activity placement', 'Weight (pts)']}
            rows={[
              ['1st place',           ACTIVITY_PLACEMENT_WEIGHTS['1st']],
              ['2nd place',           ACTIVITY_PLACEMENT_WEIGHTS['2nd']],
              ['3rd place',           ACTIVITY_PLACEMENT_WEIGHTS['3rd']],
              ['4th+ (participation)', ACTIVITY_PLACEMENT_WEIGHTS.default],
              ['Daily cap (total)',   DAILY_CAPS.activity],
            ]}
          />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Per-tier weighting preserved under daily cap via proportional scaling:{' '}
          <code>(wins×12 + silver×6 + bronze×3 + other×1) × LEAST(total, 10) / total</code>
        </p>
      </section>

      {/* CT BUNDLES */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">ClawToken bundles (planned, Phase 4)</h2>
        <p className="mb-3 text-xs font-mono text-slate-500">
          Q3 plan §0 L21 · paying with $CLAWVILLE = +25% bonus on any tier
        </p>
        <Table
          head={['Tier', 'CT', 'USD', '$/CT', 'vs Starter', 'CT @ +25% $CLAWVILLE']}
          rows={CT_BUNDLES.map((b) => [
            b.tier,
            b.ct.toLocaleString(),
            `$${b.usd}`,
            `$${b.perCt.toFixed(4)}`,
            b.tier === 'Starter' ? '—' : `${Math.round(((b.perCt - CT_BUNDLES[0].perCt) / CT_BUNDLES[0].perCt) * 100)}%`,
            `${Math.round(b.ct * 1.25).toLocaleString()} CT`,
          ])}
        />
      </section>

      {/* TUTORIAL QUEST REWARDS */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">Tutorial quest rewards</h2>
        <p className="mb-3 text-xs font-mono text-slate-500">
          From <code>@clawville/shared</code> <code>TUTORIAL_QUEST_REWARDS</code> · server-credited via POST /api/quests/tutorial/:id/claim · total {TUTORIAL_QUEST_TOTAL_REWARD} CT
        </p>
        <Table
          head={['Quest ID', 'Reward (CT)']}
          rows={Object.entries(TUTORIAL_QUEST_REWARDS).map(([id, ct]) => [id, ct])}
        />
      </section>

      {/* $CLAWVILLE LIVE */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">$CLAWVILLE — live market</h2>
        <p className="mb-3 text-xs font-mono text-slate-500">
          Mint <code>{CLV_MINT}</code> · Token-2022 · 6 decimals · supply ~999.98M (fixed) · DexScreener 5-min cache
        </p>
        {clv ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <MiniStat label="Price (USD)" value={`$${Number(clv.priceUsd ?? 0).toFixed(8)}`} />
            <MiniStat label="24h change" value={`${(clv.priceChange?.h24 ?? 0).toFixed(2)}%`} delta={clv.priceChange?.h24} />
            <MiniStat label="Liquidity" value={`$${Math.round(clv.liquidity?.usd ?? 0).toLocaleString()}`} />
            <MiniStat label="24h volume" value={`$${Math.round(clv.volume?.h24 ?? 0).toLocaleString()}`} />
          </div>
        ) : (
          <div className="rounded border border-slate-700/50 bg-slate-800/30 p-4 text-sm text-slate-400">
            DexScreener returned no pair data. Check mint or rate limits.
          </div>
        )}
      </section>

      {/* TREASURY */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">Treasury wallets (Phase 5 prep)</h2>
        <p className="mb-3 text-xs font-mono text-slate-500">
          Set <code>CLV_INBOUND_TREASURY_PUBKEY</code> + <code>CLV_PAYOUT_RESERVE_PUBKEY</code> env vars to populate.
        </p>
        <Table
          head={['Wallet', 'Pubkey', 'Role']}
          rows={[
            [
              'Inbound treasury',
              process.env.CLV_INBOUND_TREASURY_PUBKEY ?? '— not set —',
              'Receives $CLAWVILLE from user top-ups (held, never spent)',
            ],
            [
              'Payout reserve',
              process.env.CLV_PAYOUT_RESERVE_PUBKEY ?? '— not set —',
              'Sends $CLAWVILLE payouts to top-ranked agents (Phase 5)',
            ],
          ]}
        />
      </section>
    </div>
  );
}

// ─── tiny helpers (no shared component lib for one-off table) ──────────────

function Table({
  head,
  rows,
}: {
  head: (string | number)[];
  rows: (string | number)[][];
}) {
  return (
    <div className="overflow-x-auto rounded border border-slate-700/50 bg-slate-900/30">
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-700/50 bg-slate-800/40">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-slate-300">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-slate-700/30 last:border-0">
              {r.map((c, j) => (
                <td key={j} className="px-3 py-2 font-mono text-xs text-slate-200">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MiniStat({ label, value, delta }: { label: string; value: string; delta?: number }) {
  const tone =
    delta == null ? 'text-slate-200' : delta >= 0 ? 'text-emerald-300' : 'text-red-300';
  return (
    <div className="rounded border border-slate-700/50 bg-slate-900/30 p-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-400">{label}</div>
      <div className={`mt-1 font-mono text-base font-semibold ${tone}`}>{value}</div>
    </div>
  );
}
