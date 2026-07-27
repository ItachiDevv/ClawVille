# P1c Heap Retention Naming Report

**Generated:** 2026-07-27T00:28:43.242Z
**Lane:** `soak`
**Loops:** 60/60
**Summary:** `C:\Users\itachi\Documents\Crypto\cv-covefreeze\apps\web\scripts\world-stage-soak-summary.json`

**Outcome:** **BLOCKED** on the unchanged 3% second-half heap gate, with the
retention named as Three/WebGPU renderer-internal bind-group/backend caching.

## Gate correction

Renderer texture and geometry counts still require exact equality at loop 20
versus final. Each WebGPU byte counter now requires
`final <= loop20 * 1.01`, so flat or decreasing usage passes and growth beyond
1% fails. This restores the v2 brief's actual counts-equality contract: strict
byte equality was an implementation addition, and the prior 67,539-byte
program/uniform-cache decrease was not a leak. The independent 3% second-half
heap gate is unchanged.

## 60-loop naming soak

- Heap: 336.03 -> 378.81 MB, +12.7307% overall; midpoint 356.96 -> 378.81
  MB, +6.1192%, so the unchanged 3% gate fails.
- Renderer bytes: 291,024,569 -> 291,106,586, +0.0282%, so the corrected byte
  gate passes.
- Scene inventories are exactly flat and history remains 4 -> 4.
- The diagnostic run allocated one late texture (287 -> 288) while geometries
  remained 419 -> 419, so this run's exact count gate fails.

## Snapshot diff

Snapshots were forced-GC captures at loops 20 and 50. Constructor/name groups; retained size is the maximum dominator-tree retained size within each group, matching DevTools aggregate semantics.

| Rank | Constructor | Type | Count at loop 20 | Count at loop 50 | Count delta | Self-size delta | Retained-size delta |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | Set | object | 1255 | 2893 | 1638 | 26208 | 3061192 |
| 2 | _k | object | 1 | 1 | 0 | 0 | 263024 |
| 3 | WeakMap | object | 2271 | 2303 | 32 | 512 | 262144 |
| 4 | h_ | object | 1 | 1 | 0 | 0 | 185648 |
| 5 | blink::InspectorNetworkAgent | native | 2 | 2 | 0 | 0 | 71480 |
| 6 | blink::NetworkResourcesData | native | 2 | 2 | 0 | 0 | 71480 |
| 7 | blink::HeapHashTableBacking<blink::HashTable<blink::String, blink::KeyValuePair<blink::String, cppgc::internal::BasicMember<blink::NetworkResourcesData::ResourceData, cppgc::internal::StrongMemberTag, cppgc::internal::DijkstraWriteBarrierPolicy>>, blink::KeyValuePairExtractor, blink::HashMapValueTraits<blink::HashTraits<String>, blink::HashTraits<cppgc::internal::BasicMember<blink::NetworkResourcesData::ResourceData, cppgc::internal::StrongMemberTag, cppgc::internal::DijkstraWriteBarrierPolicy>>>, blink::HashTraits<String>, blink::HeapAllocator>> | native | 1 | 1 | 0 | -32776 | 71480 |
| 8 | ei (closure) | closure | 9 | 9 | 0 | 0 | 28736 |
| 9 | Performance | native | 1 | 1 | 0 | 0 | 23424 |
| 10 | (code) system / SharedFunctionInfo / setup | code | 60 | 60 | 0 | 0 | 15344 |
| 11 | iu (closure) | closure | 2 | 2 | 0 | 0 | 13392 |
| 12 | (code) system / SharedFunctionInfo / o0 | code | 2 | 2 | 0 | 0 | 12156 |
| 13 | commitUpdate (closure) | closure | 1 | 1 | 0 | 0 | 11796 |
| 14 | o0 (closure) | closure | 2 | 2 | 0 | 0 | 11056 |
| 15 | (code) system / SharedFunctionInfo / ei | code | 11 | 11 | 0 | 0 | 10256 |
| 16 | oZ (closure) | closure | 2 | 2 | 0 | 0 | 9200 |
| 17 | a5 (closure) | closure | 2 | 2 | 0 | 0 | 8880 |
| 18 | eX (closure) | closure | 8 | 8 | 0 | 0 | 8508 |
| 19 | eB (closure) | closure | 6 | 6 | 0 | 0 | 8448 |
| 20 | f (closure) | closure | 49 | 49 | 0 | 0 | 8088 |

## Representative retainer chains

Each chain follows real snapshot edges on the DFS root path to the
maximum-retained final-snapshot representative. Long paths are trimmed.

### 1. Set

Representative retained size: 4111792 bytes; root reached: true.

- (synthetic) #1 —[element:1]→ (synthetic) (GC roots) #3
- (synthetic) (GC roots) #3 —[element:8]→ (synthetic) (Eternal handles) #19
- (synthetic) (Eternal handles) #19 —[internal:3]→ system / FunctionTemplateInfo #8115
- system / FunctionTemplateInfo #8115 —[hidden:5]→ system / FunctionTemplateRareData #198199
- system / FunctionTemplateRareData #198199 —[hidden:2]→ system / FunctionTemplateInfo #8117
- … 155 intermediate edges omitted …
- (array) #1789181 —[internal:19]→ fo #1789183
- fo #1789183 —[property:bindings]→ Array #1317147
- Array #1317147 —[element:3]→ xu #971527
- xu #971527 —[property:textureNode]→ sI #971687
- sI #971687 —[property:_value]→ iz #182653
- iz #182653 —[internal:41 / part of key (iz @182653) -> value (Object @942633) pair in WeakMap (table …]→ Object #942633
- Object #942633 —[property:bindGroups]→ Set #942635

