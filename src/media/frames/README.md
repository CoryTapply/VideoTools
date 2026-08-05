# `src/media/frames/` -- the frame cache

Production module. Serves BOTH the timeline filmstrip and the drag-scrub preview from one
decoded-thumbnail cache, on top of Task 1's sample index (`src/media/index/`) and reusing Task
2's presentation-time convention (`src/media/playback/`). If you're new to this module: read this
file, then `FrameCache.ts` (the public entry point everything else supports), then
`frame-lifecycle.ts` (the rule every other file in here is built around).

## Why two tiers, not one

`results/FEASIBILITY.md`'s original constants called for a single 2fps, 5-minute-window cache.
That design failed on real data: filling 600 slots at 2fps required decoding 18,210 frames --
every frame in the window, since 2fps sample points don't land on keyframes -- costing 27.1s per
window and leaving 93% of a 70-minute recording uncached with no designed fallback.

Keyframes decode independently, with no dependency chain, and there are far fewer of them: 1,015
keyframes cover the ENTIRE 27GB fixture in ~6.7s at 150.4 keyframes/sec batched. Sampling at
keyframes instead of a fixed frame rate makes "outside the cached window" a non-problem, because
there is no window:

- **COARSE** -- whole file, one entry per keyframe (~4.17s spacing on the 27GB fixture), 160x90.
  Built eagerly by `warmCoarse()`, target under 15s (resolution-dependent -- `longgop.mp4`
  measured 648.8 keyframes/sec batched vs. 150.4/sec on the 4K fixture in spike C, so a flat 15s
  target needs a resolution-aware estimate, not a single number). This is both the filmstrip
  source AND the default scrub source: at full-file zoom on a ~1400px timeline, a 4.17s keyframe
  interval is about 5px -- finer than the pointer -- so coarse alone covers the large majority of
  scrubbing.
