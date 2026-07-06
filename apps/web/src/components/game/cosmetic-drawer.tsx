'use client';

/**
 * Cosmetic drawer — "The Wardrobe".
 *
 * Aesthetic identity
 * ------------------
 * The cosmetics shop is a first-party CT wardrobe (skins, hats, auras,
 * boards, emotes …). It now wears the same @/components/rpg toolkit chrome
 * as the Exchange / Land Office / Bounty board so the polish bar matches the
 * rest of the Gameify surface — rune-framed modal, rarity-tiered cosmetic
 * tiles (RuneFrame), CT token badge, themed empty states.
 *
 * Cyan/wardrobe palette: the modal sits on the `rare` (cyan) tier so the
 * chrome reads "cosmetics / loadout" rather than "marketplace" (amber) or
 * "quest" (purple).
 *
 * Two tabs:
 *   - OWNED — the avatar's owned skins, each toggling Equip / Equipped.
 *   - SHOP  — the purchasable catalog, each Buy / Owned.
 *
 * Category filter chips scope both tabs (all / hat / glasses / emote / aura /
 * board / particle / palette / outfit). The drawer opens to SHOP when the
 * player owns nothing (smart default), otherwise OWNED.
 *
 * All data flows through @/hooks/use-cosmetics — this file is presentation
 * + tab/filter orchestration only. The public API
 * (`<CosmeticDrawer open onClose />`) is unchanged so the page.tsx mount and
 * the `setCosmeticDrawerOpen` store trigger keep working untouched.
 */

import { useMemo, useState, type ReactNode } from 'react';
import {
  useOwnedCosmetics,
  useEquipCosmetic,
  useCosmeticCatalog,
  useBuyCosmetic,
  type OwnedCosmetic,
  type CosmeticCatalogItem,
} from '@/hooks/use-cosmetics';
import { useAvatar } from '@/hooks/use-avatar';
import {
  RpgModal,
  RpgButton,
  RpgTooltip,
  RuneSpinner,
  RuneFrame,
  StatusChip,
  type RarityId,
} from '@/components/rpg';

// ─── Categories ─────────────────────────────────────────────────────────────

const CATEGORY_FILTERS: { id: string; label: string; icon: string }[] = [
  { id: 'all', label: 'All', icon: '✨' },
  { id: 'hat', label: 'Hats', icon: '🎩' },
  { id: 'glasses', label: 'Glasses', icon: '🕶️' },
  { id: 'emote', label: 'Emotes', icon: '💃' },
  { id: 'aura', label: 'Auras', icon: '🌟' },
  { id: 'board', label: 'Boards', icon: '🏄' },
  { id: 'particle', label: 'Particles', icon: '✦' },
  { id: 'palette', label: 'Palettes', icon: '🎨' },
  { id: 'outfit', label: 'Outfits', icon: '👕' },
];

const CATEGORY_ICONS: Record<string, string> = Object.fromEntries(
  CATEGORY_FILTERS.map((c) => [c.id, c.icon]),
);

/**
 * Cosmetic rarity strings → the RPG toolkit's RarityId tiers.
 *   common  → common  (grey)
 *   rare    → rare    (blue)
 *   epic    → epic    (purple)
 *   limited → legendary (amber, pulses)
 * Anything unmapped falls back to common (getRarity already guards, but we
 * normalise here so the chip label + frame stay consistent).
 */
function cosmeticRarity(raw: string): RarityId {
  switch (raw) {
    case 'rare':
      return 'rare';
    case 'epic':
      return 'epic';
    case 'limited':
      return 'legendary';
    case 'common':
    default:
      return 'common';
  }
}

// ─── Header CT pill (mirrors Exchange CtPill, labelled for the CT wardrobe) ──

function CtPill({ tokens }: { tokens: number }) {
  return (
    <RpgTooltip content="Your ClawToken balance. Cosmetics are priced in CT — earn more by playing.">
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 14px',
          borderRadius: 999,
          background:
            'linear-gradient(180deg, rgba(56, 189, 248, 0.10) 0%, rgba(56, 189, 248, 0.04) 100%)',
          border: '1px solid rgba(56, 189, 248, 0.4)',
          color: '#7dd3fc',
          fontFamily: 'var(--font-orbitron), sans-serif',
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '0.05em',
          textShadow: '0 0 8px rgba(56, 189, 248, 0.4)',
        }}
      >
        <span style={{ fontSize: 13 }} aria-hidden>
          🪙
        </span>
        {tokens} CT
      </span>
    </RpgTooltip>
  );
}

