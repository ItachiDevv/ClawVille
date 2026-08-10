'use client';

import { usePathname } from 'next/navigation';
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
  const presence = getWorldPresenceRoute(pathname);
  const { data: authData } = useAuthMe();
  const { data: avatar } = useAvatar();
  const isAuthenticated = !!authData?.user;
  const isGuest = !!authData?.user?.isGuest;

  useWorldStream(
    presence.policy,
    presence.remoteActivity,
    presence.downlinkEnabled,
  );
  useAvatarHeartbeat(isAuthenticated && !isGuest && !!avatar);

  return null;
}
