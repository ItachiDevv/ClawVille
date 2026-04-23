# W4 — Frontend Guide Chat Integration (B' pattern)

## Research findings

- **Existing teacher chat hook**: `apps/web/src/hooks/use-location-chat.ts`
  - `useLocationChat(locationId)` returns `{ messages, sendMessage, clearMessages, isLoading, isLoadingHistory, error }`.
  - Uses `useQuery(['chat-history', locationId], api.getChatHistory)` for history and `useMutation(api.sendChat)` for send. Optimistic user-message push, then assistant reply appended on mutation success (`use-location-chat.ts:39-62`).
  - Also fires fire-and-forget `api.openclawLocationChat` when an OpenClaw agent is connected — irrelevant for guide chat and should NOT be replicated.

- **API client**: `apps/web/src/lib/api.ts`
  - Two base-URL helpers: `request(path)` uses `API_URL=''` (same-origin Next.js) and `honoRequest(path)` uses `HONO_API_URL` (defaults to `http://localhost:4000`).
  - Both pass `credentials: 'include'` + `Content-Type: application/json` — auth propagation correct for Lucia cookies (`api.ts:6-22, 24-40`).
  - Existing `api.sendChat(locationId, content)` (`api.ts:163-170`) targets `/api/locations/:id/chat` (Next.js app-router). The new system-agent endpoint lives on Hono (canonical path `POST /api/chat/system/:slug`), so new API method MUST use `honoRequest`.

- **Chat panel component**: `apps/web/src/components/game/chat-panel.tsx`
  - Mounted once from `apps/web/src/app/game/page.tsx:237` via `dynamic(() => import(...))`.
  - Gated by `{hasPet && ...}` (`game/page.tsx:235`) — spectator with no pet cannot see it.
  - Early-return at `chat-panel.tsx:29`: `if (!chatOpen || !currentLocation) return null;` — binds to `(chatOpen, currentLocation)` as trigger. Guide has no `locationId`, so branch must use `guideChatOpen` and skip `currentLocation` guard in guide mode.
  - Reads `{ chatOpen, currentLocation, currentCharacter, exitBuilding, openShop, addToast }` from the store; `useLocationAgent(currentLocation)` at line 14.
  - `headerName = currentCharacter ?? agent?.agentName ?? location?.name ?? 'Unknown'` (`chat-panel.tsx:23`).
  - "Claim Skill" hits `/api/skills/:buildingId/skill.md` (`chat-panel.tsx:54`) — hide in guide mode.
  - "Shop" button only when `isShopBuilding(currentLocation)` — already conditional; stays hidden for guide since `currentLocation` is null.

- **Zustand store**: `apps/web/src/stores/game.ts`
  - Single `useGameStore` with `create<GameState>((set, get) => ({...}))` — no middleware, no persist.
  - Existing chat state: `currentLocation`, `currentCharacter`, `chatOpen`, `movementFrozen` (`game.ts:78-99`). `enterBuilding(locationId, characterName?)` sets `chatOpen=true + movementFrozen=true` (`game.ts:381-405`). `exitBuilding()` clears both (`game.ts:407-415`).
  - `resetStore` action (`game.ts:643-696`) resets every user-session field — new guide flags must be reset here too.

- **3D click trigger for town guide**: `apps/web/src/lib/three/town-guide.tsx:166`
  - `handleClick` currently logs + plays wave animation (lines 167-180).

- **Building entry trigger pattern** (template for how chats open):
  - Keyboard `E` in `player-pet.tsx:250-256` and `player-pet.tsx:505-513`.
  - Click target on `location-hud.tsx:20`.
  - ESC-to-close at `player-pet.tsx:243` and `player-pet.tsx:498`: `if (escNow && !lastEscState && store.chatOpen) store.exitBuilding();`
  - ESC path must also close `guideChatOpen` when true.

- **Backend response shape** (`apps/api/src/routes/chat.ts:147-153`):
  ```
  { message: { role: 'assistant', content: string, timestamp: string(ISO) } }
  ```
  Identical to location chat shape. Rate-limit + token award silent server-side. 401 on unauth, 503 + `Retry-After: 3` if seeder hasn't run yet.

