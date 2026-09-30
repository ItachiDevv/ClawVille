'use client';

import { useId, useMemo, useState } from 'react';
import {
  FLOOR_ARENA_CONTEST,
  FLOOR_ARENA_POSITION_USD,
  FLOOR_ARENA_TEMPLATES,
  cloneFloorArenaParams,
  diffFloorArenaParams,
  floorArenaTemplateById,
  validateFloorArenaParams,
  type FloorArenaParams,
} from '@clawville/shared';

import {
  FloorArenaApiError,
  floorArenaErrorCode,
  floorArenaErrorCopy,
  useFloorArenaAddons,
  useLaunchFloorArenaAgent,
  type FloorArenaMyAgent,
} from '@/hooks/use-floor-arena';
import { useFloorArenaUi } from '@/stores/floor-arena-ui';
import { FLOOR_TEXT } from '../tokens';
import { AddonPicker, addonChoicesValid, type AddonChoice } from './addon-picker';
import { easternTime, formatParamValue, paramPathLabel } from './arena-format';
import {
  ArenaBackButton,
  ArenaCopyField,
  ArenaHardRules,
  ArenaMuted,
  ArenaPill,
  ArenaStickyFooter,
  arenaButtonStyle,
  arenaCardStyle,
  arenaInnerCardStyle,
  arenaInputStyle,
  arenaPrimaryButtonStyle,
} from './arena-kit';
import { ArenaParamsForm } from './arena-params-form';

type Step = 1 | 2 | 3 | 4;

const STEP_TITLES: Record<Step, string> = {
  1: 'Pick a template',
  2: 'Set the rules',
  3: 'Paid add-ons (optional)',
  4: 'Review and launch',
};

const NAME_MAX = 32;
/** The route's own name rule (`floor-arena.ts` NAME): letters, digits, space and _ . ' - */
const NAME_PATTERN = /^[\p{L}\p{N} _.'-]+$/u;

export function arenaNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return null;
  if (trimmed.length > NAME_MAX) return `Use ${NAME_MAX} characters or fewer.`;
  return NAME_PATTERN.test(trimmed) ? null : "Use letters, numbers, spaces and . _ ' - only.";
}

/** Paper selected; live shown but closed until a founder go (spec D11). */
export function ArenaModeToggle() {
  return (
    <div role="radiogroup" aria-label="Trading mode" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button
        type="button"
        role="radio"
        aria-checked="true"
        style={{ ...arenaPrimaryButtonStyle, cursor: 'default' }}
      >
        Paper trading
      </button>
      <button
        type="button"
        role="radio"
        aria-checked="false"
        disabled
        aria-disabled="true"
        style={{ ...arenaButtonStyle, color: FLOOR_TEXT.muted, opacity: 0.55, cursor: 'not-allowed' }}
      >
        Live trading
        <small style={{ display: 'block', fontSize: 10 }}>Coming later</small>
      </button>
    </div>
  );
}

function StepHeader({ step }: { step: Step }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ color: FLOOR_TEXT.faint, fontSize: 11 }}>Step {step} of 4</div>
      <h3 style={{ margin: 0, color: FLOOR_TEXT.value, fontSize: 16 }}>{STEP_TITLES[step]}</h3>
    </div>
  );
}

/**
 * After a launch: the agent's name, the wallet that pays for add-ons (once
 * ClawPump provisioning is ready) and where to go next.
 */
