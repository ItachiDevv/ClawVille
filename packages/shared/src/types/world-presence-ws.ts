import { z } from 'zod';

/** A pose frame is ~90 bytes; 1 KiB leaves ample headroom for the JSON envelope. */
export const WORLD_PRESENCE_WS_MAX_FRAME_BYTES = 1024;

/** Full absolute world pose, matching POST /api/world/position field-for-field. */
export const worldPresencePositionFrameSchema = z.object({
  type: z.literal('presence.position'),
  x: z.number().finite(),
  y: z.number().finite(),
  dirZ: z.number().finite(),
  activity: z.string().max(32).default('idle'),
});

/** Required reply to a server presence.ping frame. */
export const worldPresencePongFrameSchema = z.object({
  type: z.literal('presence.pong'),
  serverTimeMs: z.number().finite(),
});

export const worldPresenceClientFrameSchema = z.discriminatedUnion('type', [
  worldPresencePositionFrameSchema,
  worldPresencePongFrameSchema,
]);

export type WorldPresenceClientFrame = z.infer<typeof worldPresenceClientFrameSchema>;

export type WorldPresenceErrorCode =
  | 'membership_lost'
  | 'socket_replaced'
  /** Reserved for terminal presence takeover; never emitted by this server wave. */
  | 'superseded'
  | 'bad_frame'
  | 'flood'
  /** Reserved until transport config can be reloaded without restarting. */
  | 'transport_disabled'
  | 'server_shutdown';

export type WorldPresenceServerFrame =
  | { type: 'presence.ready'; roomId: string; presenceId: string; serverTimeMs: number }
  | { type: 'presence.ping'; serverTimeMs: number }
  | { type: 'presence.error'; code: WorldPresenceErrorCode; message?: string };

/** Private RFC 6455 close codes. Control frames remain authoritative. */
export const WORLD_PRESENCE_WS_CLOSE_CODES = {
  BAD_FRAME: 4400,
  MEMBERSHIP_LOST: 4409,
  SOCKET_REPLACED: 4410,
  /** Reserved; pairs with the never-emitted `superseded` error code. */
  SUPERSEDED: 4411,
  /** Reserved; pairs with the never-emitted `transport_disabled` error code. */
  TRANSPORT_DISABLED: 4412,
  SERVER_SHUTDOWN: 4413,
  FLOOD: 4429,
} as const;

export type WorldPresenceWsCloseCode =
  (typeof WORLD_PRESENCE_WS_CLOSE_CODES)[keyof typeof WORLD_PRESENCE_WS_CLOSE_CODES];
