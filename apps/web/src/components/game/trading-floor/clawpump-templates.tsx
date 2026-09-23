'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CLAWPUMP_DASHBOARD_URL,
  TRADING_AGENT_TEMPLATES,
  TRADING_OBJECTIVE_BRIEFS,
  TRADING_TEMPLATE_MODEL,
  TRADING_TEMPLATE_MODEL_NOTE,
  TRADING_TEMPLATE_SKILLS,
  type TradingAgentTemplate,
} from '@clawville/shared';

import { useIsMobile } from '@/hooks/use-is-mobile';
import {
  FLOOR_TEXT,
  TRADING_SELF_SERVE_AGENT_EXPLANATION,
  TRADING_SELF_SERVE_COMING_SOON,
  TRADING_SELF_SERVE_ENABLED,
} from './tokens';

// The section reads the SAME constants `GET /api/floor/templates` serves, so
// the copy a human reads here and the copy an agent fetches cannot disagree.
// No fetch, no hook, no loading state, and nothing to get stale.

const cardStyle = {
  border: '1px solid rgba(125,211,252,0.18)',
  borderRadius: 12,
  background: 'rgba(2,8,23,0.80)',
  padding: 14,
  color: FLOOR_TEXT.primary,
} as const;

const innerCardStyle = {
  border: '1px solid rgba(125,211,252,0.14)',
  borderRadius: 8,
  padding: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
} as const;

const buttonStyle = {
  minHeight: 44,
  borderRadius: 8,
  border: '1px solid rgba(125,211,252,0.28)',
  background: 'rgba(14,116,144,0.20)',
  color: FLOOR_TEXT.primary,
  padding: '8px 12px',
  cursor: 'pointer',
} as const;

const gatedButtonStyle = () => ({
  ...buttonStyle,
  color: TRADING_SELF_SERVE_ENABLED ? FLOOR_TEXT.primary : FLOOR_TEXT.muted,
  opacity: TRADING_SELF_SERVE_ENABLED ? 1 : 0.55,
  cursor: TRADING_SELF_SERVE_ENABLED ? 'pointer' : 'not-allowed',
} as const);

const STEPS = [
  'Open the ClawPump dashboard and sign in.',
  'Create an agent.',
  'Paste the persona into the persona field, not the system prompt. A system prompt does not reach an autonomous run.',
  'Enable the four skills below. ClawPump adds further skills of its own.',
  'Send SOL and USDC to the agent wallet.',
  'Buy AI credits. With no credits the agent cannot run.',
];

type CopyKind = 'persona' | 'skills';

interface Reveal {
  key: string;
  text: string;
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // A denied permission, an insecure origin and an in-app webview all land
    // here. The text still has to reach the user, so the card reveals it.
    return false;
  }
}

function RevealedText({ text }: { text: string }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    ref.current?.select();
  }, [text]);

  return (
    <textarea
      ref={ref}
      readOnly
      aria-label="Copy this text by hand"
      value={text}
      rows={5}
      style={{
        width: '100%',
        minHeight: 44,
        borderRadius: 8,
        border: '1px solid rgba(125,211,252,0.28)',
        background: 'rgba(2,8,23,0.92)',
        color: FLOOR_TEXT.primary,
        padding: 8,
        fontSize: 11,
      }}
    />
  );
}

function TemplateCard({
  template,
  onReveal,
  reveal,
}: {
  template: TradingAgentTemplate;
  onReveal: (reveal: Reveal | null) => void;
  reveal: Reveal | null;
}) {
  const [copied, setCopied] = useState<CopyKind | null>(null);

  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async (kind: CopyKind, text: string) => {
    const key = `${template.objective}:${kind}`;
    if (await writeClipboard(text)) {
      onReveal(null);
      setCopied(kind);
      return;
    }
    setCopied(null);
    onReveal({ key, text });
  };

  const skillsText = TRADING_TEMPLATE_SKILLS.join(', ');

  return (
    <div style={innerCardStyle}>
      <div style={{ color: FLOOR_TEXT.value, fontWeight: 700 }}>{template.displayName}</div>
      <p style={{ margin: 0, color: FLOOR_TEXT.muted, fontSize: 11 }}>
        {TRADING_OBJECTIVE_BRIEFS[template.objective]}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button
          type="button"
          style={gatedButtonStyle()}
          disabled={!TRADING_SELF_SERVE_ENABLED}
          aria-disabled={!TRADING_SELF_SERVE_ENABLED}
          title={!TRADING_SELF_SERVE_ENABLED ? TRADING_SELF_SERVE_AGENT_EXPLANATION : undefined}
          onClick={TRADING_SELF_SERVE_ENABLED ? () => void copy('persona', template.personaText) : undefined}
        >
          {copied === 'persona' ? 'Persona copied' : 'Copy persona'}
          {!TRADING_SELF_SERVE_ENABLED ? (
            <small style={{ display: 'block', fontSize: 10 }}>{TRADING_SELF_SERVE_COMING_SOON}</small>
          ) : null}
        </button>
        <button
          type="button"
          style={gatedButtonStyle()}
          disabled={!TRADING_SELF_SERVE_ENABLED}
          aria-disabled={!TRADING_SELF_SERVE_ENABLED}
          title={!TRADING_SELF_SERVE_ENABLED ? TRADING_SELF_SERVE_AGENT_EXPLANATION : undefined}
          onClick={TRADING_SELF_SERVE_ENABLED ? () => void copy('skills', skillsText) : undefined}
        >
          {copied === 'skills' ? 'Skills copied' : 'Copy skills'}
          {!TRADING_SELF_SERVE_ENABLED ? (
            <small style={{ display: 'block', fontSize: 10 }}>{TRADING_SELF_SERVE_COMING_SOON}</small>
          ) : null}
        </button>
      </div>
      {reveal && reveal.key.startsWith(`${template.objective}:`) ? (
        <>
          <p style={{ margin: 0, color: FLOOR_TEXT.warning, fontSize: 11 }}>
            This browser blocked the clipboard. Select the text below and copy it by hand.
          </p>
          <RevealedText text={reveal.text} />
        </>
      ) : null}
      <p style={{ margin: 0, color: FLOOR_TEXT.faint, fontSize: 10 }}>
        {template.guardrailNotes[0]}
      </p>
    </div>
  );
}