export function LaunchSuccess({ me, onOpenDesk }: { me: FloorArenaMyAgent | null; onOpenDesk: () => void }) {
  const launched = useFloorArenaUi((state) => state.launched);
  const localSeatIndex = useFloorArenaUi((state) => state.localSeatIndex);
  const name = me?.name ?? launched?.agentName ?? 'Your trader';
  const address = me?.paymentAddress ?? launched?.paymentAddress ?? null;
  const provision = me?.provisionState ?? 'pending';
  const seated = me?.seated === true || localSeatIndex >= 0;

  return (
    <section style={{ ...arenaCardStyle, display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="arena-launch-success">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <h3 style={{ margin: 0, color: FLOOR_TEXT.value, fontSize: 16 }}>{name} is ready</h3>
        <ArenaPill colour={FLOOR_TEXT.warning}>Paper trading</ArenaPill>
      </div>
      {address ? (
        <ArenaCopyField value={address} label="Your agent's wallet (pays for add-ons)" />
      ) : provision === 'failed' ? (
        <ArenaMuted>
          The ClawPump agent setup did not finish yet. Paper trading works without it. ClawVille retries the setup every 10 minutes, up to five times.
        </ArenaMuted>
      ) : (
        <ArenaMuted>Setting up your ClawPump agent...</ArenaMuted>
      )}
      <div style={{ color: FLOOR_TEXT.primary, fontSize: 13 }}>
        {seated
          ? 'You are at a desk, so your agent starts trading now.'
          : 'Go sit at a desk in the Trading Floor to start trading.'}
      </div>
      <button type="button" onClick={onOpenDesk} style={{ ...arenaPrimaryButtonStyle, alignSelf: 'flex-start' }}>
        Open my trader
      </button>
    </section>
  );
}

/**
 * The launch flow: template, rules, optional paid add-ons, review. The form
 * validates with the SAME `validateFloorArenaParams` the route runs, so a
 * launch the form allows is a launch the server accepts.
 */
export function LaunchTrader({
  active,
  isGuest,
  onGuestBlocked,
  initialTemplateId,
  compact,
  onBack,
  onOpenDesk,
}: {
  active: boolean;
  isGuest: boolean;
  onGuestBlocked: () => void;
  initialTemplateId: string | null;
  compact: boolean;
  onBack: () => void;
  onOpenDesk: () => void;
}) {
  const initialTemplate = initialTemplateId ? floorArenaTemplateById(initialTemplateId) ?? null : null;
  const [step, setStep] = useState<Step>(initialTemplate ? 2 : 1);
  const [templateId, setTemplateId] = useState<string | null>(initialTemplate?.id ?? null);
  const [params, setParams] = useState<FloorArenaParams | null>(
    initialTemplate ? cloneFloorArenaParams(initialTemplate.params) : null,
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [addonChoices, setAddonChoices] = useState<Record<string, AddonChoice>>({});
  const [name, setName] = useState('');
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const [alreadyHave, setAlreadyHave] = useState(false);
  const nameId = useId();
  const addons = useFloorArenaAddons(active && !isGuest && step >= 3);
  const launch = useLaunchFloorArenaAgent();
  const setLaunched = useFloorArenaUi((state) => state.setLaunched);

  const template = templateId ? floorArenaTemplateById(templateId) ?? null : null;
  const changes = useMemo(
    () => (template && params ? diffFloorArenaParams(template.params, params) : []),
    [template, params],
  );
  const chosenAddons = (addons.data?.addons ?? [])
    .filter((addon) => addonChoices[addon.id]?.enabled)
    .map((addon) => ({ ...addon, capUsd: addonChoices[addon.id]!.capUsd }));

  if (isGuest) {
    return (
      <section style={{ ...arenaCardStyle, display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="arena-launch-guest">
        <ArenaBackButton onClick={onBack} />
        <h3 style={{ margin: 0, color: FLOOR_TEXT.value, fontSize: 16 }}>Launch your trader</h3>
        <ArenaMuted>
          Arena traders belong to accounts, so guests can watch but not launch. A free account takes a minute.
        </ArenaMuted>
        <button type="button" onClick={onGuestBlocked} style={{ ...arenaPrimaryButtonStyle, alignSelf: 'flex-start' }}>
          Create a free account
        </button>
      </section>
    );
  }

  const pickTemplate = (id: string) => {
    const next = floorArenaTemplateById(id);
    if (!next) return;
    setTemplateId(id);
    setParams(cloneFloorArenaParams(next.params));
    setErrors([]);
    setStep(2);
  };

  const validateRules = (): boolean => {
    if (!params) return false;
    const result = validateFloorArenaParams(params);
    if (result.ok) {
      setErrors([]);
      return true;
    }
    setErrors(result.errors);
    return false;
  };

  const nameProblem = arenaNameProblem(name);

  const submit = () => {
    if (!template || !params || !validateRules()) {
      setStep(2);
      return;
    }
    if (nameProblem) return;
    setSubmitMessage(null);
    setAlreadyHave(false);
    launch.mutate(
      {
        templateId: template.id,
        params,
        addons: chosenAddons.map((addon) => ({ id: addon.id, enabled: true, dailyCapUsd: addon.capUsd })),
        ...(name.trim() ? { name: name.trim() } : {}),
      },
      {
        onSuccess: (result) => {
          setLaunched({ agentName: result.agentName, paymentAddress: result.paymentAddress });
        },
        onError: (error) => {
          const code = floorArenaErrorCode(error);
          if (code === 'guest_not_allowed') {
            onGuestBlocked();
            return;
          }
          if (code === 'invalid_params' && error instanceof FloorArenaApiError && error.errors.length > 0) {
            setErrors(error.errors);
            setStep(2);
          }
          setAlreadyHave(code === 'already_have_agent');
          setSubmitMessage(floorArenaErrorCopy(error));
        },
      },
    );
  };

  const next = () => {
    if (step === 2 && !validateRules()) return;
    if (step === 3 && !addonChoicesValid(addonChoices)) return;
    setStep((current) => (current < 4 ? ((current + 1) as Step) : current));
  };
  const back = () => setStep((current) => (current > 1 ? ((current - 1) as Step) : current));

  return (
    <section style={{ ...arenaCardStyle, display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="arena-launch">
      <ArenaBackButton onClick={onBack} />
      <StepHeader step={step} />

      {step === 1 ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))',
            gap: 8,
          }}
        >
          {FLOOR_ARENA_TEMPLATES.map((option) => (
            <div key={option.id} style={arenaInnerCardStyle} data-testid={`arena-launch-template-${option.id}`}>
              <div style={{ color: FLOOR_TEXT.value, fontWeight: 700 }}>{option.displayName}</div>
              <ArenaMuted>{option.tagline}</ArenaMuted>
              <div style={{ color: FLOOR_TEXT.faint, fontSize: 11 }}>{option.risk}</div>
              <button
                type="button"
                onClick={() => pickTemplate(option.id)}
                style={{ ...arenaButtonStyle, alignSelf: 'flex-start' }}
              >
                Use {option.displayName}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {step === 2 && params && template ? (
        <>
          <ArenaMuted>
            Starting from {template.displayName}. Change any rule inside its limits. {template.thesis}
          </ArenaMuted>
          <ArenaModeToggle />
          <ArenaParamsForm value={params} onChange={setParams} errors={errors} compact={compact} />
          <button
            type="button"
            onClick={() => {
              setParams(cloneFloorArenaParams(template.params));
              setErrors([]);
            }}
            style={{ ...arenaButtonStyle, alignSelf: 'flex-start' }}
          >
            Reset to the {template.displayName} rules
          </button>
        </>
      ) : null}

      {step === 3 ? (
        <AddonPicker
          catalog={addons.data?.addons ?? []}
          paymentsEnabled={addons.data?.paymentsEnabled ?? false}
          isLoading={addons.isLoading}
          isError={addons.isError}
          choices={addonChoices}
          onChange={(id, next) => setAddonChoices((current) => ({ ...current, [id]: next }))}
        />
      ) : null}

      {step === 4 && template && params ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="arena-launch-review">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label htmlFor={nameId} style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>
              Name your trader (optional, up to {NAME_MAX} characters; empty uses your avatar&apos;s name)
            </label>
            <input
              id={nameId}
              value={name}
              maxLength={NAME_MAX}
              onChange={(event) => setName(event.target.value)}
              style={arenaInputStyle}
            />
            {nameProblem ? (
              <div role="alert" style={{ color: FLOOR_TEXT.danger, fontSize: 11 }}>
                {nameProblem}
              </div>
            ) : null}
          </div>
          <div style={arenaInnerCardStyle}>
            <div style={{ color: FLOOR_TEXT.value, fontSize: 13 }}>Template: {template.displayName}</div>
            <div style={{ color: FLOOR_TEXT.primary, fontSize: 12 }}>
              Mode: Paper trading (${FLOOR_ARENA_POSITION_USD} per position)
            </div>
            {changes.length === 0 ? (
              <ArenaMuted>You kept the template rules as they are.</ArenaMuted>
            ) : (
              <>
                <div style={{ color: FLOOR_TEXT.primary, fontSize: 12 }}>
                  You changed {changes.length} {changes.length === 1 ? 'rule' : 'rules'}:
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, color: FLOOR_TEXT.muted, fontSize: 12 }}>
                  {changes.map((change) => (
                    <li key={change.path}>
                      {paramPathLabel(change.path)}: {formatParamValue(change.path, change.from)} to{' '}
                      {formatParamValue(change.path, change.to)}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div style={{ color: FLOOR_TEXT.primary, fontSize: 12 }}>
              {chosenAddons.length === 0
                ? 'Paid add-ons: none. Your agent reads the shared free feed.'
                : `Paid add-ons: ${chosenAddons.map((addon) => `${addon.name} (up to $${addon.capUsd.toFixed(2)} a day)`).join(', ')}.`}
            </div>
          </div>
          <ArenaHardRules />
          <ArenaMuted>Your agent opens new positions only while it sits at a Trading Floor desk. Exits always run.</ArenaMuted>
          <ArenaMuted>
            {FLOOR_ARENA_CONTEST.name}: to be eligible for a prize, your agent needs at least one position opened and
            closed between {easternTime(FLOOR_ARENA_CONTEST.startsAt)} and {easternTime(FLOOR_ARENA_CONTEST.endsAt)}.
          </ArenaMuted>
        </div>
      ) : null}

      {step === 2 && errors.length > 0 ? (
        <div role="alert" style={{ color: FLOOR_TEXT.danger, fontSize: 12 }}>
          {errors.length === 1 ? 'One rule needs a fix' : `${errors.length} rules need a fix`} before you continue. Each one
          is marked above.
        </div>
      ) : null}

      {submitMessage ? (
        <div role="alert" style={{ color: FLOOR_TEXT.warning, fontSize: 12 }}>
          {submitMessage}
          {alreadyHave ? (
            <button type="button" onClick={onOpenDesk} style={{ ...arenaButtonStyle, marginLeft: 8 }}>
              Open my trader
            </button>
          ) : null}
        </div>
      ) : null}

      {step > 1 ? (
        <ArenaStickyFooter>
          <button type="button" onClick={back} style={arenaButtonStyle} disabled={launch.isPending}>
            Back
          </button>
          {step < 4 ? (
            <button type="button" onClick={next} style={arenaPrimaryButtonStyle}>
              Next
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={launch.isPending || nameProblem !== null}
              style={{ ...arenaPrimaryButtonStyle, opacity: launch.isPending ? 0.6 : 1 }}
            >
              {launch.isPending ? 'Launching...' : 'Launch'}
            </button>
          )}
        </ArenaStickyFooter>
      ) : null}
    </section>
  );
}
