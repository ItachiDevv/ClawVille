"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  CASH_TIERS,
  cashPokerApi,
  describeCashPokerError,
  type CashTableListItem,
  type CashTierKey,
  type CreateTableBody,
} from "@/lib/cove/cash-poker";
import styles from "./TableLobby.module.css";

const DEFAULT_POLL_MS = 3000;
const SIX_MAX = 6;
const JOIN_CODE_MAX_LENGTH = 16;
const ROUTE_NOTICE_MS = 900;
const TIER_KEYS: CashTierKey[] = ["high", "mid", "low"];

const privateTableSchema = z
  .object({
    buyInCt: z
      .number()
      .int("Enter a whole vCLAW amount.")
      .positive("Buy-in must be at least 1 vCLAW."),
    smallBlindCt: z
      .number()
      .int("Enter a whole vCLAW amount.")
      .positive("Small blind must be at least 1 vCLAW."),
    bigBlindCt: z
      .number()
      .int("Enter a whole vCLAW amount.")
      .positive("Big blind must be at least 1 vCLAW."),
    maxSeats: z.number().int().min(2).max(SIX_MAX),
    seededAgentSlots: z.number().int().min(0).max(SIX_MAX),
  })
  .superRefine((value, context) => {
    if (value.bigBlindCt < value.smallBlindCt) {
      context.addIssue({
        code: "custom",
        path: ["bigBlindCt"],
        message: "Big blind must be at least the small blind.",
      });
    }
    if (value.buyInCt < value.bigBlindCt) {
      context.addIssue({
        code: "custom",
        path: ["buyInCt"],
        message: "Buy-in must cover at least one big blind.",
      });
    }
    if (value.seededAgentSlots > value.maxSeats) {
      context.addIssue({
        code: "custom",
        path: ["seededAgentSlots"],
        message: "Seeded agents cannot exceed the seat count.",
      });
    }
  });

type LobbyTab = "browse" | "create" | "join";
type CreateMode = "house" | "private";
type PrivateField = "buyInCt" | "smallBlindCt" | "bigBlindCt";
type FieldErrors = Partial<Record<PrivateField | "seededAgentSlots", string>>;

interface CreatedPrivateTable {
  tableId: string;
  joinCode: string | null;
}

export interface TableLobbyProps {
  isAuthenticated: boolean;
  pollMs?: number;
}