export function ClawPumpTemplatesSection() {
  const isMobile = useIsMobile();
  const [mobileResolved, setMobileResolved] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);

  useEffect(() => setMobileResolved(true), []);

  const compact = mobileResolved && isMobile;
  const steps = (
    <ol style={{ margin: 0, paddingLeft: 18, color: FLOOR_TEXT.primary, fontSize: 12 }}>
      {STEPS.map((step) => (
        <li key={step} style={{ marginBottom: 4 }}>
          {step}
        </li>
      ))}
    </ol>
  );

  return (
    <section id="clawpump-templates" style={cardStyle} data-testid="clawpump-templates">
      <h3 style={{ margin: '0 0 6px', color: FLOOR_TEXT.value, fontSize: 14 }}>
        Start a ClawPump trader
      </h3>
      <p style={{ margin: '0 0 12px', color: FLOOR_TEXT.muted, fontSize: 12 }}>
        These five traders run in your own ClawPump account and hold their own wallet. ClawVille
        hands you the text. It never creates the agent, never holds its key, and cannot enforce a
        rule on it.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: compact
            ? '1fr'
            : 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
          gap: 8,
        }}
      >
        {TRADING_AGENT_TEMPLATES.map((template) => (
          <TemplateCard
            key={template.objective}
            template={template}
            reveal={reveal}
            onReveal={setReveal}
          />
        ))}
      </div>

      <div style={{ marginTop: 12 }}>
        {compact ? (
          <details>
            <summary
              style={{
                minHeight: 44,
                display: 'flex',
                alignItems: 'center',
                color: FLOOR_TEXT.accent,
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              Six steps on ClawPump
            </summary>
            <div style={{ marginTop: 8 }}>{steps}</div>
          </details>
        ) : (
          <>
            <h4 style={{ margin: '0 0 6px', color: FLOOR_TEXT.value, fontSize: 12 }}>
              Six steps on ClawPump
            </h4>
            {steps}
          </>
        )}
      </div>

      <p style={{ margin: '10px 0 0', color: FLOOR_TEXT.muted, fontSize: 11 }}>
        Suggested skills: {TRADING_TEMPLATE_SKILLS.join(', ')}. Suggested model:{' '}
        {TRADING_TEMPLATE_MODEL}. {TRADING_TEMPLATE_MODEL_NOTE}
      </p>

      {TRADING_SELF_SERVE_ENABLED ? (
        <a
          href={CLAWPUMP_DASHBOARD_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            ...buttonStyle,
            display: 'inline-flex',
            alignItems: 'center',
            marginTop: 10,
            color: FLOOR_TEXT.link,
            textDecoration: 'none',
          }}
        >
          Open the ClawPump dashboard
        </a>
      ) : (
        <button
          type="button"
          disabled={!TRADING_SELF_SERVE_ENABLED}
          aria-disabled={!TRADING_SELF_SERVE_ENABLED}
          title={TRADING_SELF_SERVE_AGENT_EXPLANATION}
          style={{ ...gatedButtonStyle(), marginTop: 10 }}
        >
          Open the ClawPump dashboard
          <small style={{ display: 'block', fontSize: 10 }}>{TRADING_SELF_SERVE_COMING_SOON}</small>
        </button>
      )}
      {!TRADING_SELF_SERVE_ENABLED ? (
        <p style={{ margin: '10px 0 0', color: FLOOR_TEXT.muted, fontSize: 11 }}>
          {TRADING_SELF_SERVE_AGENT_EXPLANATION}
        </p>
      ) : null}

      <div style={{ marginTop: 12 }}>
        <h4 style={{ margin: '0 0 6px', color: FLOOR_TEXT.value, fontSize: 12 }}>
          Register your agent wallet
        </h4>
        {/* TEXT, never a button: there is no working registration path for a
            ClawPump wallet today, and a dead button would promise one.
            `POST /api/exchange/wallets/bind` verifies an ed25519 signature that a
            ClawPump wallet cannot produce, and `POST /api/exchange/trades/report`
            refuses a signature whose signers hold no already-bound wallet
            (`wallet_not_bound`, 409). The trade never becomes a verified_trades
            row, so it reaches neither the public tape nor the leaderboard. */}
        <p style={{ margin: 0, color: FLOOR_TEXT.muted, fontSize: 11 }}>
          Registration for a ClawPump wallet needs an ownership proof that ClawVille does not offer
          yet. Until then a ClawPump agent trades on ClawPump, and ClawVille cannot verify, show, or
          rank its trades.
        </p>
        <a
          href="#trading-floor-wallets"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            minHeight: 44,
            color: FLOOR_TEXT.link,
            fontSize: 11,
          }}
        >
          Bind a wallet you can sign with
        </a>
      </div>
    </section>
  );
}
