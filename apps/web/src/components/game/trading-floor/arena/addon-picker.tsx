'use client';

import { useId } from 'react';
import {
  FLOOR_ARENA_DEFAULT_ADDON_DAILY_CAP_USD,
  FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD,
} from '@clawville/shared';

import type { FloorArenaAddonView } from '@/hooks/use-floor-arena';
import { FLOOR_TEXT } from '../tokens';
import { formatDuration } from './arena-format';
import { ArenaMuted, arenaInnerCardStyle, arenaInputStyle } from './arena-kit';

export const ADDON_WALLET_WARNING =
  "Your agent's wallet pays only for its own paid data add-ons, in USDC. ClawVille does not refund add-on spend.";

/**
 * Shown under the agent's wallet address wherever a player can copy it. The
 * wallet is a ClawPump agent under ClawVille's own account (spec D8) and no
 * route moves funds back out of it, so unspent USDC stays there: the player
 * must hear that BEFORE sending (audit-money M3). Mirrored in manual §17c.
 */
export const ARENA_WALLET_NO_WITHDRAW =
  `Send only USDC on Solana. You cannot withdraw USDC from this wallet in ClawVille, so send only what your ` +
  `add-ons will spend (at most $${FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD} a day).`;

/**
 * Both wallet warnings together: what the USDC is for and that it cannot come
 * back out. Rendered wherever the wallet address or the add-on funding shows
 * (launch step 3, the launch success screen, the desk's add-on editor and its
 * Wallet block), so the player reads them before sending anything.
 */
export function ArenaWalletWarnings() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="arena-wallet-warnings">
      <div style={{ color: FLOOR_TEXT.warning, fontSize: 12 }} data-testid="arena-wallet-no-withdraw">
        {ARENA_WALLET_NO_WITHDRAW}
      </div>
      <div style={{ color: FLOOR_TEXT.warning, fontSize: 12 }}>{ADDON_WALLET_WARNING}</div>
    </div>
  );
}

/** One add-on's choice: on or off, and its own daily cap in USD. */
export interface AddonChoice {
  enabled: boolean;
  capUsd: number;
}

export type AddonChoices = Readonly<Record<string, AddonChoice>>;

/** Most an add-on can cost in a day at its fastest allowed poll. */
export function addonMaxCostPerDay(addon: Pick<FloorArenaAddonView, 'priceUsd' | 'minIntervalS'>): number {
  return addon.priceUsd * Math.floor(86_400 / addon.minIntervalS);
}

/** The caps of the add-ons that are ON, added up. The route refuses a total above the agent maximum. */
export function enabledCapTotal(choices: AddonChoices): number {
  return Object.values(choices).reduce((sum, choice) => sum + (choice.enabled ? choice.capUsd : 0), 0);
}

/** True when every ON cap is a valid amount and together they fit the agent maximum. */
export function addonChoicesValid(choices: AddonChoices): boolean {
  const on = Object.values(choices).filter((choice) => choice.enabled);
  if (on.some((choice) => !Number.isFinite(choice.capUsd) || choice.capUsd < 0)) return false;
  return enabledCapTotal(choices) <= FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD + 1e-9;
}

export function defaultAddonChoice(): AddonChoice {
  return { enabled: false, capUsd: FLOOR_ARENA_DEFAULT_ADDON_DAILY_CAP_USD };
}

function usd(value: number): string {
  return value < 0.01 && value > 0 ? `$${value.toPrecision(2)}` : `$${value.toFixed(2)}`;
}

/**
 * Paid discovery add-ons: one checkbox and one daily cap per add-on. The caps
 * of the add-ons that are on may add up to at most the agent maximum
 * (FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD), the same rule the route enforces.
 * Used by launch step 3 and by the desk panel.
 */
