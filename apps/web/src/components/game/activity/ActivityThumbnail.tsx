'use client';

/**
 * ActivityThumbnail — 16:9 thumbnail card for an activity.
 *
 * Tries the registry's `thumbnailUrl` first; falls back to a gradient
 * placeholder with the activity title overlay if the asset 404s. This
 * keeps the lobby/portal modals presentable before art ships, and is
 * tolerant of a missing /public/images/activities/* directory in dev.
 *
 * Used by `BuildingPortalModal` (size='sm') and `ActivityLobbyModal`
 * (size='lg' as the hero image at the top of the modal).
 */

import { useState, type CSSProperties } from 'react';
import type { ActivityDefinition } from '@clawville/shared';

export type ActivityThumbnailSize = 'sm' | 'md' | 'lg';

export interface ActivityThumbnailProps {
  activity: ActivityDefinition;
  size?: ActivityThumbnailSize;
  /** Render the title overlay even if the image loaded successfully. */
  showTitleOverlay?: boolean;
  className?: string;
  style?: CSSProperties;
}

const SIZE_HEIGHT: Record<ActivityThumbnailSize, number> = {
  sm: 96,
  md: 144,
  lg: 220,
};

export default function ActivityThumbnail({
  activity,
  size = 'md',
  showTitleOverlay = false,
  className,
  style,
}: ActivityThumbnailProps) {
  const [errored, setErrored] = useState(false);
  const height = SIZE_HEIGHT[size];

  // Activity-tinted gradient — looks intentional even with no art.
  const fallbackGradient =
    activity.id === 'bumper-shells'
      ? 'linear-gradient(135deg, #1e3a8a 0%, #0e7490 50%, #f97316 100%)'
      : activity.id === 'reef-race'
        ? 'linear-gradient(135deg, #064e3b 0%, #0e7490 60%, #facc15 100%)'
        : 'linear-gradient(135deg, #1e293b 0%, #0e7490 100%)';

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        width: '100%',
        height,
        borderRadius: 8,
        overflow: 'hidden',
        border: '1px solid rgba(56, 189, 248, 0.25)',
        background: fallbackGradient,
        boxShadow: '0 0 18px rgba(0, 229, 255, 0.08) inset',
        ...style,
      }}
    >
      {!errored && activity.thumbnailUrl && (
        // Native <img> intentional — Next/Image inside a 3D-canvas page
        // pulls in its lazy-loader and adds layout-shift overhead we don't
        // need. Errors silently flip to the gradient fallback.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={activity.thumbnailUrl}
          alt={activity.title}
          onError={() => setErrored(true)}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: 0.92,
          }}
        />
      )}
      {(errored || showTitleOverlay) && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            padding: 12,
            background: errored
              ? 'linear-gradient(180deg, transparent 30%, rgba(4, 17, 30, 0.85) 100%)'
              : 'linear-gradient(180deg, transparent 60%, rgba(4, 17, 30, 0.78) 100%)',
          }}
        >
          <div
            style={{
              color: '#fff',
              fontWeight: 800,
              fontSize: size === 'lg' ? 22 : size === 'md' ? 16 : 13,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              textShadow: '0 1px 6px rgba(0, 0, 0, 0.7)',
            }}
          >
            {activity.title}
          </div>
        </div>
      )}
    </div>
  );
}