### 2. _k

Representative retained size: 534408 bytes; root reached: true.

- (synthetic) #1 —[element:1]→ (synthetic) (GC roots) #3
- (synthetic) (GC roots) #3 —[element:8]→ (synthetic) (Eternal handles) #19
- (synthetic) (Eternal handles) #19 —[internal:3]→ system / FunctionTemplateInfo #8115
- system / FunctionTemplateInfo #8115 —[hidden:5]→ system / FunctionTemplateRareData #198199
- system / FunctionTemplateRareData #198199 —[hidden:2]→ system / FunctionTemplateInfo #8117
- … 569 intermediate edges omitted …
- WeakMap #941481 —[internal:table]→ (array) #941517
- (array) #941517 —[internal:1 / part of key (hB @136233) -> value (WeakMap @941555) pair in WeakMap (table …]→ WeakMap #941555
- WeakMap #941555 —[internal:table]→ (array) #941577
- (array) #941577 —[internal:1 / part of key (mG @136231) -> value (hn @941601) pair in WeakMap (table @9415…]→ hn #941601
- hn #941601 —[property:_geometries]→ hm #136219
- hm #136219 —[property:attributes]→ hd #2805135
- hd #2805135 —[property:backend]→ _k #2105359

### 3. WeakMap

Representative retained size: 524324 bytes; root reached: true.

- (synthetic) #1 —[element:1]→ (synthetic) (GC roots) #3
- (synthetic) (GC roots) #3 —[element:8]→ (synthetic) (Eternal handles) #19
- (synthetic) (Eternal handles) #19 —[internal:3]→ system / FunctionTemplateInfo #8115
- system / FunctionTemplateInfo #8115 —[hidden:5]→ system / FunctionTemplateRareData #198199
- system / FunctionTemplateRareData #198199 —[hidden:2]→ system / FunctionTemplateInfo #8117
- … 570 intermediate edges omitted …
- (array) #941517 —[internal:1 / part of key (hB @136233) -> value (WeakMap @941555) pair in WeakMap (table …]→ WeakMap #941555
- WeakMap #941555 —[internal:table]→ (array) #941577
- (array) #941577 —[internal:1 / part of key (mG @136231) -> value (hn @941601) pair in WeakMap (table @9415…]→ hn #941601
- hn #941601 —[property:_geometries]→ hm #136219
- hm #136219 —[property:attributes]→ hd #2805135
- hd #2805135 —[property:backend]→ _k #2105359
- _k #2105359 —[property:data]→ WeakMap #2809231

## Diagnosis

The dominant `Set` chain terminates in a texture backend record's
`bindGroups` property. In Three.js source, `Textures.js` initializes
`textureData.bindGroups = new Set()`, while `Bindings.js` adds each bind group
that references the texture. The `_k` representative is the minified WebGPU
backend reached through
`Renderer._geometries -> Geometries.attributes -> backend`; its `data`
property is the `WeakMap` initialized by `Backend.js`.

Classification: **(c) V8/renderer-internal**, specifically Three/WebGPU
bind-group/backend caches. No top retainer terminates in a Next.js App Router
entry or in stage/world/Cove objects or hooks. Clearing renderer-private caches
from application code would be an out-of-scope eviction workaround, and the
allowed file slice excludes vendored Three internals. No application fix was
made.

## 120-loop boundedness

Exactly one ordinary 120-loop soak was run without heap snapshots. Slopes use
least-squares fits over the forced-GC samples in each 30-loop quartile.

| Quartile | Loops | Forced-GC slope (MB/loop) |
|---|---:|---:|
| Q1 | 1-30 | 0.5995 |
| Q2 | 31-60 | 0.1979 |
| Q3 | 61-90 | 0.2377 |
| Q4 | 91-120 | 0.5217 |

The slope does not decay toward zero; it rises in Q4. Forced-GC retained heap
reached/finalized at 388.78 MB, and the all-sample transient ceiling was
536.57 MB. Overall forced-GC growth was +15.6922%; second-half growth was
+7.2336%, failing the unchanged 3% gate.

At the same time, renderer counts were exactly flat from loop 20 through final
at 288 textures / 419 geometries, renderer bytes decreased
291,024,908 -> 290,994,503, both scene inventories were exact zero diffs, and
history remained 4 -> 4. The raw boundedness evidence is
`reports/p1c-heapname-soak-120-summary.json`.

## Blocker

The required 60-loop soak still fails the unchanged heap gate, and the named
renderer-internal retention is not bounded within 120 loops. Per the frozen
contract, work stops without changing the heap threshold, adding an eviction
tier, touching `apps/api`, or modifying Three/WebGPU cache semantics. The
orchestrator owns the gate decision with this evidence.