export function TableLobby({
  isAuthenticated,
  pollMs = DEFAULT_POLL_MS,
}: TableLobbyProps) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const routeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tab, setTab] = useState<LobbyTab>("browse");
  const [tables, setTables] = useState<CashTableListItem[] | null>(null);
  const [listNotice, setListNotice] = useState<string | null>(null);
  const [busyTableId, setBusyTableId] = useState<string | null>(null);
  const [routeNotice, setRouteNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const result = await cashPokerApi.listTables(50);
        if (!cancelled) {
          setTables(result.tables);
          setListNotice(null);
        }
      } catch (error) {
        if (!cancelled)
          setListNotice(`${describeCashPokerError(error)} Retrying…`);
      } finally {
        if (!cancelled) timer = setTimeout(tick, pollMs);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pollMs]);

  useEffect(
    () => () => {
      if (routeTimerRef.current) clearTimeout(routeTimerRef.current);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const routeToTable = useCallback(
    (tableId: string, maxSeats: number, alreadySeated = false) => {
      const destination =
        maxSeats > SIX_MAX
          ? `/cove/poker/cash/${encodeURIComponent(tableId)}`
          : `/cove/table?tableId=${encodeURIComponent(tableId)}`;
      const notice =
        maxSeats > SIX_MAX
          ? "This table has more than six seats — opening the classic felt."
          : alreadySeated
            ? "You’re already seated — returning to your table."
            : null;

      if (!notice) {
        router.push(destination);
        return;
      }

      setRouteNotice(notice);
      if (routeTimerRef.current) clearTimeout(routeTimerRef.current);
      routeTimerRef.current = setTimeout(
        () => router.push(destination),
        ROUTE_NOTICE_MS,
      );
    },
    [router],
  );

  const joinPublicTable = useCallback(
    async (table: CashTableListItem) => {
      if (!isAuthenticated) {
        setListNotice("Sign in to take a seat at a live table.");
        return;
      }
      if (table.occupiedSeats >= table.maxSeats) return;

      setBusyTableId(table.id);
      setListNotice(null);
      try {
        const result = await cashPokerApi.sit(table.id, Number(table.buyInCt));
        routeToTable(table.id, table.maxSeats, result.alreadySeated);
      } catch (error) {
        setListNotice(describeCashPokerError(error));
        setBusyTableId(null);
      }
    },
    [isAuthenticated, routeToTable],
  );

  return (
    <section
      className={`${styles.overlay} ${isMobile ? styles.mobile : ""}`}
      aria-label="Hold'em table lobby"
    >
      <div className={styles.panel}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Cove · Hold&apos;em</p>
            <h1 className={styles.title}>Live Tables</h1>
            <p className={styles.subtitle}>
              Tables deal automatically while a real player is seated.
            </p>
          </div>
          <div className={styles.sixMaxMark} aria-label="Six-max room">
            6 MAX
          </div>
        </header>

        <div
          className={styles.tabs}
          role="tablist"
          aria-label="Table lobby sections"
        >
          <TabButton
            active={tab === "browse"}
            controls="lobby-browse"
            onClick={() => setTab("browse")}
          >
            Live Tables
          </TabButton>
          <TabButton
            active={tab === "create"}
            controls="lobby-create"
            onClick={() => setTab("create")}
          >
            Create Table
          </TabButton>
          <TabButton
            active={tab === "join"}
            controls="lobby-join"
            onClick={() => setTab("join")}
          >
            Have a code?
          </TabButton>
        </div>

        <div className={styles.scroller}>
          {routeNotice ? <Notice tone="info">{routeNotice}</Notice> : null}
          {tab === "browse" ? (
            <BrowsePanel
              tables={tables}
              notice={listNotice}
              busyTableId={busyTableId}
              onJoin={joinPublicTable}
              onCreate={() => setTab("create")}
            />
          ) : null}
          {tab === "create" ? (
            isAuthenticated ? (
              <CreatePanel
                routeToTable={routeToTable}
                copyTimerRef={copyTimerRef}
              />
            ) : (
              <GuestGate
                id="lobby-create"
                action="create or join private tables"
                router={router}
              />
            )
          ) : null}
          {tab === "join" ? (
            isAuthenticated ? (
              <JoinPanel routeToTable={routeToTable} />
            ) : (
              <GuestGate
                id="lobby-join"
                action="create or join private tables"
                router={router}
              />
            )
          ) : null}
        </div>
      </div>
    </section>
  );
}

function TabButton({
  active,
  controls,
  onClick,
  children,
}: {
  active: boolean;
  controls: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={controls}
      className={`${styles.tab} ${active ? styles.tabActive : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function BrowsePanel({
  tables,
  notice,
  busyTableId,
  onJoin,
  onCreate,
}: {
  tables: CashTableListItem[] | null;
  notice: string | null;
  busyTableId: string | null;
  onJoin: (table: CashTableListItem) => void;
  onCreate: () => void;
}) {
  return (
    <div id="lobby-browse" role="tabpanel" className={styles.panelBody}>
      {notice ? <Notice tone="warning">{notice}</Notice> : null}
      {tables === null ? (
        <TableSkeleton />
      ) : tables.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon} aria-hidden="true">
            ♠
          </span>
          <p>No open tables right now — create one.</p>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onCreate}
          >
            Jump to Create
          </button>
        </div>
      ) : (
        <div className={styles.tableGrid} aria-label="Open public tables">
          {tables.map((table) => (
            <TableCard
              key={table.id}
              table={table}
              busy={busyTableId === table.id}
              onClick={() => onJoin(table)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TableCard({
  table,
  busy,
  onClick,
}: {
  table: CashTableListItem;
  busy: boolean;
  onClick: () => void;
}) {
  const tierKey = isTierKey(table.tierKey) ? table.tierKey : null;
  const full = table.occupiedSeats >= table.maxSeats;
  const liveStatus = table.status.toLowerCase();
  const status = ["dealing", "playing", "live", "in_hand"].includes(liveStatus)
    ? "dealing"
    : ["open", "waiting"].includes(liveStatus)
      ? "waiting"
      : null;

  return (
    <button
      type="button"
      className={styles.tableCard}
      onClick={onClick}
      disabled={full || busy}
      aria-label={`${tierKey?.toUpperCase() ?? "Public"} table, ${table.smallBlindCt}/${table.bigBlindCt} vCLAW blinds, ${table.buyInCt} vCLAW buy-in, ${table.occupiedSeats} of ${table.maxSeats} seats occupied`}
    >
      <span className={styles.cardCopy}>
        <span
          className={`${styles.tierChip} ${tierKey ? styles[`tier${capitalize(tierKey)}`] : styles.tierCustom}`}
        >
          {tierKey?.toUpperCase() ?? "PUBLIC"}
        </span>
        <span className={styles.stakes}>
          {table.smallBlindCt}/{table.bigBlindCt} vCLAW blinds
        </span>
        <span className={styles.buyIn}>
          {Number(table.buyInCt).toLocaleString()} vCLAW buy-in
        </span>
      </span>
      <span className={styles.cardMeta}>
        <SeatPips occupied={table.occupiedSeats} maxSeats={table.maxSeats} />
        {status ? (
          <span
            className={`${styles.statusChip} ${status === "dealing" ? styles.statusDealing : styles.statusWaiting}`}
          >
            {status === "dealing" ? "DEALING" : "WAITING"}
          </span>
        ) : null}
        <span className={styles.chevron} aria-hidden="true">
          {busy ? "···" : full ? "FULL" : "›"}
        </span>
      </span>
    </button>
  );
}

function SeatPips({
  occupied,
  maxSeats,
}: {
  occupied: number;
  maxSeats: number;
}) {
  return (
    <span
      className={styles.seatGroup}
      aria-label={`${occupied} of ${maxSeats} seats occupied`}
    >
      {Array.from({ length: SIX_MAX }, (_, index) => (
        <span
          key={index}
          className={`${styles.seatPip} ${index < occupied ? styles.seatFilled : ""} ${index >= maxSeats ? styles.seatUnavailable : ""}`}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}

function CreatePanel({
  routeToTable,
  copyTimerRef,
}: {
  routeToTable: (
    tableId: string,
    maxSeats: number,
    alreadySeated?: boolean,
  ) => void;
  copyTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
}) {
  const [mode, setMode] = useState<CreateMode>("house");
  const [tierKey, setTierKey] = useState<CashTierKey>("mid");
  const [maxSeats, setMaxSeats] = useState(SIX_MAX);
  const [seededAgentSlots, setSeededAgentSlots] = useState(0);
  const [privateValues, setPrivateValues] = useState<
    Record<PrivateField, string>
  >({
    buyInCt: "100",
    smallBlindCt: "5",
    bigBlindCt: "10",
  });
  const [touched, setTouched] = useState<
    Partial<Record<PrivateField, boolean>>
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedPrivateTable | null>(null);
  const [copied, setCopied] = useState(false);

  const validation = useMemo(() => {
    const result = privateTableSchema.safeParse({
      buyInCt: Number(privateValues.buyInCt),
      smallBlindCt: Number(privateValues.smallBlindCt),
      bigBlindCt: Number(privateValues.bigBlindCt),
      maxSeats,
      seededAgentSlots,
    });
    if (result.success) return { data: result.data, errors: {} as FieldErrors };
    const errors: FieldErrors = {};
    for (const issue of result.error.issues) {
      const field = issue.path[0] as keyof FieldErrors | undefined;
      if (field && !errors[field]) errors[field] = issue.message;
    }
    return { data: null, errors };
  }, [maxSeats, privateValues, seededAgentSlots]);

  const updateSeats = useCallback((next: number) => {
    const clamped = Math.max(2, Math.min(SIX_MAX, next));
    setMaxSeats(clamped);
    setSeededAgentSlots((current) => Math.min(current, clamped));
  }, []);

  const handleCreate = useCallback(async () => {
    if (mode === "private" && !validation.data) {
      setTouched({ buyInCt: true, smallBlindCt: true, bigBlindCt: true });
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const body: CreateTableBody =
        mode === "house"
          ? { source: "player-public", tierKey, maxSeats, seededAgentSlots }
          : {
              source: "private",
              buyInCt: validation.data!.buyInCt,
              smallBlindCt: validation.data!.smallBlindCt,
              bigBlindCt: validation.data!.bigBlindCt,
              maxSeats,
              seededAgentSlots,
            };
      const result = await cashPokerApi.createTable(body);

      if (result.table.visibility === "private") {
        setCreated({
          tableId: result.table.id,
          joinCode: result.table.joinCode,
        });
        setBusy(false);
        return;
      }

      const sitResult = await cashPokerApi.sit(
        result.table.id,
        Number(result.table.buyInCt),
      );
      routeToTable(
        result.table.id,
        result.table.maxSeats,
        sitResult.alreadySeated,
      );
    } catch (createError) {
      setError(describeCashPokerError(createError));
      setBusy(false);
    }
  }, [
    maxSeats,
    mode,
    routeToTable,
    seededAgentSlots,
    tierKey,
    validation.data,
  ]);

  const enterPrivateTable = useCallback(async () => {
    if (!created?.joinCode) return;
    setBusy(true);
    setError(null);
    try {
      const joined = await cashPokerApi.joinByCode(created.joinCode);
      const state = await cashPokerApi.publicTableState(joined.tableId);
      routeToTable(joined.tableId, state.table.maxSeats, joined.alreadySeated);
    } catch (joinError) {
      setError(describeCashPokerError(joinError));
      setBusy(false);
    }
  }, [created, routeToTable]);

  const copyCode = useCallback(async () => {
    if (!created?.joinCode) return;
    try {
      await navigator.clipboard.writeText(created.joinCode);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setError(
        "Copy was blocked. Select the visible code and copy it manually.",
      );
    }
  }, [copyTimerRef, created]);

  if (created) {
    return (
      <div id="lobby-create" role="tabpanel" className={styles.successPanel}>
        <span className={styles.successKicker}>Private table ready</span>
        <h2>Share this join code</h2>
        <p className={styles.warningText}>
          You will not see this code again after leaving this screen.
        </p>
        <div className={styles.codePanel}>
          <output
            className={styles.joinCode}
            aria-label="Private table join code"
          >
            {created.joinCode ?? "CODE UNAVAILABLE"}
          </output>
          <button
            type="button"
            className={styles.copyButton}
            onClick={() => void copyCode()}
            disabled={!created.joinCode}
          >
            {copied ? "Copied" : "Copy code"}
          </button>
        </div>
        {error ? <Notice tone="warning">{error}</Notice> : null}
        <button
          type="button"
          className={styles.primaryButton}
          onClick={() => void enterPrivateTable()}
          disabled={busy || !created.joinCode}
        >
          {busy ? "Entering…" : "Enter table"}
        </button>
      </div>
    );
  }

  return (
    <div id="lobby-create" role="tabpanel" className={styles.panelBody}>
      <div className={styles.segmented} aria-label="Table type">
        <SegmentButton
          active={mode === "house"}
          onClick={() => setMode("house")}
        >
          House table
        </SegmentButton>
        <SegmentButton
          active={mode === "private"}
          onClick={() => setMode("private")}
        >
          Private table
        </SegmentButton>
      </div>

      {mode === "house" ? (
        <fieldset className={styles.fieldset}>
          <legend>Choose a house tier</legend>
          <div className={styles.tierGrid}>
            {TIER_KEYS.map((key) => {
              const tier = CASH_TIERS[key];
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={tierKey === key}
                  className={`${styles.tierCard} ${tierKey === key ? styles.tierCardActive : ""}`}
                  onClick={() => setTierKey(key)}
                >
                  <span
                    className={`${styles.tierChip} ${styles[`tier${capitalize(key)}`]}`}
                  >
                    {key.toUpperCase()}
                  </span>
                  <strong>
                    {tier.smallBlindCt}/{tier.bigBlindCt} vCLAW blinds
                  </strong>
                  <span>{tier.buyInCt.toLocaleString()} vCLAW buy-in</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : (
        <fieldset className={styles.fieldset}>
          <legend>Set custom stakes</legend>
          <div className={styles.inputGrid}>
            <LabeledInput
              id="private-buy-in"
              label="Buy-in (vCLAW)"
              value={privateValues.buyInCt}
              error={touched.buyInCt ? validation.errors.buyInCt : undefined}
              onBlur={() =>
                setTouched((value) => ({ ...value, buyInCt: true }))
              }
              onChange={(value) =>
                setPrivateValues((current) => ({ ...current, buyInCt: value }))
              }
            />
            <LabeledInput
              id="private-small-blind"
              label="Small blind (vCLAW)"
              value={privateValues.smallBlindCt}
              error={
                touched.smallBlindCt
                  ? validation.errors.smallBlindCt
                  : undefined
              }
              onBlur={() =>
                setTouched((value) => ({ ...value, smallBlindCt: true }))
              }
              onChange={(value) =>
                setPrivateValues((current) => ({
                  ...current,
                  smallBlindCt: value,
                }))
              }
            />
            <LabeledInput
              id="private-big-blind"
              label="Big blind (vCLAW)"
              value={privateValues.bigBlindCt}
              error={
                touched.bigBlindCt ? validation.errors.bigBlindCt : undefined
              }
              onBlur={() =>
                setTouched((value) => ({ ...value, bigBlindCt: true }))
              }
              onChange={(value) =>
                setPrivateValues((current) => ({
                  ...current,
                  bigBlindCt: value,
                }))
              }
            />
          </div>
        </fieldset>
      )}

      <div className={styles.stepperGrid}>
        <Stepper
          label="Seats"
          value={maxSeats}
          min={2}
          max={SIX_MAX}
          onChange={updateSeats}
        />
        <Stepper
          label="Seeded agents"
          value={seededAgentSlots}
          min={0}
          max={maxSeats}
          onChange={setSeededAgentSlots}
        />
      </div>
      <p className={styles.helperText}>
        This room is six-max. Seeded agents use the original table-fill bounds.
      </p>
      {validation.errors.seededAgentSlots ? (
        <Notice tone="warning">{validation.errors.seededAgentSlots}</Notice>
      ) : null}
      {error ? <Notice tone="warning">{error}</Notice> : null}
      <button
        type="button"
        className={styles.primaryButton}
        onClick={() => void handleCreate()}
        disabled={busy || (mode === "private" && !validation.data)}
      >
        {busy
          ? "Opening table…"
          : mode === "private"
            ? "Create private table"
            : "Create & sit"}
      </button>
    </div>
  );
}

function JoinPanel({
  routeToTable,
}: {
  routeToTable: (
    tableId: string,
    maxSeats: number,
    alreadySeated?: boolean,
  ) => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleJoin = useCallback(async () => {
    const normalized = code.trim().toUpperCase();
    if (!normalized) {
      setError("Enter a join code.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const joined = await cashPokerApi.joinByCode(normalized);
      const state = await cashPokerApi.publicTableState(joined.tableId);
      routeToTable(joined.tableId, state.table.maxSeats, joined.alreadySeated);
    } catch (joinError) {
      setError(describeCashPokerError(joinError));
      setBusy(false);
    }
  }, [code, routeToTable]);

  return (
    <div id="lobby-join" role="tabpanel" className={styles.joinPanel}>
      <div className={styles.codeGlyph} aria-hidden="true">
        #
      </div>
      <h2>Join a private table</h2>
      <p>Enter the code exactly as it was shared with you.</p>
      <label className={styles.codeLabel} htmlFor="cash-table-join-code">
        Join code
      </label>
      <input
        id="cash-table-join-code"
        className={styles.codeInput}
        value={code}
        maxLength={JOIN_CODE_MAX_LENGTH}
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        placeholder="ABC123"
        onChange={(event) => setCode(event.target.value.toUpperCase())}
        onKeyDown={(event) => {
          if (event.key === "Enter") void handleJoin();
        }}
      />
      {error ? <Notice tone="warning">{error}</Notice> : null}
      <button
        type="button"
        className={styles.primaryButton}
        onClick={() => void handleJoin()}
        disabled={busy || !code.trim()}
      >
        {busy ? "Finding table…" : "Join table"}
      </button>
    </div>
  );
}

function GuestGate({
  id,
  action,
  router,
}: {
  id: string;
  action: string;
  router: ReturnType<typeof useRouter>;
}) {
  return (
    <div id={id} role="tabpanel" className={styles.guestGate}>
      <div className={styles.lockIcon} aria-hidden="true">
        ◇
      </div>
      <h2>Players only</h2>
      <p>Sign in to {action}.</p>
      <button
        type="button"
        className={styles.secondaryButton}
        onClick={() => router.push("/login")}
      >
        Sign in
      </button>
    </div>
  );
}

function SegmentButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`${styles.segmentButton} ${active ? styles.segmentButtonActive : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className={styles.stepper}>
      <span>{label}</span>
      <div className={styles.stepperControl}>
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          onClick={() => onChange(Math.max(min, value - 1))}
          disabled={value <= min}
        >
          −
        </button>
        <output aria-label={`${label}: ${value}`}>{value}</output>
        <button
          type="button"
          aria-label={`Increase ${label}`}
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
        >
          +
        </button>
      </div>
    </div>
  );
}

function LabeledInput({
  id,
  label,
  value,
  error,
  onBlur,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error?: string;
  onBlur: () => void;
  onChange: (value: string) => void;
}) {
  const errorId = `${id}-error`;
  return (
    <label className={styles.inputField} htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        step={1}
        value={value}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        onBlur={onBlur}
        onChange={(event) => onChange(event.target.value)}
      />
      <small id={errorId} className={styles.fieldError}>
        {error ?? "\u00a0"}
      </small>
    </label>
  );
}

function Notice({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "warning" | "info";
}) {
  return (
    <div
      className={`${styles.notice} ${tone === "warning" ? styles.noticeWarning : styles.noticeInfo}`}
      role={tone === "warning" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className={styles.skeletonList} aria-label="Loading live tables">
      <div className={styles.skeletonCard} />
      <div className={styles.skeletonCard} />
      <span>Finding open tables…</span>
    </div>
  );
}

function isTierKey(value: string | null): value is CashTierKey {
  return value === "low" || value === "mid" || value === "high";
}

function capitalize<T extends string>(value: T): Capitalize<T> {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}` as Capitalize<T>;
}
