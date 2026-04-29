-- Q3 plan §gamification dashboard — phase status table + seed rows.
-- Applied 2026-04-29 against prod Supabase via apply-dashboard-phases.ts.

CREATE TABLE IF NOT EXISTS "dashboard_phases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "description" text,
  "status" text NOT NULL DEFAULT 'planned',
  "notes" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_dashboard_phases_sort_order"
  ON "dashboard_phases" USING btree ("sort_order");

-- Seed: snapshot of Q3 plan as of 2026-04-29. Use the dashboard MCP to update.
INSERT INTO "dashboard_phases" ("slug", "name", "description", "status", "notes", "sort_order")
VALUES
  ('phase-1', 'Anti-farm + leaderboard rebalance + tutorial-quest server reward',
   'Q3 plan §2. fp_hash + ip_prefix_hash on every event row, weights rebalance (chat 10, collab 40, etc.), daily caps, pet-keyed UNION, tutorial quests credit ClawTokens server-side via /api/quests/tutorial/:id/claim.',
   'shipped',
   'Live as commit 8a253ee9. End-to-end verified: subjectType field ships, fp_hash populates on emitted events, /api/quests/tutorial/:id/claim returns 200 for valid claims and 403 for guests.',
   1),
  ('phase-2', 'Player tier + leaderboard subject filter chips',
   'Q3 plan §3. /api/leaderboard/agents accepts ?subject=all|players|trainers; /leaderboard page gains <SubjectTabs>; sidebar OpenClaw row tier-aware ("Upgrade to Trainer" when hasPet && !agentConnected); deriveUserTier helper at apps/web/src/lib/user-tier.ts.',
   'shipped',
   'Live as commit 88630f7f. Verified: ?subject=players returns subjectType=pet entries, ?subject=trainers returns subjectType=agent, totalRanked differs (11 vs 4).',
   2),
  ('phase-3-engine', 'Cosmetic engine — schema + API + drawer + 3D loader',
   'Q3 plan §4. cosmetic_skus + cosmetic_variants + pet_skins tables; /api/cosmetics/{catalog, owned, equip, unequip}; cosmetic-loader.tsx (905 lines, GLSL not TSL); cosmetic-drawer.tsx with category filter chips. RESTRICT cascade on SKU FKs (audit-fix).',
   'shipped',
   'Live as commit 88630f7f. Engine ready, drawer accessible via sidebar Cosmetics ✨ entry. Catalog is empty until first content drop.',
   3),
  ('phase-3-content', 'First cosmetic content drop — 4 surfboards from Reef Race v2',
   'Seed cosmetic_skus with 4 surfboard SKUs (scope=activity:reef-race), cosmetic_variants with rigType=reef-race-board pointing at apps/web/public/models/reef-race/surfboards/*.glb, pet_skins for testing.',
   'planned',
   'Reef Race v2 session has the surfboard GLBs ready. Next step: write seed script + mount <CosmeticLoader> inside Reef Race scene.',
   4),
  ('phase-4', 'Shop UI + multi-rail CT top-up + ACP/MPP agent payments',
   'Q3 plan §5. Stripe LLC account + Stripe Tax + Cloudflare Turnstile; /topup/{web,anon,agent,sol,usdc,clv} routes; /acp + /mpp servers; CLV pay = +25% bonus. Six checkout surfaces (Lucia, anon, agent, ACP, MPP, crypto).',
   'blocked',
   'Blocked on user-side: Stripe LLC account verification (~7-14d) and Cloudflare Turnstile site keys.',
   5),
  ('phase-5', 'Agent CT → $CLAWVILLE payout',
   'Q3 plan §6. POST /api/wallet/redeem-ct (signed challenge auth). Faucet rate calibrated against Phase-1 Week-1 data. Two-wallet structure (inbound treasury + payout reserve, both Token-2022 path).',
   'blocked',
   'Gated by 7+ days of Phase 1 leaderboard data to calibrate per-agent weekly cap. Earliest: 2026-05-06.',
   6),
  ('phase-6', 'Periodic CLV-exclusive limited drops',
   'Q3 plan §7. Weekly cosmetic drops with availableUntil window + supply_cap. UI = B+C hybrid (FOMO badge + countdown for everyone, "Unlock with CLAWVILLE" CTA for non-holders).',
   'planned',
   'First drop ships when Phase 5 lands.',
   7)
ON CONFLICT (slug) DO NOTHING;
