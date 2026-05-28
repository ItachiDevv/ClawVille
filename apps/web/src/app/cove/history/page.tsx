import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/auth';
import HistoryTable from '@/components/cove/history/HistoryTable';
import '@/styles/cove-tokens.css';

/**
 * Phase 6.7.0 — Player game history page.
 *
 * Server component: auth-gates with Lucia. Redirect to /login if not
 * authenticated. TanStack Query infinite-scroll runs client-side in
 * <HistoryTable>.
 */
export const metadata = {
  title: 'Game History — Cove',
  description: 'Your provably-fair game history at The Cove.',
};

export default async function CoveHistoryPage() {
  const { user } = await getSession();
  if (!user) {
    redirect('/login');
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background:
          'radial-gradient(ellipse at 50% 0%, rgba(0, 80, 120, 0.14) 0%, transparent 60%), ' +
          'linear-gradient(180deg, #050f18 0%, #020a0f 100%)',
        color: '#e0fff8',
        fontFamily: 'monospace',
        padding: '40px 24px',
      }}
    >
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
            marginBottom: 6,
          }}
        >
          <h1
            style={{
              color: 'var(--cv-foam, #fdf6e3)',
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              margin: 0,
              fontFamily: 'var(--cv-data)',
            }}
          >
            Game History
          </h1>
          <div style={{ display: 'flex', gap: 10 }}>
            <Link href="/cove/verify" style={navLink()}>
              Manual verifier
            </Link>
            <Link href="/cove" style={navLink()}>
              ← Back to Cove
            </Link>
          </div>
        </div>

        <p
          style={{
            color: 'rgba(224,255,248,0.45)',
            fontSize: 12,
            marginTop: 4,
            marginBottom: 20,
            fontFamily: 'monospace',
            lineHeight: 1.6,
          }}
        >
          All games are provably fair. Click any row to see the hash chain and outcome data.
          Use the <strong style={{ color: 'rgba(0,255,224,0.7)' }}>Verify</strong> button to
          replay a spin or hand locally in your browser.
        </p>

        {/* The actual table — client component */}
        <HistoryTable />
      </div>
    </div>
  );
}

function navLink(): React.CSSProperties {
  return {
    color: 'rgba(0,255,224,0.7)',
    textDecoration: 'none',
    fontSize: 12,
    border: '1px solid rgba(0,255,224,0.35)',
    padding: '6px 12px',
    borderRadius: 6,
    fontFamily: 'monospace',
    letterSpacing: '0.04em',
  };
}
