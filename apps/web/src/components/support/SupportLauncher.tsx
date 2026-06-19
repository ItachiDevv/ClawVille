'use client';

/**
 * Lean support launcher — a small "Support" button that opens a modal ticket
 * form. Self-contained (owns its open state). Drop `<SupportLauncher context=…/>`
 * anywhere; the optional `context` pre-tags the ticket (page / game / eventId)
 * so the team has context without the user typing it.
 *
 * Cookie-auth via submitSupportTicket — a logged-in user or guest both work.
 * Light text on the dark panel only (the dark-text-on-dark contrast rule).
 */

import { useEffect, useState } from 'react';
import {
  submitSupportTicket,
  SUPPORT_CATEGORIES,
  type SupportCategory,
  type SupportTicketContext,
} from '@/lib/support-client';

interface Props {
  context?: SupportTicketContext;
  defaultCategory?: SupportCategory;
  /** 'pill' (inline nav button) | 'floating' (fixed bottom-right). */
  variant?: 'pill' | 'floating';
}

const CATEGORY_LABEL: Record<SupportCategory, string> = {
  bug: 'Bug / something broke',
  payment: 'Payment / ClawTokens',
  fairness: 'Game fairness',
  account: 'Account / login',
  gameplay: 'Gameplay question',
  other: 'Other',
};

