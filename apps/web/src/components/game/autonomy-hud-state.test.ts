import { describe, expect, test } from 'bun:test';
import type { AutonomyStatusResponse, AutonomyStatusThought } from '@clawville/shared';
import {
  countAutonomyArrivals,
  formatAutonomyPhase,
  selectCurrentAutonomyStatus,
  shouldStartAutonomyElapsed,
} from './autonomy-hud-state';

const enrolled = (
  phase: Extract<AutonomyStatusResponse, { enrolled: true }>['phase'],
  targetLabel: string | null = 'the Cove',
): Extract<AutonomyStatusResponse, { enrolled: true }> => ({
  enrolled: true,
  phase,
  targetBuildingId: 'cove',
  targetLabel,
  bodyId: 'ocb-public-body',
  phaseSince: 1,
  thoughts: [],
  wallet: null,
});

describe('AutonomyHUD server-state presentation', () => {
  test('maps every driver phase without inventing client activity', () => {
    expect(formatAutonomyPhase(enrolled('deciding'), false)).toBe('Thinking…');
    expect(formatAutonomyPhase(enrolled('walking'), false)).toBe('Traveling');
    expect(formatAutonomyPhase(enrolled('arrived'), false)).toBe('At the Cove');
    expect(formatAutonomyPhase(enrolled('talking', null), false)).toBe('At destination');
  });

  test('renders honest connection and enrollment gaps', () => {
    expect(formatAutonomyPhase({ enrolled: false }, false)).toBe('Reconnecting…');
    expect(formatAutonomyPhase(undefined, false)).toBe('Connecting…');
    expect(formatAutonomyPhase(undefined, true)).toBe('Connection interrupted…');
    expect(formatAutonomyPhase(enrolled('walking'), true)).toBe('Connection interrupted…');
  });

  test('rejects cached status from an earlier Autonomous session', () => {
    const cached = enrolled('walking');
    expect(selectCurrentAutonomyStatus(cached, 99, 100)).toBeUndefined();
    expect(selectCurrentAutonomyStatus(cached, 100, 100)).toBe(cached);
    expect(selectCurrentAutonomyStatus(cached, 101, null)).toBeUndefined();
  });

  test('starts elapsed time only on the first live enrolled response', () => {
    expect(shouldStartAutonomyElapsed(undefined, false, null)).toBe(false);
    expect(shouldStartAutonomyElapsed({ enrolled: false }, false, null)).toBe(false);
    expect(shouldStartAutonomyElapsed(enrolled('deciding'), true, null)).toBe(false);
    expect(shouldStartAutonomyElapsed(enrolled('deciding'), false, null)).toBe(true);
    expect(shouldStartAutonomyElapsed(enrolled('deciding'), false, 100)).toBe(false);
  });

  test('derives arrival count from server thoughts only', () => {
    const thoughts: AutonomyStatusThought[] = [
      { at: 1, type: 'decision', text: 'Heading to the Cove' },
      { at: 2, type: 'arrival', text: 'Arrived at the Cove' },
      { at: 3, type: 'directive', text: 'Directive: "play cards"' },
      { at: 4, type: 'arrival', text: 'Arrived at Nori' },
    ];
    expect(countAutonomyArrivals(thoughts)).toBe(2);
  });
});