// ─── Header sigil (wardrobe / loadout crest) ────────────────────────────────

function WardrobeSigil() {
  return (
    <span
      aria-hidden
      style={{
        fontFamily: 'var(--font-orbitron), sans-serif',
        fontSize: 22,
        background:
          'linear-gradient(135deg, #a5f3fc 0%, #38bdf8 45%, #818cf8 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
        filter: 'drop-shadow(0 0 6px rgba(125, 211, 252, 0.4))',
      }}
    >
      ✦
    </span>
  );
}

// ─── Thumbnail (PNG with emoji fallback on 404) ─────────────────────────────

/**
 * Square thumbnail slot used by both OwnedCard and ShopCard. Renders the
 * SKU's pre-baked PNG when one exists, falls back to the category emoji if
 * no thumbnail is set OR the image 404s at load time (onError → state).
 * Image is lazy-loaded + decoded async so the drawer doesn't block its
 * initial paint on N preview fetches.
 */
function CosmeticThumbnail({
  thumbnailUrl,
  fallbackIcon,
  displayName,
  rarity,
}: {
  thumbnailUrl: string | null;
  fallbackIcon: string;
  displayName: string;
  rarity: RarityId;
}) {
  const [errored, setErrored] = useState(false);
  const showImage = !!thumbnailUrl && !errored;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        aspectRatio: '1 / 1',
        width: '100%',
        overflow: 'hidden',
        borderRadius: 10,
        fontSize: 36,
        background:
          'radial-gradient(circle at 50% 35%, rgba(56, 189, 248, 0.08) 0%, rgba(5, 16, 30, 0.85) 70%)',
        border: '1px solid rgba(56, 189, 248, 0.12)',
        boxShadow: 'inset 0 0 24px rgba(0, 0, 0, 0.45)',
      }}
      data-rarity={rarity}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumbnailUrl!}
          alt={displayName}
          loading="lazy"
          decoding="async"
          onError={() => setErrored(true)}
          style={{ height: '100%', width: '100%', objectFit: 'contain' }}
        />
      ) : (
        <span aria-hidden>{fallbackIcon}</span>
      )}
    </div>
  );
}

// ─── Tab strip (mirrors Exchange TabStrip) ──────────────────────────────────

type Tab = 'owned' | 'shop';

function TabStrip({
  tab,
  onChange,
  ownedCount,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
  ownedCount: number;
}) {
  const tabs: { key: Tab; label: string; icon: string }[] = [
    { key: 'owned', label: ownedCount > 0 ? `Owned · ${ownedCount}` : 'Owned', icon: '🎒' },
    { key: 'shop', label: 'Shop', icon: '🛒' },
  ];
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        padding: '10px 22px 0',
        borderBottom: '1px solid rgba(56, 189, 248, 0.15)',
      }}
    >
      {tabs.map((t) => {
        const isActive = tab === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            style={{
              position: 'relative',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '10px 18px',
              background: 'transparent',
              border: 'none',
              fontFamily: 'var(--font-orbitron), sans-serif',
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              color: isActive ? '#7dd3fc' : '#64748b',
              cursor: 'pointer',
              transition: 'color 180ms ease',
            }}
          >
            <span aria-hidden style={{ fontSize: 13 }}>
              {t.icon}
            </span>
            {t.label}
            <span
              aria-hidden
              style={{
                position: 'absolute',
                left: 12,
                right: 12,
                bottom: -1,
                height: 2,
                background: isActive
                  ? 'linear-gradient(90deg, transparent 0%, #38bdf8 50%, transparent 100%)'
                  : 'transparent',
                boxShadow: isActive ? '0 0 10px rgba(56, 189, 248, 0.55)' : 'none',
                transition: 'background 200ms ease',
              }}
            />
          </button>
        );
      })}
    </div>
  );
}

// ─── Category chip strip (mirrors Exchange CategoryChips) ────────────────────