- **Auth pattern**: already handled by `honoRequest`'s `credentials: 'include'`. Lucia cookie rides along.

- **IMPORTANT — backend request shape**: `chatSchema` in `apps/api/src/routes/chat.ts:26-28` requires `{ content: string, 1-4000 chars }` — NOT `{ message: string }`.

## Files to MODIFY

1. **`apps/web/src/stores/game.ts`**
   - Add three fields to `GameState` interface (near line 84 where `chatOpen` is declared):
     ```ts
     guideChatOpen: boolean;
     openGuideChat: () => void;
     closeGuideChat: () => void;
     ```
   - Add initial value `guideChatOpen: false` near line 378.
   - Implement actions:
     ```ts
     openGuideChat: () => set({ guideChatOpen: true, movementFrozen: true }),
     closeGuideChat: () => set({ guideChatOpen: false, movementFrozen: false }),
     ```
   - Add `guideChatOpen: false` to the `resetStore` payload near line 664.

2. **`apps/web/src/lib/api.ts`**
   - Add method after `sendChat` (line 170):
     ```ts
     sendSystemChat: (slug: string, content: string) =>
       honoRequest<{ message: { role: string; content: string; timestamp: string } }>(
         `/api/chat/system/${slug}`,
         { method: 'POST', body: JSON.stringify({ content }) }
       ),
     ```

3. **`apps/web/src/components/game/chat-panel.tsx`**
   - Pull `guideChatOpen` + `closeGuideChat` from store. Import `useGuideChat`.
   - Rewrite early return:
     ```ts
     if (!chatOpen && !guideChatOpen) return null;
     if (chatOpen && !currentLocation) return null;
     ```
   - Split into two inner components `<GuideChatBody />` and `<LocationChatBody />`, gated on `guideChatOpen`. Avoids conditional hook calls.
   - Guide mode: `headerName = 'Nori'`, no location subtitle, no Claim Skill button, empty-state "Hi! I'm Nori, your town guide."
   - Header X button: calls `closeGuideChat()` in guide mode, `exitBuilding()` in location mode.

4. **`apps/web/src/lib/three/town-guide.tsx`**
   - Import `useGameStore`. In `handleClick` (line 166-180), REPLACE `console.log` at line 168 with `useGameStore.getState().openGuideChat();`. Keep wave animation.

5. **`apps/web/src/lib/three/player-pet.tsx`**
   - At lines 243 and 498 (two ESC handlers — GLB VRM branch + GLB non-VRM branch, both useFrame-driven), extend:
     ```ts
     if (escNow && !lastEscState) {
       if (store.chatOpen) store.exitBuilding();
       else if (store.guideChatOpen) store.closeGuideChat();
     }
     ```
   - Both blocks must be edited in parallel to keep the two render paths in sync.

6. **`GameFeatures.md`** (repo root, gitignored but live)
   - Add a section (or extend the existing chat-panel section) documenting:
     - Nori click → chat panel flow (3D model click is the entry, not a building proximity trigger)
     - ESC / X close behavior
     - Two-chat-never-coexist invariant (movementFrozen shared between guide + building chats)
     - Guide mode explicitly has NO Claim Skill, NO Shop, NO inventory, NO reward banner — matches Nori's "switchboard, not encyclopedia" role per CLAUDE.md Brand Identity
   - Bump "Last Audited" date.

## Files to CREATE

