"use client";

import { useCallback, useEffect, useMemo } from "react";
import {
  KIT_CATALOG,
  KIT_LEVEL_RULES,
  KIT_PIECE_KEYS,
  isKitPaymentRailAllowed,
  isRotationAllowed,
  kitPieceFeeCt,
  kitPieceFeeMaterials,
  parcelDisplayName,
  parseParcelCode,
  type KitPieceKey,
  type KitPieceSize,
  type LandStructureType,
} from "@clawville/shared";
import { useAvatar } from "@/hooks/use-avatar";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { api } from "@/lib/api";
import {
  YARD_RESERVED_SHELL_HINT,
  clampKitStructureLevel,
  isStackBasePiece,
  ownerPiecesToPlacedPieces,
  stackingHintLines,
} from "@/lib/land-yard-editor";
import { resetJump } from "@/lib/three/jump-state";
import { useGameStore } from "@/stores/game";
import { useSalvageStore } from "@/stores/salvage";
import {
  useLandStore,
  type PaymentRail,
  type PlacedPiece,
  type YardEditorMode,
} from "@/stores/land";

const PANEL_BG =
  "linear-gradient(160deg, rgba(6,20,38,0.98), rgba(10,40,72,0.98))";
const TEXT = "#f0f9ff";
const MUTED = "#bae6fd";
const GOLD = "#fde68a";
const EMPTY_PIECES: readonly PlacedPiece[] = Object.freeze([]);
/** Light text on a dark panel, shared by every guidance line in the drawer. */
const HINT_TEXT: React.CSSProperties = {
  margin: 0,
  color: MUTED,
  fontSize: 12,
  lineHeight: 1.4,
};
const KIT_KEYS_BY_SIZE: Readonly<Record<KitPieceSize, readonly KitPieceKey[]>> =
  {
    small: KIT_PIECE_KEYS.filter(
      (pieceKey) => KIT_CATALOG[pieceKey].size === "small",
    ),
    large: KIT_PIECE_KEYS.filter(
      (pieceKey) => KIT_CATALOG[pieceKey].size === "large",
    ),
  };

function modeLabel(mode: YardEditorMode): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

/** Rail-aware price display. Server is always authoritative for what is actually charged. */
function pieceRailPrice(
  structureType: LandStructureType,
  size: KitPieceSize,
  paymentRail: PaymentRail,
): string {
  return paymentRail === "materials"
    ? `${kitPieceFeeMaterials(size)} materials`
    : `${kitPieceFeeCt(structureType, size)} vCLAW`;
}