function CategoryChips({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {CATEGORY_FILTERS.map((c) => {
        const active = c.id === value;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onChange(c.id)}
            style={{
              padding: '5px 12px',
              borderRadius: 999,
              background: active
                ? 'rgba(56, 189, 248, 0.15)'
                : 'rgba(10, 22, 40, 0.55)',
              border: `1px solid ${active ? 'rgba(56, 189, 248, 0.55)' : 'rgba(148, 163, 184, 0.2)'}`,
              color: active ? '#7dd3fc' : '#94a3b8',
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              transition: 'all 180ms ease',
            }}
          >
            <span style={{ fontSize: 11, opacity: active ? 1 : 0.6 }} aria-hidden>
              {c.icon}
            </span>
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Empty / loading / error states (mirror Exchange EmptyState) ────────────

function EmptyState({
  glyph,
  title,
  body,
  cta,
}: {
  glyph: string;
  title: string;
  body: string;
  cta?: ReactNode;
}) {
  return (
    <div
      style={{
        gridColumn: '1 / -1',
        textAlign: 'center',
        padding: '50px 24px 60px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <div
        aria-hidden
        style={{
          fontSize: 38,
          opacity: 0.75,
          filter: 'drop-shadow(0 0 10px rgba(125, 211, 252, 0.4))',
          marginBottom: 4,
        }}
      >
        {glyph}
      </div>
      <h3
        style={{
          fontFamily: 'var(--font-orbitron), sans-serif',
          fontSize: 14,
          color: '#e2e8f0',
          margin: 0,
          letterSpacing: '0.08em',
        }}
      >
        {title}
      </h3>
      <p
        style={{
          maxWidth: 380,
          margin: 0,
          fontSize: 12,
          color: '#94a3b8',
          lineHeight: 1.6,
        }}
      >
        {body}
      </p>
      {cta && <div style={{ marginTop: 12 }}>{cta}</div>}
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div
      style={{
        gridColumn: '1 / -1',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: '70px 0',
      }}
    >
      <RuneSpinner size={48} tier="rare" />
      <span
        style={{
          fontSize: 10,
          color: '#64748b',
          textTransform: 'uppercase',
          letterSpacing: '0.24em',
        }}
      >
        {label}
      </span>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div style={{ gridColumn: '1 / -1' }}>
      <EmptyState
        glyph="⚠"
        title="Couldn't load the wardrobe"
        body={message || 'Something went wrong fetching cosmetics. Try reopening the drawer.'}
      />
    </div>
  );
}

// ─── Grid wrapper — responsive 2/3/4 cols, reflows via auto-fill ────────────

const GRID_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
  gap: 14,
  padding: '18px 22px 24px',
  minHeight: 260,
};

// ─── Owned tab ──────────────────────────────────────────────────────────────

function OwnedTab({
  filter,
  onGoShop,
}: {
  filter: string;
  onGoShop: () => void;
}) {
  const { data, isLoading, isError, error } = useOwnedCosmetics();
  const equip = useEquipCosmetic();

  const filtered = useMemo(() => {
    if (!data) return [];
    if (filter === 'all') return data.owned;
    return data.owned.filter((o) => o.sku.category === filter);
  }, [data, filter]);

  if (isLoading) {
    return (
      <div style={GRID_STYLE}>
        <LoadingState label="Opening the wardrobe" />
      </div>
    );
  }
  if (isError) {
    return (
      <div style={GRID_STYLE}>
        <ErrorState message={(error as Error)?.message ?? ''} />
      </div>
    );
  }
  if (filtered.length === 0) {
    const hasAny = (data?.owned ?? []).length > 0;
    return (
      <div style={GRID_STYLE}>
        {hasAny ? (
          <EmptyState
            glyph="🧥"
            title="Nothing in this drawer"
            body={`You don't own any ${filter} cosmetics yet. Try another category, or hit the Shop.`}
            cta={
              <RpgButton variant="primary" size="md" rarity="rare" onClick={onGoShop}>
                Browse Shop
              </RpgButton>
            }
          />
        ) : (
          <EmptyState
            glyph="✨"
            title="Your wardrobe is empty"
            body="You haven't collected any cosmetics yet. Open the Shop to claim your first skin, hat, or aura."
            cta={
              <RpgButton variant="primary" size="md" rarity="rare" onClick={onGoShop}>
                Open the Shop
              </RpgButton>
            }
          />
        )}
      </div>
    );
  }

  return (
    <div style={GRID_STYLE}>
      {filtered.map((o) => (
        <OwnedCard
          key={o.id}
          cosmetic={o}
          onToggle={() => equip.mutate({ skuId: o.sku.id, equipped: !o.equipped })}
          pending={equip.isPending}
        />
      ))}
    </div>
  );
}

/**
 * Shared rarity-framed cosmetic tile. Renders a full-width aspect-square
 * thumbnail HERO block at the top (via RuneFrame so the rarity edge + rune
 * corners are free), then name, badge row, optional description, and a
 * footer action slot.
 *
 * NOTE: we deliberately do NOT use ItemCard here — ItemCard funnels its
 * `icon` into a fixed 48×48 glyph slot (glow.css `.rpg-item-card__icon`),
 * which would squash the cosmetic preview to a chip. RuneFrame + a custom
 * body keeps the preview at hero size while still inheriting the toolkit's
 * rarity chrome.
 */
function CosmeticCard({
  rarity,
  thumbnailUrl,
  fallbackIcon,
  displayName,
  badges,
  caption,
  glow,
  footer,
}: {
  rarity: RarityId;
  thumbnailUrl: string | null;
  fallbackIcon: string;
  displayName: string;
  badges: ReactNode;
  caption?: ReactNode;
  glow?: 'subtle' | false;
  footer: ReactNode;
}) {
  return (
    <RuneFrame tier={rarity} glow={glow ?? false} interactive={false}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: 12,
        }}
      >
        <CosmeticThumbnail
          thumbnailUrl={thumbnailUrl}
          fallbackIcon={fallbackIcon}
          displayName={displayName}
          rarity={rarity}
        />
        <h3
          style={{
            margin: 0,
            fontFamily: 'var(--font-orbitron), sans-serif',
            fontSize: 12,
            fontWeight: 700,
            color: '#e2e8f0',
            letterSpacing: '0.02em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={displayName}
        >
          {displayName}
        </h3>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 4,
            alignItems: 'center',
            minHeight: 16,
          }}
        >
          {badges}
        </div>
        {caption}
        <div style={{ marginTop: 2 }}>{footer}</div>
      </div>
    </RuneFrame>
  );
}

function OwnedCard({
  cosmetic,
  onToggle,
  pending,
}: {
  cosmetic: OwnedCosmetic;
  onToggle: () => void;
  pending: boolean;
}) {
  const icon = CATEGORY_ICONS[cosmetic.sku.category] ?? '✨';
  const rarity = cosmeticRarity(cosmetic.sku.rarity);

  return (
    <CosmeticCard
      rarity={rarity}
      glow={cosmetic.equipped ? 'subtle' : false}
      thumbnailUrl={cosmetic.sku.thumbnailUrl}
      fallbackIcon={icon}
      displayName={cosmetic.sku.displayName}
      badges={
        <>
          <StatusChip label={cosmetic.sku.rarity} tone="info" size="sm" />
          {cosmetic.equipped && (
            <StatusChip label="Equipped" tone="positive" size="sm" />
          )}
        </>
      }
      caption={
        cosmetic.sku.attribution ? (
          <span
            style={{
              fontSize: 9,
              color: '#64748b',
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={cosmetic.sku.attribution}
          >
            {cosmetic.sku.attribution}
          </span>
        ) : undefined
      }
      footer={
        <RpgButton
          variant={cosmetic.equipped ? 'ghost' : 'primary'}
          size="sm"
          rarity={cosmetic.equipped ? undefined : rarity}
          onClick={onToggle}
          disabled={pending}
          style={{ width: '100%' }}
        >
          {cosmetic.equipped ? 'Equipped ✓' : 'Equip'}
        </RpgButton>
      }
    />
  );
}

// ─── Shop tab ───────────────────────────────────────────────────────────────

function ShopTab({
  filter,
  tokens,
}: {
  filter: string;
  tokens: number;
}) {
  const { data: catalog, isLoading, isError, error } = useCosmeticCatalog();
  const { data: ownedData } = useOwnedCosmetics();
  const buy = useBuyCosmetic();

  // Map of owned SKU IDs (so we can mark them).
  const ownedIds = useMemo(() => {
    const set = new Set<string>();
    for (const o of ownedData?.owned ?? []) set.add(o.sku.id);
    return set;
  }, [ownedData]);

  const filtered = useMemo(() => {
    const items = catalog?.catalog ?? [];
    if (filter === 'all') return items;
    return items.filter((i) => i.category === filter);
  }, [catalog, filter]);

  if (isLoading) {
    return (
      <div style={GRID_STYLE}>
        <LoadingState label="Stocking the shelves" />
      </div>
    );
  }
  if (isError) {
    return (
      <div style={GRID_STYLE}>
        <ErrorState message={(error as Error)?.message ?? ''} />
      </div>
    );
  }
  if (filtered.length === 0) {
    return (
      <div style={GRID_STYLE}>
        <EmptyState
          glyph="🛒"
          title="Shelf's empty"
          body="No cosmetics in this category yet. Check back soon or try another filter."
        />
      </div>
    );
  }

  return (
    <div style={GRID_STYLE}>
      {filtered.map((item) => (
        <ShopCard
          key={item.id}
          item={item}
          owned={ownedIds.has(item.id)}
          tokens={tokens}
          pending={buy.isPending && buy.variables === item.id}
          onBuy={() => buy.mutate(item.id)}
        />
      ))}
    </div>
  );
}

function ShopCard({
  item,
  owned,
  tokens,
  pending,
  onBuy,
}: {
  item: CosmeticCatalogItem;
  owned: boolean;
  tokens: number;
  pending: boolean;
  onBuy: () => void;
}) {
  const icon = CATEGORY_ICONS[item.category] ?? '✨';
  const rarity = cosmeticRarity(item.rarity);
  const canAfford = tokens >= item.priceCt;

  return (
    <CosmeticCard
      rarity={rarity}
      glow={false}
      thumbnailUrl={item.thumbnailUrl}
      fallbackIcon={icon}
      displayName={item.displayName}
      badges={
        <>
          <StatusChip label={item.rarity} tone="info" size="sm" />
          {owned && <StatusChip label="Owned" tone="positive" size="sm" />}
        </>
      }
      caption={
        item.description ? (
          <span
            style={{
              fontSize: 11,
              color: '#cbd5e1',
              lineHeight: 1.5,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
            title={item.description}
          >
            {item.description}
          </span>
        ) : undefined
      }
      footer={
        owned ? (
          <RpgButton variant="ghost" size="sm" disabled style={{ width: '100%' }}>
            Owned ✓
          </RpgButton>
        ) : (
          <RpgButton
            variant="primary"
            size="sm"
            rarity={rarity}
            onClick={onBuy}
            disabled={!canAfford || pending}
            loading={pending}
            title={
              canAfford
                ? `Buy ${item.displayName} for ${item.priceCt} CT`
                : `You need ${item.priceCt} CT — you have ${tokens}. Earn more by playing.`
            }
            style={{ width: '100%' }}
          >
            {canAfford ? `Buy · ${item.priceCt} CT` : `${item.priceCt} CT`}
          </RpgButton>
        )
      }
    />
  );
}

// ─── Main drawer ────────────────────────────────────────────────────────────

interface CosmeticDrawerProps {
  open: boolean;
  onClose: () => void;
}

export default function CosmeticDrawer({ open, onClose }: CosmeticDrawerProps) {
  const { data: ownedData } = useOwnedCosmetics();
  const ownedCount = ownedData?.owned.length ?? 0;
  // Auto-default to the Shop tab when the player owns nothing — the old
  // default of 'owned' surfaced a confusing empty state ("no cosmetics —
  // open the Shop tab") 2026-05-18. Once they own at least one cosmetic the
  // Owned tab makes sense as the entry.
  const [tab, setTab] = useState<Tab>(ownedCount > 0 ? 'owned' : 'shop');
  const [filter, setFilter] = useState<string>('all');
  const { data: avatar } = useAvatar();
  const tokens = avatar?.clawTokens ?? 0;

  return (
    <RpgModal
      open={open}
      onClose={onClose}
      title="Cosmetics"
      subtitle="The Wardrobe · Skins · Hats · Auras · Boards"
      tier="rare"
      glow="subtle"
      headerIcon={<WardrobeSigil />}
      maxWidth={920}
      tokenBadge={<CtPill tokens={tokens} />}
    >
      <TabStrip tab={tab} onChange={setTab} ownedCount={ownedCount} />

      {/* Category filter strip */}
      <div
        style={{
          padding: '14px 22px 12px',
          borderBottom: '1px solid rgba(148, 163, 184, 0.10)',
        }}
      >
        <CategoryChips value={filter} onChange={setFilter} />
      </div>

      {/* Body — scrolls inside RpgModal's own scroll container */}
      {tab === 'owned' ? (
        <OwnedTab filter={filter} onGoShop={() => setTab('shop')} />
      ) : (
        <ShopTab filter={filter} tokens={tokens} />
      )}
    </RpgModal>
  );
}
