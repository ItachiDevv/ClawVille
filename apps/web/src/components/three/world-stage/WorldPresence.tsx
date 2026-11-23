'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import Activity2DRecovery from '@/components/game/activity/activity-2d-recovery';
import { useWorldRendererMode } from '@/lib/world-renderer-mode';
import {
  AT_ACTIVITY,
  AT_COVE_ACTIVITY,
  AT_KELP_ACTIVITY,
} from '@clawville/shared';
import { useAuthMe } from '@/hooks/use-auth-me';
import { useAvatar } from '@/hooks/use-avatar';
import { useAvatarHeartbeat } from '@/hooks/use-avatar-heartbeat';
import { useWorldStream } from '@/hooks/use-world-stream';
import type { WorldPresencePolicy } from '@/hooks/world-stream-machine';

export interface WorldPresenceRoute {
  policy: WorldPresencePolicy;
  remoteActivity: string;
  downlinkEnabled: boolean;
}

export function getWorldPresenceRoute(pathname: string): WorldPresenceRoute {
  if (pathname === '/game') {
    return {
      policy: 'active',
      remoteActivity: 'idle',
      downlinkEnabled: true,
    };
  }
  if (pathname === '/cove') {
    return {
      policy: 'remote',
      remoteActivity: AT_COVE_ACTIVITY,
      downlinkEnabled: true,
    };
  }
  if (pathname === '/brainchain') {
    return { policy: 'remote', remoteActivity: 'idle', downlinkEnabled: true };
  }
  if (pathname === '/kelp') {
    return {
      policy: 'remote',
      remoteActivity: AT_KELP_ACTIVITY,
      downlinkEnabled: true,
    };
  }
  if (/^\/activity\/[^/]+\/[^/]+$/.test(pathname)) {
    return {
      policy: 'remote',
      remoteActivity: AT_ACTIVITY,
      downlinkEnabled: false,
    };
  }
  return {
    policy: 'remote',
    remoteActivity: 'idle',
    downlinkEnabled: true,
  };
}

export function WorldPresence() {
  const pathname = usePathname();
  const rendererMode = useWorldRendererMode();
  const presence = getWorldPresenceRoute(pathname);
  const { data: authData } = useAuthMe();
  const { data: avatar } = useAvatar();
  const isAuthenticated = !!authData?.user;
  const isGuest = !!authData?.user?.isGuest;
  const queryClient = useQueryClient();
  const generationRef = useRef(0);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  useEffect(() => queryClient.getQueryCache().subscribe(event => {
    // clearIdentityState resets canonical queries synchronously on every auth
    // transition. Invalidate old requests even if React batches the next login.
    if (event.type === 'updated' && event.query.queryKey[0] === 'auth-me' && event.query.state.data === undefined) {
      generationRef.current++;
      setSessionGeneration(generationRef.current);
    }
  }), [queryClient]);
  const userId = authData?.user?.id;
  const avatarId = avatar?.id;
  const isCurrent = useCallback(() => {
    const auth = queryClient.getQueryData<{ user?: { id: string } } | null>(['auth-me']);
    const currentAvatar = queryClient.getQueryData<{ avatar?: { id: string } | null }>(['avatar']);
    return generationRef.current === sessionGeneration && auth?.user?.id === userId && currentAvatar?.avatar?.id === avatarId;
  }, [queryClient, sessionGeneration, userId, avatarId]);

  useWorldStream(
    presence.policy,
    presence.remoteActivity,
    presence.downlinkEnabled,
  );
  useAvatarHeartbeat(isAuthenticated && !isGuest && !!avatar);

  // This component persists across game/Office navigation. Confirmed logout
  // unmounts recovery; user/avatar changes create a fresh request generation.
  const relevantRoute = pathname === '/game' || pathname === '/brainchain';
  if (!relevantRoute || rendererMode !== '2d' || !authData?.user || !avatar) return null;
  return <Activity2DRecovery key={`${authData.user.id}:${avatar.id}:${isGuest}:${sessionGeneration}`} enabled partyEligible={!isGuest} isCurrent={isCurrent} />;
}
