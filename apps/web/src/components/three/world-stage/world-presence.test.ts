import { describe, expect, test } from 'bun:test';
import {
  AT_ACTIVITY,
  AT_COVE_ACTIVITY,
  AT_KELP_ACTIVITY,
} from '@clawville/shared';
import { getWorldPresenceRoute } from './WorldPresence';

describe('getWorldPresenceRoute', () => {
  test('keeps the world active and tags every remote route explicitly', () => {
    expect(getWorldPresenceRoute('/game')).toEqual({
      policy: 'active',
      remoteActivity: 'idle',
      downlinkEnabled: true,
    });
    expect(getWorldPresenceRoute('/cove')).toEqual({
      policy: 'remote',
      remoteActivity: AT_COVE_ACTIVITY,
      downlinkEnabled: true,
    });
    expect(getWorldPresenceRoute('/kelp')).toEqual({
      policy: 'remote',
      remoteActivity: AT_KELP_ACTIVITY,
      downlinkEnabled: true,
    });
    expect(getWorldPresenceRoute('/activity/reef-race/room-a')).toEqual({
      policy: 'remote',
      remoteActivity: AT_ACTIVITY,
      downlinkEnabled: false,
    });
    expect(getWorldPresenceRoute('/activity/reef-race')).toEqual({
      policy: 'remote',
      remoteActivity: 'idle',
      downlinkEnabled: true,
    });
  });
});
