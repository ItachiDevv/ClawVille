import { measureSpike } from "@/lib/perf-tracker";
import {
  WORLD_STREAM_TICK_MS,
  createWorldStreamMachineState,
  decide,
  type ActivePresenceActivity,
  type WorldPresencePolicy,
  type WorldPresenceTransport,
  type WorldStreamMachineAction,
  type WorldStreamMachineInput,
  type WorldStreamMachineState,
  type WorldTransportStandDownReason,
} from "@/hooks/world-stream-machine";
import { decideWorldDownlink } from "@/hooks/world-downlink-policy";
import {
  WORLD_PRESENCE_WS_CLOSE_CODES,
  type PlayerSnapshot,
  type WorldPresenceClientFrame,
  type WorldPresencePositionFrame,
  type WorldPresenceServerFrame,
} from "@clawville/shared";

const MAX_STREAM_RETRIES = 20;
const STREAM_RETRY_BASE_MS = 3_000;
const STREAM_RETRY_MAX_MS = 60_000;
const JOIN_TIMEOUT_MS = 15_000;
const RECOVERY_WAIT_CEILING_MS = 30_000;
const ACTIVITY_MOTION_EPSILON_PX = 0.5;
const HEADING_MOTION_EPSILON_RAD = 0.01;

export interface WorldJoinResponse {
  roomId: string;
  id: string;
  roomTicket?: string;
  transports?: { positionWs?: boolean };
}

export interface ActivePresencePose {
  x: number;
  y: number;
  dirZ: number;
  activity: ActivePresenceActivity;
}

interface SentPresencePose {
  x: number;
  y: number;
  dirZ: number;
  activity: string;
}

interface FrozenPresencePose {
  x: number;
  y: number;
  dirZ: number;
}

export interface WorldPresenceStoreCallbacks {
  updateNpcsFromSnapshot: (snapshot: unknown) => void;
  setNpcConnected: (connected: boolean) => void;
  updatePlayersFromSnapshot: (players: PlayerSnapshot[]) => void;
  setLocalSessionId: (sessionId: string | null) => void;
  setRoomId: (roomId: string | null) => void;
  clearPlayers: () => void;
  addCollaborationEntries: (entries: unknown[]) => void;
  invalidateLandQuery: () => void;
  addToast: (icon: string, message: string, durationMs?: number) => void;
  readPolicy: () => WorldPresencePolicy;
  readRemoteActivity: () => string | undefined;
  readDownlinkEnabled: () => boolean;
  readControlMode: () => string;
  readAvatarPosition: () => { x: number; y: number };
}

export interface WorldPresenceEventSourceLike {
  addEventListener(
    type: string,
    listener: (event: { data?: string }) => void,
  ): void;
  close(): void;
  onerror: ((event?: unknown) => void) | null;
}

export interface WorldPresenceSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
}

export type TimerHandle = ReturnType<typeof setTimeout>;
export interface PageLifecycleEvent {
  type: "pagehide" | "pageshow";
  persisted: boolean;
}

export interface WorldPresenceEnvironment {
  now(): number;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  fetch: typeof fetch;
  createAbortController(): AbortController;
  createEventSource(url: string): WorldPresenceEventSourceLike;
  createSocket(url: string): WorldPresenceSocketLike;
  isDocumentHidden(): boolean;
  addVisibilityListener(listener: () => void): () => void;
  addPageLifecycleListener(
    listener: (event: PageLifecycleEvent) => void,
  ): () => void;
  readLocationSearch(): string;
  isDev(): boolean;
}