export function AddonPicker({
  catalog,
  paymentsEnabled,
  isLoading,
  isError,
  choices,
  onChange,
  disabled = false,
}: {
  catalog: readonly FloorArenaAddonView[];
  paymentsEnabled: boolean;
  isLoading: boolean;
  isError: boolean;
  choices: AddonChoices;
  onChange: (id: string, next: AddonChoice) => void;
  disabled?: boolean;
}) {
  const baseId = useId();
  if (isLoading) return <ArenaMuted>Loading the add-on list...</ArenaMuted>;
  if (isError) return <ArenaMuted>The add-on list is unavailable right now. You can add them later from your desk.</ArenaMuted>;
  if (catalog.length === 0) {
    return (
      <ArenaMuted>
        No paid add-ons are available yet. Your agent reads the shared free discovery feed, like every arena agent.
      </ArenaMuted>
    );
  }
  const total = enabledCapTotal(choices);
  const anyOn = catalog.some((addon) => choices[addon.id]?.enabled);
  const overTotal = total > FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD + 1e-9;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="arena-addon-picker">
      <ArenaMuted>
        Every arena agent reads one shared free discovery feed. A paid add-on is an extra feed only your agent sees.
      </ArenaMuted>
      {!paymentsEnabled ? (
        <div style={{ color: FLOOR_TEXT.warning, fontSize: 12 }}>
          Add-on payments are switched off on the server right now. Your choice is saved, and nothing is bought until
          they switch on.
        </div>
      ) : null}
      {catalog.map((addon) => {
        const choice = choices[addon.id] ?? defaultAddonChoice();
        const checkId = `${baseId}-check-${addon.id}`;
        const capId = `${baseId}-cap-${addon.id}`;
        const capInvalid = choice.enabled && (!Number.isFinite(choice.capUsd) || choice.capUsd < 0);
        return (
          <div key={addon.id} style={arenaInnerCardStyle} data-testid={`arena-addon-${addon.id}`}>
            <label htmlFor={checkId} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: disabled ? 'default' : 'pointer' }}>
              <input
                id={checkId}
                type="checkbox"
                checked={choice.enabled}
                disabled={disabled}
                onChange={(event) => onChange(addon.id, { ...choice, enabled: event.target.checked })}
                style={{ width: 22, height: 22, marginTop: 11, flexShrink: 0 }}
              />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minHeight: 44 }}>
                <span style={{ color: FLOOR_TEXT.value, fontSize: 13, fontWeight: 700 }}>
                  {addon.name}
                  {addon.vendor ? <span style={{ color: FLOOR_TEXT.muted, fontWeight: 400 }}> by {addon.vendor}</span> : null}
                </span>
                <span style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>
                  {usd(addon.priceUsd)} per call · at most every {formatDuration(addon.minIntervalS)} · up to{' '}
                  {usd(addonMaxCostPerDay(addon))} a day before your cap
                </span>
                {addon.note ? <span style={{ color: FLOOR_TEXT.faint, fontSize: 11 }}>{addon.note}</span> : null}
              </span>
            </label>
            {choice.enabled ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 240 }}>
                <label htmlFor={capId} style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>
                  Daily cap for this add-on (USD)
                </label>
                <input
                  id={capId}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD}
                  step={0.5}
                  value={Number.isFinite(choice.capUsd) ? choice.capUsd : ''}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(addon.id, {
                      ...choice,
                      capUsd: event.target.value.trim() === '' ? Number.NaN : Number(event.target.value),
                    })
                  }
                  style={arenaInputStyle}
                />
                {capInvalid ? (
                  <div role="alert" style={{ color: FLOOR_TEXT.danger, fontSize: 11 }}>
                    Enter an amount of $0 or more.
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {anyOn ? (
        <div style={{ color: overTotal ? FLOOR_TEXT.danger : FLOOR_TEXT.muted, fontSize: 12 }} role={overTotal ? 'alert' : undefined}>
          Daily caps together: ${Number.isFinite(total) ? total.toFixed(2) : 'n/a'} of at most $
          {FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD.toFixed(2)}.
          {overTotal ? ' Lower a cap or turn an add-on off.' : ''}
        </div>
      ) : null}
      <ArenaWalletWarnings />
    </div>
  );
}