function CatalogGroup({
  size,
  used,
  cap,
  structureType,
  paymentRail,
}: {
  size: KitPieceSize;
  used: number;
  cap: number;
  /**
   * Drives the price chip. This used to read the deprecated flat fee table,
   * which is the SHOP row, so a home yard advertised 15/60 while the server
   * charged the home price of 5/20. The server was always authoritative, so
   * nobody was overcharged — but the editor was quoting a player a price four
   * times what they would actually pay, on the exact screen where they decide
   * whether they can afford it.
   */
  structureType: LandStructureType;
  /** 'materials' only ever reaches here for a HOME yard — see the toggle below. */
  paymentRail: PaymentRail;
}) {
  const selectedPieceKey = useLandStore((state) => state.selectedPieceKey);
  const setSelectedPieceKey = useLandStore(
    (state) => state.setSelectedPieceKey,
  );
  const setMode = useLandStore((state) => state.setYardEditorMode);
  const capReached = used >= cap;
  const disabledReason =
    cap === 0
      ? `${size === "large" ? "Large" : "Small"} pieces unlock at a higher level.`
      : capReached
        ? `${size === "large" ? "Large" : "Small"} piece limit reached.`
        : null;

  return (
    <section aria-labelledby={`yard-${size}-heading`}>
      <div
        id={`yard-${size}-heading`}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          margin: "14px 2px 8px",
          color: TEXT,
          fontSize: 13,
          fontWeight: 900,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        <span>{size}</span>
        <span style={{ color: GOLD, letterSpacing: 0, textTransform: "none" }}>
          {used} of {cap} used
          {cap > 0 ? ` · ${pieceRailPrice(structureType, size, paymentRail)} each` : ""}
        </span>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {KIT_KEYS_BY_SIZE[size].map((pieceKey) => {
          const item = KIT_CATALOG[pieceKey];
          const selected = selectedPieceKey === pieceKey;
          const disabled = disabledReason !== null;
          return (
            <button
              key={pieceKey}
              type="button"
              disabled={disabled}
              title={disabledReason ?? `Place ${item.displayName}`}
              onClick={() => {
                setSelectedPieceKey(pieceKey);
                setMode("place");
              }}
              style={{
                minHeight: 54,
                width: "100%",
                padding: "8px 10px",
                borderRadius: 12,
                border: selected
                  ? "1.5px solid rgba(34,211,238,0.95)"
                  : "1px solid rgba(125,211,252,0.24)",
                background: selected
                  ? "rgba(8,145,178,0.32)"
                  : disabled
                    ? "rgba(15,23,42,0.46)"
                    : "rgba(14,48,80,0.72)",
                color: disabled ? "rgba(186,230,253,0.48)" : TEXT,
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) auto",
                alignItems: "center",
                gap: 8,
                textAlign: "left",
                cursor: disabled ? "not-allowed" : "pointer",
                touchAction: "manipulation",
              }}
            >
              <span style={{ minWidth: 0 }}>
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 6,
                    fontSize: 14,
                    fontWeight: 800,
                  }}
                >
                  {item.displayName}
                  {/* Derived from the manifest's `supportSurfaceYWu`, never a
                      hand-written key list — so a re-authored piece that gains
                      or loses a support surface relabels itself. */}
                  {isStackBasePiece(pieceKey) ? (
                    <span
                      title="Other pieces can be placed on top of this one."
                      style={{
                        borderRadius: 999,
                        padding: "2px 7px",
                        background: "rgba(16,185,129,0.16)",
                        border: "1px solid rgba(110,231,183,0.42)",
                        color: disabled ? "inherit" : "rgba(167,243,208,0.95)",
                        fontSize: 10,
                        fontWeight: 900,
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Stackable base
                    </span>
                  ) : null}
                </span>
                <span
                  style={{
                    display: "block",
                    color: disabled ? "inherit" : MUTED,
                    fontSize: 11,
                  }}
                >
                  {disabledReason ?? `${used} of ${cap} ${size} used`}
                </span>
              </span>
              <span
                style={{
                  borderRadius: 999,
                  padding: "5px 8px",
                  background: "rgba(251,191,36,0.16)",
                  border: "1px solid rgba(251,191,36,0.38)",
                  color: disabled ? "inherit" : GOLD,
                  fontSize: 12,
                  fontWeight: 900,
                  whiteSpace: "nowrap",
                }}
              >
                {pieceRailPrice(structureType, size, paymentRail)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export default function YardEditorOverlay() {
  const isMobile = useIsMobile();
  const { data: avatar } = useAvatar();
  const buildMode = useLandStore((state) => state.buildMode);
  const mode = useLandStore((state) => state.yardEditorMode);
  const rotationStep = useLandStore((state) => state.rotationStep);
  const selectedPlacedPieceId = useLandStore(
    (state) => state.selectedPlacedPieceId,
  );
  const pieces = useLandStore((state) => state.pieces);
  const structure = useLandStore((state) =>
    buildMode ? (state.structures.get(buildMode.parcelCode) ?? null) : null,
  );
  const exitBuildMode = useLandStore((state) => state.exitBuildMode);
  const setBuildParcelId = useLandStore((state) => state.setBuildParcelId);
  const setParcelPieces = useLandStore((state) => state.setParcelPieces);
  const setMode = useLandStore((state) => state.setYardEditorMode);
  const setRotationStep = useLandStore((state) => state.setRotationStep);
  const setSelectedPlacedPieceId = useLandStore(
    (state) => state.setSelectedPlacedPieceId,
  );
  const paymentRail = useLandStore((state) => state.paymentRail);
  const setPaymentRail = useLandStore((state) => state.setPaymentRail);
  const materialBalance = useSalvageStore((state) => state.materialBalance);
  // Clamp bounds come from the shared ladder (`KIT_LEVEL_RULES`), never a
  // typed `5` — a level added there widens this automatically.
  const level = clampKitStructureLevel(structure?.level);
  // Same fallback shape as `level` above, and reachable for the same reason:
  // the editor only opens on a parcel with an ACTIVE structure, so a null here
  // is the brief window before the owner overlay hydrates. The server reads the
  // type off the locked row and is authoritative for what is actually charged.
  const structureType: LandStructureType = structure?.structureType ?? 'home';
  const levelRule = KIT_LEVEL_RULES[level];
  const parcelPieces = buildMode
    ? (pieces.get(buildMode.parcelCode) ?? EMPTY_PIECES)
    : EMPTY_PIECES;
  const counts = useMemo(() => {
    let small = 0;
    let large = 0;
    for (const piece of parcelPieces) {
      const entry = KIT_CATALOG[piece.pieceKey as KitPieceKey];
      if (!entry) continue;
      if (entry.size === "small") small += 1;
      else large += 1;
    }
    return { small, large };
  }, [parcelPieces]);

  const rotate = useCallback(() => {
    const increment = levelRule.rotationDegrees === 90 ? 2 : 1;
    let next = (rotationStep + increment) % 8;
    while (!isRotationAllowed(level, next)) next = (next + increment) % 8;
    setRotationStep(next);
  }, [level, levelRule.rotationDegrees, rotationStep, setRotationStep]);

  useEffect(() => {
    if (!buildMode) return;
    let cancelled = false;
    const hydrateOwnerPieces = async (): Promise<void> => {
      try {
        const land = await api.getMyLand();
        if (cancelled) return;
        const parcel = land.parcels.find(
          (candidate) => candidate.parcelCode === buildMode.parcelCode,
        );
        if (!parcel) {
          useGameStore
            .getState()
            .addToast("⚠️", "Your parcel is still syncing — try again.", 4200);
          return;
        }

        setBuildParcelId(parcel.id);
        try {
          const response = await api.getLandParcelPieces(parcel.id);
          if (cancelled) return;
          setParcelPieces(
            buildMode.parcelCode,
            ownerPiecesToPlacedPieces(buildMode.parcelCode, response.pieces),
          );
        } catch {
          if (!cancelled) {
            useGameStore
              .getState()
              .addToast("⚠️", "Yard pieces couldn't sync — reopen Decorate to retry.", 4200);
          }
        }
      } catch {
        if (!cancelled) {
          useGameStore
            .getState()
            .addToast("⚠️", "Your parcel is still syncing — try again.", 4200);
        }
      }
    };
    void hydrateOwnerPieces();
    return () => {
      cancelled = true;
    };
  }, [buildMode, setBuildParcelId, setParcelPieces]);

  // Defense in depth alongside enterBuildMode's reset: if the structure DTO
  // resolves AFTER mount and turns out to be a shop, snap the rail back
  // rather than leaving a shop yard mid-selection on a rail the server will
  // refuse. `isKitPaymentRailAllowed` is the shared single authority — the
  // route, the hosted executor verb and this UI all read the same function.
  useEffect(() => {
    if (buildMode && paymentRail === "materials" && !isKitPaymentRailAllowed("materials", structureType)) {
      setPaymentRail("vclaw");
    }
  }, [buildMode, paymentRail, setPaymentRail, structureType]);

  useEffect(() => {
    if (!buildMode || !isMobile) return;
    const previousMovementFrozen = useGameStore.getState().movementFrozen;
    resetJump();
    useGameStore.getState().setJoystickVelocity(0, 0);
    useGameStore.getState().setCameraJoystickVelocity(0, 0);
    useGameStore.setState({ movementFrozen: true });
    return () => {
      useGameStore.getState().setJoystickVelocity(0, 0);
      useGameStore.getState().setCameraJoystickVelocity(0, 0);
      useGameStore.setState({ movementFrozen: previousMovementFrozen });
    };
  }, [buildMode, isMobile]);

  useEffect(() => {
    if (!buildMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (mode === "move" && selectedPlacedPieceId)
          setSelectedPlacedPieceId(null);
        else exitBuildMode();
        return;
      }
      if (!isMobile && mode === "place" && event.key.toLowerCase() === "r") {
        event.preventDefault();
        rotate();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    buildMode,
    exitBuildMode,
    isMobile,
    mode,
    rotate,
    selectedPlacedPieceId,
    setSelectedPlacedPieceId,
  ]);

  if (!buildMode) return null;
  const modeHint =
    mode === "move"
      ? selectedPlacedPieceId
        ? "Tap a grid cell to move the highlighted piece. Esc cancels selection."
        : "Tap one of your pieces, then tap its new grid cell."
      : mode === "remove"
        ? "Tap a piece to remove it. Removal has no refund."
        : isMobile
          ? "Choose a piece, tap a cell to place it, and use Rotate for a new angle."
          : "Choose a piece, hover a cell and click to place it, and press R to rotate.";
  const stackingLines = stackingHintLines(level);
  const parcelTier = parseParcelCode(buildMode.parcelCode)?.tier;
  const displayName = parcelTier
    ? parcelDisplayName(buildMode.parcelCode, parcelTier)
    : buildMode.parcelCode;

  const topButton = (active = false): React.CSSProperties => ({
    minHeight: 44,
    minWidth: 44,
    borderRadius: 10,
    border: active
      ? "1px solid rgba(34,211,238,0.9)"
      : "1px solid rgba(125,211,252,0.28)",
    background: active ? "rgba(8,145,178,0.42)" : "rgba(15,50,82,0.76)",
    color: TEXT,
    padding: "8px 10px",
    fontSize: 12,
    fontWeight: 900,
    cursor: "pointer",
    touchAction: "manipulation",
  });

  return (
    <aside
      aria-label="Decorate your yard"
      style={{
        position: "fixed",
        zIndex: 70,
        ...(isMobile
          ? {
              left: 0,
              right: 0,
              bottom: 0,
              maxHeight: "min(62dvh, 620px)",
              borderRadius: "18px 18px 0 0",
              paddingBottom: "max(env(safe-area-inset-bottom, 0px), 10px)",
            }
          : {
              top: 82,
              right: 20,
              bottom: 92,
              width: 348,
              borderRadius: 18,
            }),
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: PANEL_BG,
        border: "1.5px solid rgba(56,189,248,0.38)",
        boxShadow:
          "0 24px 70px rgba(2,8,23,0.58), 0 0 36px rgba(14,165,233,0.18)",
        color: TEXT,
        backdropFilter: "blur(14px)",
      }}
    >
      <div
        style={{
          padding: isMobile ? "10px 12px 9px" : "14px 14px 10px",
          borderBottom: "1px solid rgba(125,211,252,0.18)",
          background: "rgba(3,15,29,0.42)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <span style={{ minWidth: 0 }}>
            <span
              style={{
                display: "block",
                color: TEXT,
                fontSize: 16,
                fontWeight: 950,
              }}
            >
              Decorate your yard
            </span>
            <span
              style={{
                display: "block",
                color: MUTED,
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {displayName} · Building Lv{level}
            </span>
          </span>
          <button
            type="button"
            onClick={exitBuildMode}
            style={{ ...topButton(), paddingInline: 14 }}
          >
            Done
          </button>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr)) auto",
            gap: 6,
            marginTop: 10,
          }}
        >
          {(["place", "move", "remove"] as const).map((editorMode) => (
            <button
              key={editorMode}
              type="button"
              onClick={() => setMode(editorMode)}
              style={topButton(mode === editorMode)}
              aria-pressed={mode === editorMode}
            >
              {modeLabel(editorMode)}
            </button>
          ))}
          <button
            type="button"
            onClick={rotate}
            disabled={mode !== "place"}
            style={{
              ...topButton(false),
              opacity: mode === "place" ? 1 : 0.44,
              cursor: mode === "place" ? "pointer" : "not-allowed",
            }}
            title={
              isMobile ? "Rotate selected piece" : "Rotate selected piece (R)"
            }
          >
            ↻ {rotationStep * 45}°
          </button>
        </div>
        <div
          style={{
            marginTop: 9,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            borderRadius: 10,
            padding: "8px 10px",
            background: "rgba(2,132,199,0.14)",
            color: TEXT,
          }}
        >
          <span style={{ color: MUTED, fontSize: 12, fontWeight: 800 }}>
            Balance
          </span>
          <span style={{ color: GOLD, fontSize: 14, fontWeight: 950 }}>
            {(avatar?.clawTokens ?? 0).toLocaleString()} vCLAW
          </span>
        </div>
        {/* Materials rail toggle — gated by the SAME isKitPaymentRailAllowed
            the server enforces (HOME-only, §3.3: shops always pay vCLAW). */}
        {isKitPaymentRailAllowed("materials", structureType) && (
          <div
            style={{
              marginTop: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              borderRadius: 10,
              padding: "8px 10px",
              background: "rgba(16,185,129,0.10)",
              color: TEXT,
            }}
          >
            <span
              style={{
                color: "rgba(110,231,183,0.9)",
                fontSize: 12,
                fontWeight: 800,
              }}
            >
              🪸 {materialBalance.toLocaleString()} materials
            </span>
            <div
              role="radiogroup"
              aria-label="Payment rail"
              style={{ display: "flex", gap: 4, borderRadius: 999, background: "rgba(3,15,29,0.5)", padding: 3 }}
            >
              {(["vclaw", "materials"] as const).map((rail) => (
                <button
                  key={rail}
                  type="button"
                  role="radio"
                  aria-checked={paymentRail === rail}
                  onClick={() => setPaymentRail(rail)}
                  style={{
                    minHeight: 32,
                    minWidth: 44,
                    padding: "4px 10px",
                    borderRadius: 999,
                    border: "none",
                    fontSize: 11,
                    fontWeight: 900,
                    cursor: "pointer",
                    touchAction: "manipulation",
                    background: paymentRail === rail ? "rgba(16,185,129,0.42)" : "transparent",
                    color: paymentRail === rail ? "#ecfdf5" : MUTED,
                  }}
                >
                  {rail === "vclaw" ? "vCLAW" : "Materials"}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div
        style={{
          minHeight: 0,
          overflowY: "auto",
          overscrollBehavior: "contain",
          padding: "0 12px 14px",
          WebkitOverflowScrolling: "touch",
        }}
      >
        {/* Guidance block. The place-mode hint carries the stacking rules,
            because stacking has NO player input: the ghost lifts itself to the
            highest legal level on hover, so without this a player has no way to
            learn it exists. Both the piece names and the unlock level are
            DERIVED from the shared constants (see lib/land-yard-editor). */}
        <div style={{ margin: "10px 2px 0", display: "grid", gap: 6 }}>
          <p style={HINT_TEXT}>{modeHint}</p>
          {mode === "place"
            ? stackingLines.map((line) => (
                <p key={line} style={HINT_TEXT}>
                  {line}
                </p>
              ))
            : null}
          {/* The reserved centre is drawn at the tier's MAX building level, so
              at Lv1 it looks far too big for the building standing in it. Named
              here in the DOM: no 3D text ever goes in a world scene. */}
          <p style={HINT_TEXT}>{YARD_RESERVED_SHELL_HINT}</p>
        </div>
        <CatalogGroup
          size="small"
          used={counts.small}
          cap={levelRule.smallPieceCap}
          structureType={structureType}
          paymentRail={paymentRail}
        />
        <CatalogGroup
          size="large"
          used={counts.large}
          cap={levelRule.largePieceCap}
          structureType={structureType}
          paymentRail={paymentRail}
        />
      </div>
    </aside>
  );
}
