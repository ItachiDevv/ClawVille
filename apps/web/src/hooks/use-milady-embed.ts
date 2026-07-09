'use client';

/**
 * useMiladyEmbed — detects Milady embed mode and auto-authenticates.
 *
 * When the ClawVille viewer is loaded inside a Milady host, the plugin's
 * bootstrap script sets localStorage flags before the SPA boots:
 *
 *   - clawville-embed-mode = "milady"
 *   - clawville-milady-session-id = "<sessionId from /api/agent/connect>"
 *   - clawville-milady-agent-name = "<agent display name>"
 *
 * This hook reads those flags and calls POST /api/auth/milady-session-exchange
 * to convert the agent sessionId into a Lucia auth cookie. Once the cookie is
 * set, the normal auth flow (useQuery(['auth-me'])) picks it up and the user
 * is authenticated as a "milady guest" — no login overlay, no password.
 *
 * If embed mode is not detected or the exchange fails, this hook is a no-op.
 * The regular login flow continues normally.
 */

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AUTH_ME_QUERY_KEY } from '@/hooks/use-auth-me';

interface MiladyEmbedState {
  isEmbed: boolean;
  exchanging: boolean;
  exchanged: boolean;
  agentName: string | null;
  error: string | null;
}

export function useMiladyEmbed(): MiladyEmbedState {
  const [state, setState] = useState<MiladyEmbedState>({
    isEmbed: false,
    exchanging: false,
    exchanged: false,
    agentName: null,
    error: null,
  });
  const queryClient = useQueryClient();

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const embedMode = localStorage.getItem('clawville-embed-mode');
    if (embedMode !== 'milady') return;

    const sessionId = localStorage.getItem('clawville-milady-session-id');
    const agentName = localStorage.getItem('clawville-milady-agent-name');

    if (!sessionId) {
      setState({
        isEmbed: true,
        exchanging: false,
        exchanged: false,
        agentName,
        error: 'Missing session ID in localStorage',
      });
      return;
    }

    setState({
      isEmbed: true,
      exchanging: true,
      exchanged: false,
      agentName,
      error: null,
    });

    // Exchange the Milady session for a Lucia auth cookie
    fetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/auth/milady-session-exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ sessionId }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`Exchange failed (${res.status}): ${body}`);
        }
        return res.json();
      })
      .then((data) => {
        setState({
          isEmbed: true,
          exchanging: false,
          exchanged: true,
          agentName: data.botName ?? agentName,
          error: null,
        });
        // Invalidate auth query so the page picks up the new session cookie
        queryClient.invalidateQueries({ queryKey: AUTH_ME_QUERY_KEY });
        queryClient.invalidateQueries({ queryKey: ['avatar'] });
      })
      .catch((err) => {
        console.warn('[useMiladyEmbed] Session exchange failed:', err.message);
        setState({
          isEmbed: true,
          exchanging: false,
          exchanged: false,
          agentName,
          error: err.message,
        });
      });
  }, []); // Run once on mount

  return state;
}