1. **`apps/web/src/hooks/use-guide-chat.ts`** — mirrors `use-location-chat.ts` minus history query + OpenClaw tagalong.
   - Key exports: `export function useGuideChat()` returning `{ messages, sendMessage, clearMessages, isLoading, error }`.
   - **Shared `ChatMessage` type**: both hooks must import a single `ChatMessage` shape. Easiest path: lift the interface from `use-location-chat.ts:8-13` into a new `apps/web/src/types/chat.ts` OR export it from `use-location-chat.ts` and have `use-guide-chat.ts` import. Parent `chat-panel.tsx` can then treat `messages` uniformly if ever lifted.
   - **clearMessages on close**: `<GuideChatBody />` installs `useEffect(() => { if (!guideChatOpen) clearMessages(); }, [guideChatOpen])` so re-opening the panel presents an empty view (Eliza RAG still keeps server-side history).
   - **Scroll-ref ownership**: the existing scroll-to-bottom ref + effect at `chat-panel.tsx:17,26` must live INSIDE each inner component (`<GuideChatBody />`, `<LocationChatBody />`), not in the parent. Each owns its own `messages` array and its own scroll ref. Don't share a ref across the branches.
   - Shape:
     ```ts
     const [messages, setMessages] = useState<ChatMessage[]>([]);
     const sendMutation = useMutation({
       mutationFn: (content: string) => api.sendSystemChat('town-guide', content),
       onSuccess: (data) => setMessages(prev => [...prev, {
         id: crypto.randomUUID(),
         role: 'assistant',
         content: data.message.content,
         timestamp: data.message.timestamp,
       }]),
     });
     const sendMessage = useCallback((content: string) => {
       if (!content.trim()) return;
       setMessages(prev => [...prev, {
         id: crypto.randomUUID(), role: 'user', content,
         timestamp: new Date().toISOString()
       }]);
       sendMutation.mutate(content);
     }, [sendMutation]);
     ```

## Files to LEAVE ALONE

- `use-location-chat.ts` — existing teacher hook.
- `apps/web/src/app/api/locations/[id]/chat/route.ts` + `history/route.ts` — Next.js location-chat endpoints.
- `apps/api/src/routes/chat.ts` — backend ships `/system/:slug` (W1).
- `apps/api/src/services/system-npc-seeder.ts` — seeder.
- `location-hud.tsx`, `mobile-controls.tsx`, `npc-controller.tsx`, `lib/pixi/use-game-loop.ts` — serve building-chat trigger, not guide.
- `stores/autonomy.ts` — location chat only.
- `apps/web/src/app/game/page.tsx` — `<ChatPanel />` stays mounted behind `{hasPet && ...}`.
- `pet-chat-bar.tsx` — follow-up if visual overlap confirmed.

## Implementation order (STRICT — earlier steps unblock later ones)

1. `apps/web/src/stores/game.ts` — add `guideChatOpen` + actions + resetStore field
2. `apps/web/src/types/chat.ts` (new) — export shared `ChatMessage` interface; migrate `use-location-chat.ts:8-13` to import from it
3. `apps/web/src/lib/api.ts` — add `sendSystemChat(slug, content)`
4. `apps/web/src/hooks/use-guide-chat.ts` (new) — hook using shared `ChatMessage`
5. `apps/web/src/components/game/chat-panel.tsx` — split into `<GuideChatBody />` + `<LocationChatBody />`; each owns its own scroll ref + messages; install clearMessages useEffect inside GuideChatBody
6. `apps/web/src/lib/three/town-guide.tsx` — add idempotency guard THEN `openGuideChat()` THEN wave animation
7. `apps/web/src/lib/three/player-pet.tsx` — extend ESC handler at both `:243` and `:498`
8. `GameFeatures.md` — document the new flow, bump Last Audited date

Any deviation (e.g. wiring town-guide click before store action exists) produces compile errors.

## Idempotency guard (full text for step 6)

```ts
function handleClick(e: { stopPropagation: () => void }) {
  e.stopPropagation();
  const store = useGameStore.getState();
  if (store.chatOpen || store.guideChatOpen) return;  // no re-open, no double-wave
  store.openGuideChat();
  // wave animation follows — only plays on first open
  const idle = idleActionRef.current;
  const wave = waveActionRef.current;
  if (!idle || !wave || wavingRef.current) return;
  wavingRef.current = true;
  wave.reset();
  wave.enabled = true;
  wave.weight  = 0;
  wave.play();
  idle.crossFadeTo(wave, WAVE_FADE, false);
}
```

## Guide-mode UI scope (what to explicitly NOT render)

