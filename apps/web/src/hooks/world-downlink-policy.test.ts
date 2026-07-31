import { describe, expect, test } from 'bun:test';
import {
  decideWorldDownlink,
  type WorldDownlinkInput,
} from './world-downlink-policy';

const connected: WorldDownlinkInput = {
  wanted: true,
  open: true,
  pendingReopen: false,
  recoveryInFlight: false,
  hasSession: true,
  hasRoom: true,
};

describe('decideWorldDownlink', () => {
  test('closes an open source when the downlink is not wanted', () => {
    expect(
      decideWorldDownlink({ ...connected, wanted: false }),
    ).toBe('CLOSE');
  });

  test('opens a connected room when the downlink is wanted', () => {
    expect(
      decideWorldDownlink({ ...connected, open: false }),
    ).toBe('OPEN');
  });

  test('does nothing when the held source already matches intent', () => {
    expect(decideWorldDownlink(connected)).toBe('NONE');
  });

  test('closes an owed reopen even after the failed source was dropped', () => {
    expect(
      decideWorldDownlink({
        ...connected,
        wanted: false,
        open: false,
        pendingReopen: true,
      }),
    ).toBe('CLOSE');
  });

  test('does not pre-empt retry backoff', () => {
    expect(
      decideWorldDownlink({
        ...connected,
        open: false,
        pendingReopen: true,
      }),
    ).toBe('NONE');
  });

  test('does not open without a session', () => {
    expect(
      decideWorldDownlink({
        ...connected,
        open: false,
        hasSession: false,
      }),
    ).toBe('NONE');
  });

  test('does not open without a room', () => {
    expect(
      decideWorldDownlink({
        ...connected,
        open: false,
        hasRoom: false,
      }),
    ).toBe('NONE');
  });

  test('defers opening to a live recovery', () => {
    expect(
      decideWorldDownlink({
        ...connected,
        open: false,
        recoveryInFlight: true,
      }),
    ).toBe('NONE');
  });

  test('does not fold recovery into the close rule', () => {
    expect(
      decideWorldDownlink({
        ...connected,
        wanted: false,
        open: false,
        recoveryInFlight: true,
      }),
    ).toBe('NONE');
  });

  test('is idempotent after close clears the source and retry token', () => {
    expect(
      decideWorldDownlink({
        ...connected,
        wanted: false,
        open: false,
      }),
    ).toBe('NONE');
  });
});
