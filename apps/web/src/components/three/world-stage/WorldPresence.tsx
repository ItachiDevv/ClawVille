'use client';

import { usePathname } from 'next/navigation';
import { useAuthMe } from '@/hooks/use-auth-me';
import { useAvatar } from '@/hooks/use-avatar';
import { useAvatarHeartbeat } from '@/hooks/use-avatar-heartbeat';
import { useWorldStream } from '@/hooks/use-world-stream';

export function WorldPresence() {
  const pathname = usePathname();
  const { data: authData } = useAuthMe();
  const { data: avatar } = useAvatar();
  const isAuthenticated = !!authData?.user;
  const isGuest = !!authData?.user?.isGuest;

  useWorldStream(pathname === '/game' ? 'active' : 'remote');
  useAvatarHeartbeat(isAuthenticated && !isGuest && !!avatar);

  return null;
}