In `<GuideChatBody />`, confirmed HIDDEN/ABSENT:
- Claim Skill button (belongs to building teachers, not Nori)
- Shop button (no inventory / books for guide)
- Reward banner / XP+token flyups (backend awards are silent; mirror UI)
- Inventory icon
- Location subtitle (no building)

Matches Nori's "switchboard, not encyclopedia" role per `CLAUDE.md` Brand Identity §4 + the MANDATORY system-agents section.

## State shape

```ts
interface GameState {
  // …existing unchanged…
  guideChatOpen: boolean;              // W4
  openGuideChat: () => void;           // sets guideChatOpen=true, movementFrozen=true
  closeGuideChat: () => void;          // sets guideChatOpen=false, movementFrozen=false
}
```

## API contract

```
POST /api/chat/system/town-guide        (Hono API, port 4000)
Auth: Lucia session cookie (credentials: 'include')
Body: { content: string }               — NOTE: backend uses `content`, not `message`
Response 200: { message: { role: 'assistant', content: string, timestamp: ISO8601 } }
Response 401: unauth
Response 503: seeder boot race — body { message: "System agent 'town-guide' not seeded yet..." }, header Retry-After: 3
```

## UI flow

1. User clicks Nori's 3D model → `handleClick` fires in `town-guide.tsx:166`.
2. Wave animation starts (preserved).
3. `useGameStore.getState().openGuideChat()` → `guideChatOpen=true`, `movementFrozen=true`.
4. `<ChatPanel />` re-renders; early-return no longer short-circuits; guide branch renders.
5. `useGuideChat()` has empty `messages[]`.
6. User types → `handleSend` → `useGuideChat.sendMessage('hi')`.
7. Optimistic user-bubble append; POST to Hono.
8. On 200, assistant bubble appended.
9. ESC → `player-pet.tsx` handler → `closeGuideChat()`.
10. X button → also `closeGuideChat()`.

## Edge cases

- **User walks into building while guide open**: `movementFrozen=true` freezes movement; proximity can't fire. Two chats cannot coexist.
- **User clicks Nori while building chat already open**: add guard `if (useGameStore.getState().chatOpen) return;` at top of `handleClick`. Also check `guideChatOpen` (prevent re-open). Skip wave in either case.
- **Unauthenticated user clicks Nori**: `<ChatPanel />` gated by `hasPet`; no-op. Matches existing behavior.
- **Backend 503**: mutation errors; mirror `use-location-chat.ts` behavior (silent). Defer error UI.
- **Rate-limited (60s token)**: backend returns normal `200`; UI unaware.
- **Network error**: TanStack default error state; match existing hook.
- **Eliza RAG memory**: per-user-per-slug via `characterRoomId('town-guide', user.id)` — nothing frontend-side.

## Test plan

- **Manual**: log in with pet → click Nori → panel right → header "Nori" → empty-state → type "hi" → reply.
- **Manual**: ESC → closes, unfreezes movement.
- **Manual**: X button → same close.
- **Manual**: click Nori twice — idempotent.
- **Manual**: reload → panel stays closed; Eliza server memory persists.
- **Manual regression**: click teacher building → normal teacher chat.
- **Manual regression**: logout/login → `resetStore` resets `guideChatOpen: false`.
- **Typecheck**: `cd apps/web && bun run typecheck` — zero new errors.
- **Typecheck**: `cd apps/api && bun run typecheck` — untouched.

## Risks

- **chat-panel branching complexity**: split into inner components avoids conditional hooks. If diverges further, lift to `guide-chat-panel.tsx`.
- **`movementFrozen` sharing**: runtime assertion in `openGuideChat` to bail if `chatOpen=true`.
- **Hono vs Next.js drift**: if route moves to Next.js, switch from `honoRequest` to `request`.
- **ChatPanel `dynamic({ ssr: false })`** import chain is all client-side. No SSR concern.
- **Store middleware**: no persist; no version bump needed.

## Out of scope for W4

- Reward banner animation on system-agent chat.
- `/dash/guide` admin UI.
- Streaming responses.
- Guide chat for users without a pet.
- History UI on re-open.
- `pet-chat-bar.tsx` hide — cosmetic follow-up.