- **DENSE** -- +/-30s around the viewport, 2fps, 320x180 (spike C's originally validated path).
  Built lazily by `setViewport()`, only once zoom exceeds roughly one keyframe per 40px, and
  cancelled/rebuilt (via `FrameWorkerPool.cancel()`, not deprioritized) as the viewport moves.
  Scoped to only the case coarse is genuinely too sparse for.

`getNearest(time)` checks both tiers and returns whichever has a resident (already-decoded) frame
closer to the query time -- a **pure binary-search lookup**, zero allocation, no promises, no
decode triggering (`binary-search.ts`). That constraint, not a stylistic preference, is why the
coarse tier is built eagerly rather than on demand: `getNearest()` is called at 60Hz inside a
pointermove handler and cannot itself kick off any async work.

## The frame lifecycle rule, and why it's structural

Spike C's leak test: an unclosed `VideoFrame` grows memory 11-13MB/frame, LINEARLY, with ZERO
errors thrown, up to 800 frames / 9.3GB before the OS steps in. No decoder stall, no exception, no
runtime signal of any kind -- the single most dangerous failure mode in this module, because it's
completely silent.

`frame-lifecycle.ts`'s `withFrame`/`withFrameAsync` make this structurally impossible rather than
a matter of remembering to call `close()`: they close (and untrack) the closable in a `finally`
block, so a thrown error or a cancelled batch still releases it. Every decoder output site in
`RealFrameDecoder.ts` goes through one of these -- no raw `VideoFrame` is allowed to escape the
call site that received it from the decoder. The same rule applies to `ImageBitmap` (also
GPU-backed, also silently leaked without `close()`), which is why the module is written generically
over `Closable` rather than specifically over `VideoFrame`.

A `FrameLifecycleRegistry` is a plain ledger an owner holds and passes in (never a global) --
`lru.ts`'s eviction cache and the harness's leak check both use one to answer "how many closables
do I currently believe are alive," which is exactly the number Part 9's 20-cycle warm/clear check
needs to see return to 0.

**Testability seam:** `FrameDecoder` (`FrameDecoder.ts`) mirrors `src/media/playback/`'s
`VideoElementLike` -- a real WebCodecs implementation (`RealFrameDecoder.ts`, the only
WebCodecs-touching file) plus a Node-testable fake (`FakeFrameDecoder.ts`, with its own self-test)
with configurable latency and failure injection. Everything above this seam -- batching,
scheduling, the LRU, atlas packing, the two-tier sampling math -- is proven correct in Node
against the fake before it ever touches a real decoder, per Task 2's experience: its three real
bugs were all browser-timing behavior a fake couldn't reproduce, which is the argument for
building this seam first, not skipping it.

## The atlas decode-once rule

Spike C's atlas finding: `createImageBitmap(atlasBlob, sx, sy, sw, sh)` decodes the ENTIRE atlas
internally on EVERY call -- 23.81ms regardless of crop size, ~950ms for a 40-tile filmstrip
repaint done that way. `atlas-pack.ts` enforces the fix as two separate functions: `decodeAtlas`
(call exactly once per atlas per session) and `cropTile` (crop from the resulting in-memory
`ImageBitmap` via canvas `drawImage` -- cheap, because the source is already raster data, not
compressed bytes needing a fresh decode). There's no code path in this module that calls
`createImageBitmap` against an atlas blob more than once.

Atlas storage itself: 100 thumbnails per atlas, 10x10 grid (`atlas-layout.ts`, pure slot math, no
canvas needed to test it), WebP quality 60, written to OPFS (`atlas-cache.ts`). Cache key folds in
the same file fingerprint the index cache uses (`src/media/index/fingerprint.ts`'s
`computeFingerprint`/`FileFingerprint`, reused directly) plus a schema version and the tile
dimensions -- unlike `opfs-cache.ts`'s self-describing binary blob, an atlas is an opaque WebP
image with nothing meaningful to embed a header into, so folding these into the cache KEY is
simpler and just as safe: any of them changing is a plain cache miss, never a wrong-but-plausible
atlas silently served. Quota-exceeded degrades to memory-only (`{ kind: 'quota-exceeded' }`),
never fails the warm.

`FrameCache` doesn't call the atlas pipeline directly -- packing needs a real `OffscreenCanvas`,
which doesn't exist in Node, so wiring it in would make `FrameCache.ts` untestable there. Instead
`FrameCacheOptions.onCoarseAtlasReady` fires once every 100 coarse-tier slots are resident; a
browser-side caller (see `harness.ts`) wires it to `packAtlas` + `writeAtlas`.

## Eviction budget: ~96MB

Byte-budgeted LRU (`lru.ts`) over live bitmaps, `close()` on every eviction -- the same rule as
above, just for long-lived deliberately-retained bitmaps instead of short-lived decode-site
frames. `FrameLru`'s `onRemove` callback is what keeps `FrameCache`'s own coarse/dense lookup
arrays from ever pointing at an already-closed bitmap after a budget eviction.

Budget arithmetic (27GB fixture): coarse tier fully resident, all 1,015 entries at 160x90 RGBA, is
~58MB. Dense tier fully resident, 600 entries at 320x180 RGBA (spike C's config), is ~132MB. Both
fully resident at once is ~190MB of GPU memory that no JS API can see. The ~96MB default budget
covers the ENTIRE coarse tier resident at all times (~58MB) plus headroom for a realistic dense
window (~38MB, comfortably more than fits in a typical viewport at the trigger threshold),
capping worst-case GPU memory well under the 190MB "everything resident" ceiling a naive
implementation would hit.

## Measurement caveats (read before trusting a number out of `harness.ts`)

`ImageBitmap` and `VideoFrame` memory is GPU-backed and does **not** appear in
`performance.measureUserAgentSpecificMemory()` or `performance.memory.usedJSHeapSize`. On macOS,
hardware-decoded frames live in `VTDecoderXPCService`, outside Chrome's process tree entirely, so
they don't show in Chrome's own task manager either. Every memory number this module's harness
reports from a JS API is logged as explicitly non-authoritative; the only trustworthy number is a
manually-read Activity Monitor "Memory" column for the whole process group, at idle / coarse-warm
/ dense-warm / after-`clear()` -- see `harness.ts`'s Part B section, and
`results/task-3-frame-cache-summary.md` for which numbers in this task have an actual manual
confirmation pass behind them versus which are still pending one.

## Part 0: worker index-sharing decision

Jobs dispatched to the decode worker pool (`worker-pool.ts`) are plain
`{offset, size, presentationTime, ...}` descriptors, not a `SharedArrayBuffer`-shared
`SampleIndex`. Decode workers only ever need byte ranges and presentation times for the specific
keyframes assigned to them -- never general index query capability -- because the pool owner
(main thread) does every such query once, up front, when building the job list. Each worker reads
its own assigned byte ranges via its own `FileByteSource(file)` clone, the same "File is
structured-cloneable, so just clone it into the worker" precedent `src/media/index/worker.ts`
already relies on. See `worker-pool.ts`'s header comment for the full reasoning -- this sidesteps
needing a fresh SAB-vs-transferables measurement for this module's own worker boundary, since the
already-recorded numbers in `results/FEASIBILITY.md` (SAB 9.03ms/2 readers vs. transferables
25.34ms/1 reader) describe handing a FULL index to a worker that needs to query it, which is a
different case that doesn't apply here.

## What's out of scope here

Timeline canvas rendering, zoom, handles (task 4). Waveform (M2). Any encoding (cut from scope
entirely). Export/remux (task 5). A general-purpose media cache abstraction -- this module serves
exactly two known consumers (filmstrip, scrub preview), not a hypothetical third.
