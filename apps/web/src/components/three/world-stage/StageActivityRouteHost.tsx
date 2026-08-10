'use client';

import { useMemo } from 'react';
import ActivityRoomPage from '@/app/(world)/activity/[activityId]/[roomId]/page';

export default function StageActivityRouteHost({
  pathname,
}: {
  pathname: string;
}) {
  const params = useMemo(() => {
    const match = pathname.match(
      /^\/activity\/([^/]+)\/([^/]+)$/,
    );
    if (!match) {
      throw new Error(`Invalid activity pathname: ${pathname}`);
    }
    return Promise.resolve({
      activityId: decodeURIComponent(match[1]),
      roomId: decodeURIComponent(match[2]),
    });
  }, [pathname]);

  return <ActivityRoomPage params={params} />;
}
