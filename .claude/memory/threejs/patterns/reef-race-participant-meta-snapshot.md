---
title: Reef Race RoomMeta one-shot participant metadata pattern
category: pattern
tags: [reef-race, websocket, zustand, room-meta, snapshot, species, multi-species]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary

Stamp per-participant display metadata (e.g. species/GLB) into `RoomMeta` on `snapshot.init` once; re-inject on every `snapshot.keyframe` using the stored map so entity deltas never carry display-only fields.

## Details

### Problem
`snapshot.keyframe` hydrates a fresh `Map<petId, entity>` from deltas. Any display field injected on init (`species`) would be lost on the next keyframe unless re-injected — but we don't want display fields in deltas (bandwidth, not sim data).

### Pattern

**API side (`activity-ws-hub.ts` `sendInit()`):**
```ts
let reefParticipantMeta: Record<string, { modelKey: string }> | undefined;
if (room.activityId === 'reef-race') {
  const allPetIds = Array.from(room.participants.keys());
  const humanPetIds = allPetIds.filter(id => room.participants.get(id)!.subjectType !== 'bot');
  const botPetIds   = allPetIds.filter(id => room.participants.get(id)!.subjectType === 'bot');
  reefParticipantMeta = await loadParticipantMeta(humanPetIds, botPetIds);
}
// then embed in RoomMeta: { ..., reefParticipantMeta }
```

**Protocol (`RoomMeta` in `protocol.ts`):**
```ts
reefParticipantMeta?: Record<string, { modelKey: string }>;
```
Optional so older clients ignore the field and new clients receiving nothing fall back to `{}`.

**Store (`activity.ts` `snapshot.init`):**
```ts
const participantMeta = frame.room.reefParticipantMeta ?? {};
// inject species into entity map
const injected = new Map(hydrated.entities);
injected.forEach((e, petId) => {
  const meta = participantMeta[petId];
  if (meta) injected.set(petId, { ...e, species: meta.modelKey });
});
set({ entities: injected, reefParticipantMeta: participantMeta, /* ... */ });
```

**Store (`snapshot.keyframe`):**
```ts
// Re-inject species from stored map — keyframe doesn't resend reefParticipantMeta
const keyframeMeta = state.reefParticipantMeta;
const injected = new Map(hydrated.entities);
injected.forEach((e, petId) => {
  const meta = keyframeMeta[petId];
  if (meta) injected.set(petId, { ...e, species: meta.modelKey });
});
set({ entities: injected });
```

### Critical: emptyState Pick union
`'reefParticipantMeta'` MUST be in the `Pick<ActivityState, ...>` union inside `emptyState()`.
Without it, `reset()` silently skips wiping the field — stale species data leaks across rooms.

### Species spread survives deltas
`applyEntityDelta` does `{ ...existing, ...<delta fields> }`. Since `species` is never in a sim delta, it persists automatically from the init injection. No changes needed in `applyEntityDelta`.

## Context

Implemented in SPEC 1 (multi-species Reef Race rider, 2026-04-29). The same pattern applies to any display-only per-participant field that is expensive to re-query on every keyframe (avatar URL, display name, team color, etc.).

Bots always get `{ modelKey: 'lobster' }` — no DB query, handled entirely in `loadParticipantMeta`.
DB failure falls back all human pets to `'lobster'` so the race still renders.