export function createBrowserEnvironment(): WorldPresenceEnvironment {
  return {
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    fetch: ((...args: Parameters<typeof fetch>) =>
      fetch(...args)) as typeof fetch,
    createAbortController: () => new AbortController(),
    createEventSource: (url) => {
      const source = new EventSource(url, { withCredentials: true });
      return source as unknown as WorldPresenceEventSourceLike;
    },
    createSocket: (url) =>
      new WebSocket(url) as unknown as WorldPresenceSocketLike,
    isDocumentHidden: () => typeof document !== "undefined" && document.hidden,
    addVisibilityListener: (listener) => {
      if (typeof document === "undefined") return () => undefined;
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    addPageLifecycleListener: (listener) => {
      if (typeof window === "undefined") return () => undefined;
      const onPageHide = (event: PageTransitionEvent) =>
        listener({ type: "pagehide", persisted: event.persisted });
      const onPageShow = (event: PageTransitionEvent) =>
        listener({ type: "pageshow", persisted: event.persisted });
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("pageshow", onPageShow);
      return () => {
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("pageshow", onPageShow);
      };
    },
    readLocationSearch: () =>
      typeof window === "undefined" ? "" : window.location.search,
    isDev: () => process.env.NODE_ENV !== "production",
  };
}

export interface WorldPresenceControllerOptions {
  apiBaseUrl: string;
  callbacks: WorldPresenceStoreCallbacks;
  environment?: WorldPresenceEnvironment;
}

export interface WorldPresenceDiagnostics {
  transport: WorldPresenceTransport;
  socketPhase: WorldStreamMachineState["socketPhase"];
  socketGeneration: number;
  transportEpoch: number;
  wsAdvertised: boolean;
  httpFallbackTripped: boolean;
  uploadsSuspended: boolean;
  superseded: boolean;
  joinRequests: number;
  socketOpens: number;
  socketFramesSent: number;
  pongsSent: number;
  httpPositionPosts: number;
  httpPositionResponsesDiscarded: number;
  fallbackActivations: number;
  standDowns: number;
}

interface MutableDiagnostics {
  joinRequests: number;
  socketOpens: number;
  socketFramesSent: number;
  pongsSent: number;
  httpPositionPosts: number;
  httpPositionResponsesDiscarded: number;
  fallbackActivations: number;
  standDowns: number;
}

type JoinResult =
  | { kind: "joined"; value: WorldJoinResponse }
  | { kind: "superseded" }
  | { kind: "failed" };

type JoinOutcome = JoinResult | { kind: "timeout" };

export function resolveWsAdvertised(join: WorldJoinResponse): boolean {
  return join.transports?.positionWs === true;
}

export function resolveUplinkUrl(apiBaseUrl: string, roomId: string): string {
  const url = new URL(
    `/api/world/${encodeURIComponent(roomId)}/ws`,
    apiBaseUrl,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class WorldPresenceController {
  readonly #apiBaseUrl: string;
  readonly #callbacks: WorldPresenceStoreCallbacks;
  readonly #env: WorldPresenceEnvironment;

  #state = createWorldStreamMachineState();
  #started = false;
  #stopped = false;
  #pumping = false;
  #wasHidden = false;
  #pageHiddenPersisted = false;

  #interval: TimerHandle | null = null;
  #removeVisibilityListener: (() => void) | null = null;
  #removePageLifecycleListener: (() => void) | null = null;

  #eventSource: WorldPresenceEventSourceLike | null = null;
  #streamRetryTimer: TimerHandle | null = null;
  #streamRetries = 0;
  #lastStreamAttemptWasBareReopen = false;
  #streamEpoch = 0;
  #retryTokenSequence = 0;
  #activeRetryToken: number | null = null;

  #socket: WorldPresenceSocketLike | null = null;

  #sessionId: string | null = null;
  #roomId: string | null = null;
  #roomTicket: string | null = null;
  #recoveryInFlight = false;
  #recoveryLeaseSequence = 0;
  #activeRecoveryLease: number | null = null;
  readonly #joinAborts = new Set<AbortController>();
  readonly #inflightPositionAborts = new Set<AbortController>();

  #lastPosition: { x: number; y: number; ts: number } | null = null;
  #lastDirection = 0;
  #frozenPosition: FrozenPresencePose | null = null;
  #initialActivePose: ActivePresencePose | null = null;
  #lastSentPose: SentPresencePose | null = null;

  readonly #diag: MutableDiagnostics = {
    joinRequests: 0,
    socketOpens: 0,
    socketFramesSent: 0,
    pongsSent: 0,
    httpPositionPosts: 0,
    httpPositionResponsesDiscarded: 0,
    fallbackActivations: 0,
    standDowns: 0,
  };

  constructor(options: WorldPresenceControllerOptions) {
    this.#apiBaseUrl = options.apiBaseUrl;
    this.#callbacks = options.callbacks;
    this.#env = options.environment ?? createBrowserEnvironment();
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopped = false;
    this.#wasHidden = this.#env.isDocumentHidden();
    this.#interval = this.#env.setInterval(
      () => this.#pump(),
      WORLD_STREAM_TICK_MS,
    );
    this.#removeVisibilityListener = this.#env.addVisibilityListener(() => {
      const hidden = this.#env.isDocumentHidden();
      const becameVisible = this.#wasHidden && !hidden;
      this.#wasHidden = hidden;
      if (becameVisible) this.#pump();
    });
    this.#removePageLifecycleListener = this.#env.addPageLifecycleListener(
      (event) => this.#handlePageLifecycle(event),
    );
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#started = false;
    for (const abort of this.#joinAborts) abort.abort();
    this.#joinAborts.clear();
    this.#abortInflightPositions();
    if (this.#interval) {
      this.#env.clearInterval(this.#interval);
      this.#interval = null;
    }
    this.#removeVisibilityListener?.();
    this.#removeVisibilityListener = null;
    this.#removePageLifecycleListener?.();
    this.#removePageLifecycleListener = null;
    this.#invalidateStream();
    this.#retireSocket();
    this.#sendLeave();
    this.#sessionId = null;
    this.#roomId = null;
    this.#roomTicket = null;
    this.#callbacks.setNpcConnected(false);
    this.#callbacks.setLocalSessionId(null);
    this.#callbacks.setRoomId(null);
    this.#callbacks.clearPlayers();
  }

  getDiagnostics(): WorldPresenceDiagnostics {
    return {
      transport: this.#state.transport,
      socketPhase: this.#state.socketPhase,
      socketGeneration: this.#state.socketGeneration,
      transportEpoch: this.#state.transportEpoch,
      wsAdvertised: this.#state.wsAdvertised,
      httpFallbackTripped: this.#state.httpFallbackTripped,
      uploadsSuspended: this.#state.uploadsSuspended,
      superseded: this.#state.superseded,
      ...this.#diag,
    };
  }

  #pump(): void {
    if (this.#stopped || this.#pumping) return;
    this.#pumping = true;
    try {
      const now = this.#env.now();
      const downlinkAction = decideWorldDownlink({
        wanted: this.#callbacks.readDownlinkEnabled(),
        open: this.#eventSource !== null,
        pendingReopen: this.#activeRetryToken !== null,
        recoveryInFlight: this.#recoveryInFlight,
        hasSession: this.#sessionId !== null,
        hasRoom: this.#roomId !== null,
      });
      if (downlinkAction === "CLOSE") {
        this.#closeStream();
      } else if (downlinkAction === "OPEN") {
        this.#openStream(this.#roomId!);
        this.#callbacks.invalidateLandQuery();
      }
      const policy = this.#callbacks.readPolicy();
      const activePose =
        policy === "active" ? this.#sampleActivePosition(now) : undefined;
      const controlMode = this.#callbacks.readControlMode();
      this.#dispatch(
        {
          type: "TICK",
          now,
          policy,
          hasSession: this.#sessionId !== null,
          canUpload: controlMode !== "explore" && controlMode !== "autonomous",
          hasFrozenPosition: this.#frozenPosition !== null,
          recoveryInFlight: this.#recoveryInFlight,
          poseChanged: activePose ? this.#activePoseChanged(activePose) : false,
          activeActivity: activePose?.activity ?? "idle",
          documentHidden: this.#env.isDocumentHidden(),
        },
        activePose,
      );
    } finally {
      this.#pumping = false;
    }
  }

  #dispatch(
    input: WorldStreamMachineInput,
    activePose?: ActivePresencePose,
  ): void {
    if (this.#stopped) return;
    const previousState = this.#state;
    const decision = decide(previousState, input);
    this.#state = decision.nextState;
    if (!previousState.httpFallbackTripped && this.#state.httpFallbackTripped) {
      this.#diag.fallbackActivations += 1;
    }
    if (
      input.type === "TRANSPORT_STAND_DOWN" &&
      decision.nextState !== previousState
    ) {
      this.#diag.standDowns += 1;
    }
    if (previousState.transportEpoch !== this.#state.transportEpoch) {
      this.#abortInflightPositions();
    }
    for (const action of decision.actions) {
      this.#runAction(action, input.now, activePose);
    }
  }

  #runAction(
    action: WorldStreamMachineAction,
    now: number,
    activePose?: ActivePresencePose,
  ): void {
    switch (action) {
      case "BOOTSTRAP":
        void this.#bootstrap();
        return;
      case "RESET_ACTIVE_POSITION": {
        const position = this.#callbacks.readAvatarPosition();
        this.#lastPosition = { x: position.x, y: position.y, ts: now };
        return;
      }
      case "UPLOAD_ACTIVE":
        if (activePose) this.#uploadActivePosition(activePose);
        return;
      case "UPLOAD_REMOTE":
        this.#uploadRemotePosition();
        return;
      case "RECOVER":
        void this.#recoverWithTicket();
        return;
      case "OPEN_SOCKET":
        this.#openSocket(this.#state.socketGeneration);
        return;
      case "CLOSE_SOCKET":
        this.#retireSocket();
        return;
    }
  }

  async #join(
    recovery: boolean,
    abort = this.#env.createAbortController(),
  ): Promise<JoinResult> {
    const requestedRoom = new URLSearchParams(
      this.#env.readLocationSearch(),
    ).get("room");
    const body: { roomId?: string; roomTicket?: string } = {};
    if (recovery) {
      if (this.#roomId) body.roomId = this.#roomId;
      if (this.#roomTicket) body.roomTicket = this.#roomTicket;
    } else if (requestedRoom) {
      body.roomId = requestedRoom;
    }

    this.#joinAborts.add(abort);
    this.#diag.joinRequests += 1;
    try {
      const response = await this.#env.fetch(
        `${this.#apiBaseUrl}/api/world/join`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: abort.signal,
        },
      );
      if (!response.ok) {
        if (response.status === 409) {
          const error = (await response.json().catch(() => null)) as {
            code?: string;
          } | null;
          if (error?.code === "presence_superseded") {
            return { kind: "superseded" };
          }
        }
        return { kind: "failed" };
      }
      const joined = (await response.json()) as WorldJoinResponse;
      if (this.#stopped) {
        this.#sendLeave(true);
        return { kind: "failed" };
      }
      return { kind: "joined", value: joined };
    } catch (error) {
      if (!abort.signal.aborted && this.#env.isDev()) {
        console.warn("[world-presence] join failed", error);
      }
      return { kind: "failed" };
    } finally {
      this.#joinAborts.delete(abort);
    }
  }

  async #withDeadline<T>(
    operation: Promise<T>,
    ms: number,
  ): Promise<{ settled: T } | { timedOut: true }> {
    let timer!: TimerHandle;
    const deadline = new Promise<{ timedOut: true }>((resolve) => {
      timer = this.#env.setTimeout(() => resolve({ timedOut: true }), ms);
    });
    try {
      return await Promise.race([
        operation.then((settled) => ({ settled })),
        deadline,
      ]);
    } finally {
      this.#env.clearTimeout(timer);
    }
  }

  async #joinBounded(): Promise<JoinResult> {
    const abort = this.#env.createAbortController();
    const outcome = await this.#withDeadline(
      this.#join(false, abort),
      JOIN_TIMEOUT_MS,
    );
    if ("timedOut" in outcome) {
      abort.abort();
      return { kind: "failed" };
    }
    return outcome.settled;
  }

  async #bootstrap(): Promise<void> {
    const result = await this.#joinBounded();
    if (this.#stopped) return;
    if (result.kind === "superseded") {
      this.#handleSuperseded();
      return;
    }
    if (result.kind === "failed") {
      this.#dispatch({ type: "BOOTSTRAP_FAILED", now: this.#env.now() });
      return;
    }

    const joined = result.value;
    this.#sessionId = joined.id;
    this.#roomId = joined.roomId;
    this.#roomTicket = joined.roomTicket ?? null;
    this.#callbacks.setLocalSessionId(joined.id);
    this.#callbacks.setRoomId(joined.roomId);
    this.#dispatch({
      type: "BOOTSTRAP_OK",
      now: this.#env.now(),
      wsAdvertised: resolveWsAdvertised(joined),
    });
    if (this.#callbacks.readDownlinkEnabled()) {
      this.#openStream(joined.roomId);
    }
  }

  async #recoverWithTicket(): Promise<string | null> {
    if (this.#stopped || this.#recoveryInFlight) return null;
    this.#recoveryInFlight = true;
    const lease = ++this.#recoveryLeaseSequence;
    this.#activeRecoveryLease = lease;

    let resolveDone!: (value: string | null) => void;
    const done = new Promise<string | null>((resolve) => {
      resolveDone = resolve;
    });
    const abort = this.#env.createAbortController();
    const deadlineTimer = this.#env.setTimeout(() => {
      abort.abort();
      resolveDone(this.#settleRecovery(lease, { kind: "timeout" }));
    }, JOIN_TIMEOUT_MS);

    void this.#join(true, abort).then(
      (outcome) => {
        this.#env.clearTimeout(deadlineTimer);
        resolveDone(this.#settleRecovery(lease, outcome));
      },
      () => {
        this.#env.clearTimeout(deadlineTimer);
        resolveDone(this.#settleRecovery(lease, { kind: "failed" }));
      },
    );

    return done;
  }

  #settleRecovery(lease: number, outcome: JoinOutcome): string | null {
    if (this.#activeRecoveryLease !== lease) return null;
    this.#activeRecoveryLease = null;
    this.#recoveryInFlight = false;
    if (this.#stopped) return null;
    if (outcome.kind === "superseded") {
      this.#handleSuperseded();
      return null;
    }
    if (outcome.kind !== "joined") {
      this.#dispatch({ type: "RECOVERY_FAILED", now: this.#env.now() });
      return null;
    }

    const joined = outcome.value;
    this.#sessionId = joined.id;
    this.#roomId = joined.roomId;
    this.#roomTicket = joined.roomTicket ?? this.#roomTicket;
    this.#callbacks.setLocalSessionId(joined.id);
    this.#callbacks.setRoomId(joined.roomId);
    this.#invalidateStream();
    this.#streamRetries = 0;
    if (this.#callbacks.readDownlinkEnabled()) {
      this.#openStream(joined.roomId);
    }
    this.#dispatch({
      type: "RECOVERY_OK",
      now: this.#env.now(),
      wsAdvertised: resolveWsAdvertised(joined),
    });
    this.#pump();
    return joined.roomId;
  }

  #handleSuperseded(): void {
    this.#dispatch({ type: "SUPERSEDED", now: this.#env.now() });
    if (this.#interval) {
      this.#env.clearInterval(this.#interval);
      this.#interval = null;
    }
    this.#invalidateStream();
    this.#callbacks.setNpcConnected(false);
    this.#callbacks.addToast(
      "↪️",
      "Your session is now active in another tab or device.",
      6_000,
    );
  }

  #openStream(roomId: string): void {
    if (
      this.#stopped ||
      !this.#callbacks.readDownlinkEnabled() ||
      this.#streamRetries >= MAX_STREAM_RETRIES
    ) {
      return;
    }
    this.#activeRetryToken = null;
    this.#streamEpoch += 1;
    const epoch = this.#streamEpoch;
    const source = this.#env.createEventSource(
      `${this.#apiBaseUrl}/api/world/${encodeURIComponent(roomId)}/stream`,
    );
    this.#eventSource = source;

    source.addEventListener("open", () => {
      if (epoch !== this.#streamEpoch) return;
      if (!this.#callbacks.readDownlinkEnabled()) return;
      if (source !== this.#eventSource) return;
      this.#streamRetries = 0;
      this.#lastStreamAttemptWasBareReopen = false;
      this.#callbacks.setNpcConnected(true);
    });
    source.addEventListener("snapshot", (event) => {
      if (epoch !== this.#streamEpoch) return;
      if (!this.#callbacks.readDownlinkEnabled()) return;
      if (source !== this.#eventSource) return;
      if (typeof event.data !== "string") return;
      try {
        const snapshot = measureSpike("sse:parse", () =>
          JSON.parse(event.data as string),
        ) as {
          npcs?: unknown;
          players?: unknown;
          collaborationEvents?: unknown;
        };
        this.#callbacks.setNpcConnected(true);
        if (Array.isArray(snapshot.npcs)) {
          measureSpike("sse:npcUpdate", () =>
            this.#callbacks.updateNpcsFromSnapshot(snapshot),
          );
        }
        if (Array.isArray(snapshot.players)) {
          measureSpike("sse:playerUpdate", () =>
            this.#callbacks.updatePlayersFromSnapshot(
              snapshot.players as PlayerSnapshot[],
            ),
          );
        }
        if (
          Array.isArray(snapshot.collaborationEvents) &&
          snapshot.collaborationEvents.length > 0
        ) {
          measureSpike("sse:collabUpdate", () =>
            this.#callbacks.addCollaborationEntries(
              snapshot.collaborationEvents as unknown[],
            ),
          );
        }
      } catch (error) {
        if (this.#env.isDev()) {
          console.warn(
            "[world-presence] snapshot parse/dispatch failed",
            error,
          );
        }
      }
    });
    source.addEventListener("land", () => {
      if (epoch !== this.#streamEpoch) return;
      if (!this.#callbacks.readDownlinkEnabled()) return;
      if (source !== this.#eventSource) return;
      this.#callbacks.invalidateLandQuery();
    });
    source.onerror = () => {
      if (epoch !== this.#streamEpoch) return;
      if (!this.#callbacks.readDownlinkEnabled()) return;
      if (source !== this.#eventSource) return;
      this.#callbacks.setNpcConnected(false);
      this.#dropFailedSource(source);
      if (this.#recoveryInFlight) return;
      this.#streamRetries += 1;
      if (this.#stopped || this.#streamRetries >= MAX_STREAM_RETRIES) return;
      const delay = Math.min(
        STREAM_RETRY_BASE_MS *
          Math.pow(2, Math.max(0, this.#streamRetries - 1)),
        STREAM_RETRY_MAX_MS,
      );
      const canRejoin = this.#sessionId !== null && this.#roomTicket !== null;
      const shouldEscalate = canRejoin && this.#lastStreamAttemptWasBareReopen;
      this.#armRetry(roomId, delay, shouldEscalate, null, epoch);
    };
  }

  #armRetry(
    roomId: string,
    delayMs: number,
    shouldEscalate: boolean,
    deferredSince: number | null = null,
    lineageEpoch = this.#streamEpoch,
  ): void {
    const token = ++this.#retryTokenSequence;
    this.#activeRetryToken = token;
    this.#streamRetryTimer = this.#env.setTimeout(() => {
      this.#streamRetryTimer = null;
      if (
        this.#stopped ||
        this.#activeRetryToken !== token ||
        lineageEpoch !== this.#streamEpoch ||
        !this.#callbacks.readDownlinkEnabled()
      ) {
        return;
      }

      if (this.#recoveryInFlight) {
        const since = deferredSince ?? this.#env.now();
        if (this.#env.now() - since >= RECOVERY_WAIT_CEILING_MS) {
          this.#activeRetryToken = null;
          return;
        }
        this.#armRetry(roomId, delayMs, shouldEscalate, since, lineageEpoch);
        return;
      }

      if (!shouldEscalate) {
        this.#lastStreamAttemptWasBareReopen = true;
        this.#openStream(roomId);
        return;
      }

      this.#lastStreamAttemptWasBareReopen = false;
      void this.#recoverWithTicket().then((rejoinedRoomId) => {
        if (this.#stopped || rejoinedRoomId !== null) return;
        if (this.#recoveryInFlight) {
          this.#armRetry(
            roomId,
            delayMs,
            shouldEscalate,
            deferredSince ?? this.#env.now(),
            lineageEpoch,
          );
          return;
        }
        if (
          this.#activeRetryToken !== token ||
          lineageEpoch !== this.#streamEpoch ||
          !this.#callbacks.readDownlinkEnabled()
        ) {
          return;
        }
        this.#lastStreamAttemptWasBareReopen = true;
        this.#openStream(roomId);
      });
    }, delayMs);
  }

  #dropFailedSource(source: WorldPresenceEventSourceLike): void {
    if (this.#eventSource !== source) return;
    source.close();
    this.#eventSource = null;
  }

  #invalidateStream(): void {
    this.#streamEpoch += 1;
    this.#activeRetryToken = null;
    this.#eventSource?.close();
    this.#eventSource = null;
    if (this.#streamRetryTimer) {
      this.#env.clearTimeout(this.#streamRetryTimer);
      this.#streamRetryTimer = null;
    }
  }

  #closeStream(): void {
    this.#invalidateStream();
    this.#streamRetries = 0;
    this.#lastStreamAttemptWasBareReopen = false;
    this.#callbacks.setNpcConnected(false);
    this.#callbacks.clearPlayers();
  }

  #openSocket(generation: number): void {
    if (this.#stopped || !this.#roomId || !this.#sessionId) {
      this.#dispatch({
        type: "SOCKET_CLOSED",
        now: this.#env.now(),
        generation,
      });
      return;
    }
    const socket = this.#env.createSocket(
      resolveUplinkUrl(this.#apiBaseUrl, this.#roomId),
    );
    this.#socket = socket;
    this.#diag.socketOpens += 1;

    socket.onopen = () => {
      if (
        socket !== this.#socket ||
        generation !== this.#state.socketGeneration
      ) {
        return;
      }
    };
    socket.onmessage = (event) => {
      if (
        socket !== this.#socket ||
        generation !== this.#state.socketGeneration
      ) {
        return;
      }
      this.#handleSocketMessage(socket, generation, event.data);
    };
    socket.onerror = () => {
      if (
        socket !== this.#socket ||
        generation !== this.#state.socketGeneration
      ) {
        return;
      }
    };
    socket.onclose = (event) => {
      if (
        socket !== this.#socket ||
        generation !== this.#state.socketGeneration
      ) {
        return;
      }
      this.#socket = null;
      this.#detachSocketHandlers(socket);
      this.#handleSocketClose(generation, event.code);
    };
  }

  #handleSocketMessage(
    socket: WorldPresenceSocketLike,
    generation: number,
    data: unknown,
  ): void {
    if (typeof data !== "string") {
      if (this.#env.isDev()) {
        console.warn("[world-presence] ignored non-text socket frame");
      }
      return;
    }
    let frame: WorldPresenceServerFrame;
    try {
      frame = JSON.parse(data) as WorldPresenceServerFrame;
    } catch (error) {
      if (this.#env.isDev()) {
        console.warn("[world-presence] ignored malformed socket frame", error);
      }
      return;
    }

    if (frame.type === "presence.ready") {
      if (
        frame.presenceId !== this.#sessionId ||
        frame.roomId !== this.#roomId
      ) {
        this.#dispatch({
          type: "TRANSPORT_LOSS",
          now: this.#env.now(),
          generation,
          reason: "membership_lost",
        });
        return;
      }
      this.#dispatch({
        type: "SOCKET_OPENED",
        now: this.#env.now(),
        generation,
      });
      this.#pump();
      return;
    }

    if (frame.type === "presence.ping") {
      const pong = {
        type: "presence.pong",
        serverTimeMs: frame.serverTimeMs,
      } satisfies WorldPresenceClientFrame;
      socket.send(JSON.stringify(pong));
      this.#diag.pongsSent += 1;
      return;
    }

    if (frame.type !== "presence.error") return;
    switch (frame.code) {
      case "membership_lost":
        this.#dispatch({
          type: "TRANSPORT_LOSS",
          now: this.#env.now(),
          generation,
          reason: "membership_lost",
        });
        return;
      case "socket_replaced":
      case "bad_frame":
      case "flood":
      case "transport_disabled":
        if (
          this.#env.isDev() &&
          (frame.code === "bad_frame" || frame.code === "flood")
        ) {
          console.error(
            `[world-presence] server rejected uplink: ${frame.code}`,
            frame.message,
          );
        }
        this.#dispatch({
          type: "TRANSPORT_STAND_DOWN",
          now: this.#env.now(),
          generation,
          reason: frame.code,
        });
        return;
      case "superseded":
        this.#handleSuperseded();
        return;
      case "server_shutdown":
        return;
    }
  }

  #handleSocketClose(generation: number, code?: number): void {
    const now = this.#env.now();
    if (code === WORLD_PRESENCE_WS_CLOSE_CODES.MEMBERSHIP_LOST) {
      this.#dispatch({
        type: "TRANSPORT_LOSS",
        now,
        generation,
        reason: "membership_lost",
      });
      return;
    }
    if (code === WORLD_PRESENCE_WS_CLOSE_CODES.SOCKET_REPLACED) {
      this.#dispatchStandDown(generation, "socket_replaced", now);
      return;
    }
    if (code === WORLD_PRESENCE_WS_CLOSE_CODES.BAD_FRAME) {
      if (this.#env.isDev()) {
        console.error("[world-presence] socket closed for bad_frame");
      }
      this.#dispatchStandDown(generation, "bad_frame", now);
      return;
    }
    if (code === WORLD_PRESENCE_WS_CLOSE_CODES.FLOOD) {
      if (this.#env.isDev()) {
        console.error("[world-presence] socket closed for flood");
      }
      this.#dispatchStandDown(generation, "flood", now);
      return;
    }
    if (code === WORLD_PRESENCE_WS_CLOSE_CODES.TRANSPORT_DISABLED) {
      this.#dispatchStandDown(generation, "transport_disabled", now);
      return;
    }
    if (code === WORLD_PRESENCE_WS_CLOSE_CODES.SUPERSEDED) {
      this.#handleSuperseded();
      return;
    }
    this.#dispatch({ type: "SOCKET_CLOSED", now, generation });
  }

  #dispatchStandDown(
    generation: number,
    reason: WorldTransportStandDownReason,
    now: number,
  ): void {
    this.#dispatch({
      type: "TRANSPORT_STAND_DOWN",
      now,
      generation,
      reason,
    });
  }

  #retireSocket(code = 1000): void {
    const socket = this.#socket;
    if (!socket) return;
    const generation = this.#state.socketGeneration;
    this.#socket = null;
    this.#detachSocketHandlers(socket);
    try {
      socket.close(code);
    } catch {
      return;
    }
    this.#dispatch({
      type: "SOCKET_CLOSED",
      now: this.#env.now(),
      generation,
    });
  }

  #detachSocketHandlers(socket: WorldPresenceSocketLike): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
  }

  #sampleActivePosition(now: number): ActivePresencePose {
    const position = this.#callbacks.readAvatarPosition();
    const x = position.x;
    const y = position.y;
    let activity: ActivePresenceActivity = "idle";
    if (this.#lastPosition) {
      const dx = x - this.#lastPosition.x;
      const dy = y - this.#lastPosition.y;
      const motionSq = dx * dx + dy * dy;
      if (motionSq > ACTIVITY_MOTION_EPSILON_PX * ACTIVITY_MOTION_EPSILON_PX) {
        activity = "walking";
        this.#lastDirection = Math.atan2(dx, dy);
      }
    }
    this.#lastPosition = { x, y, ts: now };
    this.#frozenPosition = { x, y, dirZ: this.#lastDirection };
    const pose = { ...this.#frozenPosition, activity };
    this.#initialActivePose ??= pose;
    return pose;
  }

  #activePoseChanged(pose: ActivePresencePose): boolean {
    const reference = this.#lastSentPose ?? this.#initialActivePose;
    if (!reference) return false;
    const dx = pose.x - reference.x;
    const dy = pose.y - reference.y;
    const positionChanged =
      dx * dx + dy * dy >
      ACTIVITY_MOTION_EPSILON_PX * ACTIVITY_MOTION_EPSILON_PX;
    const headingDelta = Math.abs(
      Math.atan2(
        Math.sin(pose.dirZ - reference.dirZ),
        Math.cos(pose.dirZ - reference.dirZ),
      ),
    );
    return (
      positionChanged ||
      headingDelta > HEADING_MOTION_EPSILON_RAD ||
      pose.activity !== reference.activity
    );
  }

  #uploadActivePosition(pose: ActivePresencePose): void {
    this.#lastSentPose = pose;
    this.#initialActivePose = null;
    this.#emitPose(pose);
  }

  #uploadRemotePosition(): void {
    if (!this.#frozenPosition) return;
    const pose = {
      ...this.#frozenPosition,
      activity: this.#callbacks.readRemoteActivity() ?? "idle",
    };
    this.#lastSentPose = pose;
    this.#emitPose(pose);
  }

  #emitPose(pose: SentPresencePose): void {
    if (this.#state.transport === "ws") {
      const socket = this.#socket;
      if (!socket || this.#state.socketPhase !== "open") return;
      const frame = {
        type: "presence.position",
        ...pose,
      } satisfies WorldPresencePositionFrame;
      socket.send(JSON.stringify(frame));
      this.#diag.socketFramesSent += 1;
      return;
    }
    this.#postPosition(pose);
  }

  #postPosition(pose: SentPresencePose): void {
    const epoch = this.#state.transportEpoch;
    const abort = this.#env.createAbortController();
    this.#inflightPositionAborts.add(abort);
    void this.#env
      .fetch(`${this.#apiBaseUrl}/api/world/position`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pose),
        keepalive: true,
        signal: abort.signal,
      })
      .then((response) => {
        if (epoch !== this.#state.transportEpoch) {
          this.#diag.httpPositionResponsesDiscarded += 1;
          return;
        }
        if (response.status === 409) {
          this.#dispatch({ type: "POSITION_409", now: this.#env.now() });
        }
      })
      .catch(() => {
        // Abort or network failure: best effort; server GC handles staleness.
      })
      .finally(() => {
        this.#inflightPositionAborts.delete(abort);
      });
    this.#diag.httpPositionPosts += 1;
  }

  #abortInflightPositions(): void {
    for (const abort of this.#inflightPositionAborts) abort.abort();
    this.#inflightPositionAborts.clear();
  }

  #sendLeave(force = false): void {
    if (!force && !this.#sessionId) return;
    try {
      void this.#env
        .fetch(`${this.#apiBaseUrl}/api/world/leave`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
          keepalive: true,
        })
        .catch(() => {
          // Fire and forget.
        });
    } catch {
      // Best effort; server GC handles staleness.
    }
  }

  #handlePageLifecycle(event: PageLifecycleEvent): void {
    if (this.#stopped) return;
    if (event.type === "pagehide") {
      this.#pageHiddenPersisted = event.persisted;
      this.#sendLeave();
      this.#invalidateStream();
      this.#retireSocket();
      this.#callbacks.setNpcConnected(false);
      return;
    }
    if (event.persisted && this.#pageHiddenPersisted) {
      this.#pageHiddenPersisted = false;
      this.#invalidateStream();
      this.#sessionId = null;
      this.#roomId = null;
      this.#roomTicket = null;
      this.#callbacks.setLocalSessionId(null);
      this.#callbacks.setRoomId(null);
      this.#callbacks.clearPlayers();
      this.#dispatch({ type: "SESSION_RESET", now: this.#env.now() });
      this.#pump();
      return;
    }
    if (
      !this.#stopped &&
      this.#sessionId &&
      this.#roomId &&
      !this.#eventSource &&
      this.#callbacks.readDownlinkEnabled()
    ) {
      this.#streamRetries = 0;
      this.#openStream(this.#roomId);
    }
  }
}