export default function SupportLauncher({ context, defaultCategory = 'other', variant = 'pill' }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={variant === 'floating' ? floatingBtn() : pillBtn()}
        aria-label="Open support"
      >
        {variant === 'floating' ? '🎧 Support' : 'Support'}
      </button>
      {open && (
        <SupportModal
          context={context}
          defaultCategory={defaultCategory}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function SupportModal({
  context,
  defaultCategory,
  onClose,
}: {
  context?: SupportTicketContext;
  defaultCategory: SupportCategory;
  onClose: () => void;
}) {
  const [category, setCategory] = useState<SupportCategory>(defaultCategory);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [state, setState] = useState<{ phase: 'idle' | 'sending' | 'done'; error?: string; ticketId?: string }>({
    phase: 'idle',
  });

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function send() {
    const trimmed = message.trim();
    if (!trimmed) {
      setState({ phase: 'idle', error: 'Please describe the issue.' });
      return;
    }
    setState({ phase: 'sending' });
    try {
      const res = await submitSupportTicket({
        category,
        subject: subject.trim() || undefined,
        message: trimmed,
        context: {
          ...context,
          url: typeof window !== 'undefined' ? window.location.href.slice(0, 500) : undefined,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 400) : undefined,
        },
      });
      setState({ phase: 'done', ticketId: res.ticketId });
    } catch (err) {
      setState({ phase: 'idle', error: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div style={backdrop()} onClick={onClose} role="dialog" aria-modal="true">
      <div style={panel()} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
          <h2 style={{ color: '#7df3ff', fontSize: 18, fontWeight: 800, letterSpacing: '0.06em', margin: 0 }}>
            Get help
          </h2>
          <button type="button" onClick={onClose} style={closeBtn()} aria-label="Close">✕</button>
        </div>

        {state.phase === 'done' ? (
          <div style={{ color: '#cfe', fontSize: 14, lineHeight: 1.6 }}>
            <p style={{ margin: '10px 0' }}>✓ Ticket submitted — our team has been notified.</p>
            <p style={{ margin: '6px 0', color: 'rgba(207,238,255,0.6)', fontSize: 12 }}>
              Reference: <code style={{ color: '#7df3ff' }}>{state.ticketId}</code>
            </p>
            <button type="button" onClick={onClose} style={primaryBtn()}>Done</button>
          </div>
        ) : (
          <>
            <p style={{ color: 'rgba(207,238,255,0.65)', fontSize: 12, lineHeight: 1.5, margin: '4px 0 12px' }}>
              Tell us what happened. For a specific hand you want checked, our provably-fair verifier on the
              history page is the fastest self-serve route — but if you need a human, file here.
            </p>

            <label style={label()}>Topic</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as SupportCategory)}
              style={field()}
            >
              {SUPPORT_CATEGORIES.map((c) => (
                <option key={c} value={c} style={{ color: '#06121f' }}>{CATEGORY_LABEL[c]}</option>
              ))}
            </select>

            <label style={label()}>Subject (optional)</label>
            <input
              type="text"
              value={subject}
              maxLength={200}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Short summary"
              style={field()}
            />

            <label style={label()}>Details</label>
            <textarea
              value={message}
              maxLength={4000}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What happened? Include anything that helps us reproduce it."
              rows={5}
              style={{ ...field(), resize: 'vertical', minHeight: 96 }}
            />

            {state.error && (
              <div style={{ color: '#ff9ab0', fontSize: 12, marginTop: 8 }}>{state.error}</div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button type="button" onClick={send} disabled={state.phase === 'sending'} style={primaryBtn()}>
                {state.phase === 'sending' ? 'Sending…' : 'Send ticket'}
              </button>
              <button type="button" onClick={onClose} style={ghostBtn()}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── styles (inline, light-on-dark) ──────────────────────────────────────────

function pillBtn(): React.CSSProperties {
  return {
    color: 'rgba(0,255,224,0.8)', textDecoration: 'none', fontSize: 12,
    border: '1px solid rgba(0,255,224,0.35)', padding: '5px 11px', borderRadius: 6,
    fontFamily: 'monospace', background: 'transparent', cursor: 'pointer',
  };
}
function floatingBtn(): React.CSSProperties {
  return {
    position: 'fixed', top: 'max(14px, env(safe-area-inset-top))', right: 14, zIndex: 50,
    color: '#7df3ff', fontSize: 13, fontWeight: 700,
    border: '1px solid rgba(0,255,224,0.4)', padding: '7px 13px', borderRadius: 999,
    fontFamily: 'monospace', background: 'rgba(6,18,31,0.85)', cursor: 'pointer',
    boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
  };
}
function backdrop(): React.CSSProperties {
  return {
    position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(2,6,14,0.72)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
  };
}
function panel(): React.CSSProperties {
  return {
    width: '100%', maxWidth: 460, maxHeight: '88vh', overflowY: 'auto',
    background: 'rgba(10,22,40,0.98)', border: '1px solid rgba(0,255,224,0.22)',
    borderRadius: 14, padding: 20, boxShadow: '0 12px 48px rgba(0,0,0,0.55)',
    fontFamily: 'system-ui, sans-serif',
  };
}
function label(): React.CSSProperties {
  return { display: 'block', color: 'rgba(0,255,224,0.6)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', margin: '10px 0 4px', fontFamily: 'monospace' };
}
function field(): React.CSSProperties {
  return {
    width: '100%', boxSizing: 'border-box', padding: '9px 11px', borderRadius: 8,
    border: '1px solid rgba(0,255,224,0.2)', background: 'rgba(2,8,16,0.7)',
    color: '#e6fbff', fontSize: 14, fontFamily: 'inherit', outline: 'none',
  };
}
function primaryBtn(): React.CSSProperties {
  return {
    padding: '9px 16px', borderRadius: 8, border: '1px solid rgba(0,255,224,0.5)',
    background: 'rgba(0,255,224,0.14)', color: '#9bfff0', fontWeight: 700, fontSize: 14,
    cursor: 'pointer', fontFamily: 'inherit',
  };
}
function ghostBtn(): React.CSSProperties {
  return {
    padding: '9px 16px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)',
    background: 'transparent', color: 'rgba(230,251,255,0.7)', fontSize: 14, cursor: 'pointer', fontFamily: 'inherit',
  };
}
function closeBtn(): React.CSSProperties {
  return { background: 'transparent', border: 'none', color: 'rgba(230,251,255,0.6)', fontSize: 18, cursor: 'pointer', lineHeight: 1 };
}
