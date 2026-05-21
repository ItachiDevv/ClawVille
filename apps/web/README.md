# Mixamo Animation Fetcher

Programmatic Mixamo animation pulls — replaces the manual click-through-and-download loop.

## One-time setup

1. **Log in to https://www.mixamo.com** in your normal browser.
2. **Get your bearer token.** F12 → Console → paste:
   ```js
   copy(localStorage.access_token)
   ```
   Token is now on your clipboard. Tokens are ~24h, then refresh via login.
3. **Paste into `.env.local`** at the repo root:
   ```
   MIXAMO_BEARER_TOKEN=eyJhbGciOi...
   ```
4. **Verify:**
   ```
   bun scripts/mixamo/auth.ts
   ```
   Should print `OK — token valid, <N> motions reachable`.

## Per-character setup (once per character, ~30 sec)

When you upload + rig a character via Mixamo's web UI, save its `character_id`:

1. After rigging, click **Download** on any animation **once** (or just hover the Download button — Mixamo embeds the character_id in the API call).
2. F12 → Network tab → find any request to `/api/v1/products/<...>?character_id=<UUID>` — the UUID is your character_id.
3. Register it:
   ```
   bun scripts/mixamo/save-character.ts cyrus <character_id> mixamo-adult-male
   ```
   That writes to `scripts/mixamo/characters.json`. From now on Cyrus is reachable by slug, no re-upload ever needed.

## Fetching animations

```bash
# Single character, multiple animations:
bun scripts/mixamo/fetch-animations.ts cyrus Idle Walking Running

# Single named animation — uses Mixamo's exact display name from their library
bun scripts/mixamo/fetch-animations.ts cyrus "Stumble Backwards"
```

Output: `apps/web/public/models/hermes-mesh/<char>-animations/<slot>.fbx`

After download, run the Blender batch convert + VRM wiring (existing pipeline — to be CLI-wrapped next).

## Adding ONE animation to every character of a skeleton class (future)

```bash
# Coming next:
bun scripts/mixamo/add-anim-everywhere.ts "Dancing" mixamo-adult-male
```
Hits the API for each Cyrus / Tekk / future-male-Hermes character with that skeleton class, downloads + finalizes in one batch.
