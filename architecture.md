# Browser-based large-file video trimmer — architecture design

**Status:** design proposal, pre-implementation
**Scope:** client-only viewer/trimmer for local video files up to ~20 GB+, evolving into a lightweight browser NLE

---

## 0. Executive summary

Three decisions shape everything else.

**1. Do not build the export path on ffmpeg.wasm.**
WebAssembly's 32-bit linear memory caps Emscripten's in-memory filesystem (MEMFS) at roughly 2 GB, and that budget covers input *plus* output *plus* working memory. `WORKERFS` fixes half the problem — it mounts a `File`/`Blob` and reads from it lazily, so multi-gigabyte *inputs* are viable — but FFmpeg's muxers seek in their output, and the output filesystem is still memory-backed. A 20 GB input trimmed to a 4 GB clip has nowhere to go. ffmpeg.wasm belongs in this app as a *lazily-loaded fallback for exotic formats*, not as the engine.

**2. A stream-copy trim is a remux, and a remux is a solved problem in TypeScript.**
`ffmpeg -ss X -to Y -c copy` does three things: parse the container index, select a range of samples, write a new container. No decoding, no encoding. That is pure metadata manipulation plus byte-shovelling — you can do it with a lazy reader over the source `File` and a `FileSystemWritableFileStream` to the destination, at disk speed, with a memory footprint measured in tens of megabytes regardless of file size. This is the primary export path.

**3. Native `<video>` is the playback engine; WebCodecs is the *analysis and re-encode* engine.**
`URL.createObjectURL(file)` on a 20 GB `File` gives the browser a lazily-read blob. The browser demuxes and hardware-decodes it with zero JS memory cost and handles seeking for you. Nothing you build in JS will beat it for single-source preview. WebCodecs is reserved for the jobs `<video>` can't do: fast keyframe-only thumbnail extraction, audio waveform peaks, and frame-accurate re-encoding.

The resulting engine tiering for export:

| Tier | Mechanism | Cut accuracy | Speed | When |
|---|---|---|---|---|
| 1 | Remux (stream copy) | Keyframe-aligned in-point, frame-accurate out-point | Disk-bound, ~GB/s | Default, always |
| 2 | Smart render (partial re-encode) | Frame-accurate | Near tier 1 | User wants exact in-point |
| 3 | Full transcode (WebCodecs) | Frame-accurate | Hardware encode, ~2–20× realtime | Format/codec change, filters |
| 4 | ffmpeg.wasm | Frame-accurate | Slow, size-capped | Formats nothing else handles |

---

## 1. High-level architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  MAIN THREAD                                                        │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  React shell │  │  Player      │  │  Timeline    │              │
│  │  toolbars,   │  │  <video> +   │  │  canvas      │              │
│  │  dialogs,    │  │  rVFC sync   │  │  renderer    │              │
│  │  inspector   │  │              │  │  (imperative)│              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         │                 │                 │                       │
│  ┌──────┴─────────────────┴─────────────────┴───────┐              │
│  │  APPLICATION STATE                                │              │
│  │  ┌─────────────┐ ┌────────────┐ ┌──────────────┐ │              │
│  │  │ Document    │ │ Command    │ │ Ephemeral    │ │              │
│  │  │ (EDL model) │ │ stack      │ │ (viewport,   │ │              │
│  │  │ undoable    │ │ undo/redo  │ │  playhead)   │ │              │
│  │  └─────────────┘ └────────────┘ └──────────────┘ │              │
│  └────────────────────────┬──────────────────────────┘              │
│                           │                                          │
│  ┌────────────────────────┴──────────────────────────┐              │
│  │  SERVICE FACADES (typed, promise/observable)      │              │
│  │  MediaIndex · Thumbnails · Waveform · Export      │              │
│  └────────────────────────┬──────────────────────────┘              │
└───────────────────────────┼─────────────────────────────────────────┘
                            │  Comlink RPC, transferables
┌───────────────────────────┼─────────────────────────────────────────┐
│  WORKERS                  │                                          │
│  ┌──────────┐ ┌───────────┴──┐ ┌──────────┐ ┌──────────┐ ┌────────┐│
│  │ Index    │ │ Thumbnail    │ │ Waveform │ │ Export   │ │ FFmpeg ││
│  │ worker   │ │ pool (2–4)   │ │ worker   │ │ worker   │ │ worker ││
│  │          │ │              │ │          │ │          │ │ (lazy) ││
│  │ demux    │ │ VideoDecoder │ │ Audio    │ │ remux /  │ │ wasm   ││
│  │ moov,    │ │ keyframes →  │ │ Decoder  │ │ smart    │ │ escape ││
│  │ sample   │ │ bitmap →     │ │ → peaks  │ │ render / │ │ hatch  ││
│  │ tables   │ │ atlas        │ │ pyramid  │ │ encode   │ │        ││
│  └────┬─────┘ └──────┬───────┘ └────┬─────┘ └────┬─────┘ └───┬────┘│
└───────┼──────────────┼──────────────┼────────────┼───────────┼──────┘
        │              │              │            │           │
┌───────┴──────────────┴──────────────┴────────────┴───────────┴──────┐
│  STORAGE / IO LAYER                                                  │
│  ┌────────────────────┐ ┌──────────────────┐ ┌───────────────────┐ │
│  │ Source file        │ │ OPFS cache       │ │ Output sink       │ │
│  │ FileSystemFileHandle│ │ thumbnail atlases│ │ FileSystemWritable│ │
│  │ → File → .slice()  │ │ waveform peaks   │ │ FileStream        │ │
│  │ READ ONLY, LAZY    │ │ index snapshots  │ │ streamed to disk  │ │
│  │ never copied       │ │ (evictable)      │ │ never buffered    │ │
│  └────────────────────┘ └──────────────────┘ └───────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘

         ┌───────────────────────────────────────────────┐
         │ SIDE CHANNEL (bypasses everything above)      │
         │ <video src=blob:...> ── browser demux+decode  │
         │ Zero JS memory. Hardware accelerated.         │
         └───────────────────────────────────────────────┘
```

The "side channel" is worth calling out explicitly on the diagram because it is the thing most designs get wrong: preview playback should not flow through your pipeline at all in v1.

---

## 2. Subsystems

### 2.1 Platform / capability layer

**Responsibility:** hide browser differences; be the single place that knows what this browser can do.

- Feature detection at startup: `showOpenFilePicker`, `showSaveFilePicker`, `VideoDecoder`, `VideoEncoder`, `AudioDecoder`, `requestVideoFrameCallback`, `navigator.storage.getDirectory`, `crossOriginIsolated`.
- Codec probing via `VideoDecoder.isConfigSupported()` / `VideoEncoder.isConfigSupported()` and `video.canPlayType()`.
- Exposes a `Capabilities` object that the rest of the app branches on. **No other module calls `window.showSaveFilePicker` directly.**
- Provides fallback implementations: `<input type="file">` for open, anchor-download for save.

This layer is what stops browser-compat concerns from smearing across 40 files.

### 2.2 Media index

**Responsibility:** turn a file into a queryable structure describing every frame, without reading the media data.

Produces, per track:

```
SampleIndex {
  timescale:   number
  count:       number
  pts:         Float64Array | BigInt64Array   // composition time
  dts:         Float64Array | BigInt64Array
  offset:      Float64Array                   // byte offset in file
  size:        Uint32Array
  isSync:      Uint8Array                     // keyframe flags (bitset)
  description: Uint8Array                     // avcC/hvcC codec config
}
```

**This must be typed arrays, not objects.** A 4-hour 60 fps recording has ~860,000 video samples. As `{pts, dts, offset, size, isKey}` JS objects that is several hundred megabytes and miserable to GC. As the typed arrays above it is roughly 25 MB, transferable to workers with zero copy, and binary-searchable.

Derived views the UI needs:
- `keyframeTimes: Float64Array` — drives keyframe ticks on the timeline and in-point snapping.
- `frameAtTime(t)` / `timeOfFrame(n)` — exact, VFR-safe. Do not assume constant frame rate; you have the real PTS list, use it.
- `duration`, `dimensions`, `rotation` (`tkhd` matrix), codec strings, bitrate.

Cached in OPFS keyed by a cheap file fingerprint (size + `lastModified` + hash of the first and last 1 MB). Never hash 20 GB.

### 2.3 Playback engine

**Responsibility:** show the right frame at the right time. Defined as a port so it can be swapped later.

```
interface PlaybackEngine {
  attach(container: HTMLElement): void
  load(source: MediaSourceRef): Promise<void>
  play(): void; pause(): void
  seek(time: Rational, mode: 'accurate' | 'fast'): Promise<void>
  stepFrames(n: number): Promise<void>
  onFrame(cb: (mediaTime: number) => void): Unsubscribe
}
```

**v1 implementation — `NativeVideoEngine`:**
- `<video>` with `src = URL.createObjectURL(file)`. Revoke on close.
- Frame-accurate playhead via `requestVideoFrameCallback`, which reports the actual presented `mediaTime`. `timeupdate` fires ~4×/sec and is useless for an editor.
- Frame stepping: look up `pts[n±1]` in the sample index and seek to `pts + halfFrameDuration` to defeat float rounding. Not `currentTime += 1/30`.
- Scrub throttling: maintain a single `pendingSeekTarget`. On pointer move, overwrite it; only issue a new `currentTime` assignment when the previous `seeked` event has fired. Without this, fast scrubbing queues seeks and the UI falls seconds behind.
- Use `fastSeek()` for scrub-mode seeks where available, exact `currentTime` on pointer-up.

**Later implementations:** `CompositedEngine` (WebCodecs decode → canvas/WebGPU composite) for multi-clip and multi-track, once the EDL contains more than one clip. Possibly an MSE-backed engine for containers the browser can't open natively.

**Why not MediaSource in v1:** MSE requires *you* to push buffers from JS. That means demuxing yourself and holding segments in memory, and `SourceBuffer` has a modest quota (on the order of a hundred-odd MB) requiring eviction logic. You would be reimplementing, worse, what `<video>` already does for free. MSE only earns its place when you need to splice segments from multiple sources or feed remuxed data for an unsupported container.

### 2.4 Timeline

**Responsibility:** the editor surface. Rendering, hit-testing, zoom/pan, snapping.

Rendered with **Canvas 2D, not DOM**. A DOM-node-per-thumbnail timeline dies at a few thousand nodes; a 4-hour timeline zoomed to frame level has hundreds of thousands of logical elements.

Structure as a layer stack, each an offscreen canvas, composited each frame:

| Layer | Redraw trigger |
|---|---|
| Ruler + timecode ticks | viewport change |
| Thumbnail strip | viewport change, thumbnail arrival |
| Waveform | viewport change, peak arrival |
| Clip bodies + keyframe ticks | viewport or document change |
| Trim handles + selection | drag |
| Playhead | every rVFC tick |

Only the playhead layer redraws at 60 Hz in the common case. Everything else is cached.

**Coordinate model.** One small object owns it:

```
Viewport { startTime: Rational, pixelsPerSecond: number, width: number }
timeToX(t) = (t - startTime) * pixelsPerSecond
xToTime(x) = startTime + x / pixelsPerSecond
```

Zoom = multiply `pixelsPerSecond`, anchored at the cursor's time so the frame under the pointer stays put. Clamp zoom between "whole file visible" and "one frame ≈ 40 px". Scrolling moves `startTime`; never use native DOM scroll — you cannot have a 20-million-pixel-wide div.

**Use rational time internally, not floats.** Store times as `{ value: number, timescale: number }` or as integers in the media timescale. Floating-point seconds accumulate drift across thousands of operations and will eventually put a cut one frame off. Convert to display timecode only at the render boundary. Handle drop-frame timecode (29.97/59.94) explicitly — it is a display format, not a time base, and getting it wrong is the classic amateur tell in a video tool.

**Interactions:** pointer events with capture; hit-test regions computed from the viewport transform. Snapping targets: playhead, keyframes, clip edges, markers, timeline start/end — with a pixel-distance threshold, not a time threshold, so snapping feels consistent at every zoom. Wheel scrolls; ctrl/cmd+wheel zooms (matches Premiere/Resolve and every DAW).

**Keep React out of the render loop.** React owns the shell, toolbars, and the inspector. The timeline is an imperative controller subscribed to the store, drawing on `requestAnimationFrame`. React re-renders on discrete state only (selection changed, tool changed), never on playhead movement.

### 2.5 Thumbnail service

**Responsibility:** produce the filmstrip fast, progressively, and without melting the machine.

**Decode only sync samples.** You already have `keyframeTimes` from the index. A 2-second GOP over 4 hours is ~7,200 keyframes — every one of which decodes independently, so there is no dependency chain to walk. Hardware-accelerated `VideoDecoder` chews through these far faster than the seek-a-hidden-`<video>` approach, which costs 50–300 ms per frame because each seek re-primes the decoder.

Pipeline, in a worker:
1. Read the sample's bytes: `file.slice(offset, offset + size)` → `arrayBuffer()`. Lazy, no full-file read.
2. Wrap as `EncodedVideoChunk` with `type: 'key'`, feed `VideoDecoder`.
3. On output `VideoFrame` → `createImageBitmap(frame, { resizeWidth: 160, resizeHeight: 90 })`.
4. **`frame.close()` immediately.** A leaked `VideoFrame` holds a GPU buffer and will stall the decoder within a handful of frames. This is the single most common WebCodecs bug.
5. Pack ~100 thumbnails into a sprite atlas, encode to WebP/JPEG, write to OPFS.

**Multi-resolution pyramid.** Generate coarsest first so something appears in under a second:

| Level | Interval | Count (4 h) | Use |
|---|---|---|---|
| 0 | 60 s | 240 | whole-file overview |
| 1 | 10 s | 1,440 | medium zoom |
| 2 | every keyframe | ~7,200 | close zoom |

Disk cost at level 2 with ~4 KB JPEGs is ~30 MB. RAM cost is bounded by keeping only visible-plus-margin `ImageBitmap`s live (a 160×90 bitmap is ~57 KB; 300 of them is 17 MB) in an LRU that calls `.close()` on eviction.

**Viewport-driven priority queue.** Requests are scored by distance from the current viewport centre and cancelled when they scroll out. Never generate the whole strip eagerly.

**Fallback path** (no WebCodecs): hidden `<video>` + `seeked` + `drawImage`. Restrict to levels 0–1 and warn that the fine strip is unavailable.

### 2.6 Waveform service

Same shape as thumbnails, different codec class. **Do not use `AudioContext.decodeAudioData`** — it decodes the entire track into RAM as float PCM. Four hours of 48 kHz stereo float32 is ~5.5 GB.

Instead: demux the audio track, stream packets through `AudioDecoder` in a worker, reduce to min/max peaks per bucket on the fly, discard the PCM. Store a peak pyramid (e.g. 1/64 s, 1/8 s, 1 s buckets) as `Int8Array` in OPFS. Memory stays flat.

### 2.7 Export service

The heart of the product. A strategy interface with four implementations:

```
interface ExportStrategy {
  canHandle(job: ExportJob, caps: Capabilities): Support   // 'best' | 'ok' | 'no'
  estimate(job): { bytes: number, seconds: number }
  run(job, sink: WritableStream, signal): AsyncIterable<Progress>
}
```

**Tier 1 — `RemuxStrategy` (default).**
1. Resolve in-point to the nearest sync sample at or before the requested time.
2. Resolve out-point to the last sample whose composition time ≤ requested out.
3. Walk selected samples, `file.slice()` each range (coalesce adjacent samples into ~4 MB reads), pipe into a muxer writing to a `FileSystemWritableFileStream`.
4. Rebuild `stts`/`stsz`/`stco`/`stss`/`ctts` with rebased timestamps; copy `stsd` verbatim.

Memory: one read buffer plus the output sample tables. Speed: disk-bound. Works identically at 200 MB and 200 GB.

Two output-layout choices matter:
- **Fast-start MP4** (`moov` before `mdat`) requires knowing the sample tables before writing them, so either buffer the tables and write `moov` first with a pre-computed size, or write `mdat` first then `moov` and accept a non-faststart file. For local files this doesn't matter; offer faststart as an option since users often upload the result.
- **Fragmented MP4** sidesteps the problem entirely — fully streamable, no seek-back. Good default for very large outputs.

**Tier 2 — `SmartRenderStrategy` (frame-accurate, near-copy speed).**
Only the leading partial GOP is re-encoded:
```
requested in-point ──┐
                     ▼
 [I]────────────────[P][P][P][I]────────────────────[I]...
  └── re-encode this segment ──┘└── stream copy the rest ──┘
```
Decode from the preceding keyframe, drop frames before the in-point, re-encode the remainder of that GOP with `VideoEncoder` configured to match the source (same codec, profile, level, resolution, colour space, comparable bitrate), then concatenate with the untouched samples. Audio is trimmed at frame granularity and, for AAC, needs priming/`edts` handling or a short re-encode of the first frames.

Hazards to plan for: parameter-set mismatch (you may need a second entry in `stsd`, or in-band SPS/PPS), a visible quality seam if the re-encoded GOP's bitrate is off, and `avcC` length-prefixed vs Annex B bitstream format differences. Budget real time for this; it is the hardest correct thing in the project.

**Tier 2b — edit-list trim (`elst`).** Keep the leading keyframe intact and set an edit list so a compliant player begins presentation at the exact requested frame. Zero re-encode, truly frame-accurate, instant. The catch is that edit-list support in downstream players is inconsistent — some ignore it and show the extra leading frames. Ship it as an opt-in ("frame-accurate, no re-encode — may show extra frames in some players"), never as the default.

**Tier 3 — `TranscodeStrategy`.** Full decode→encode through WebCodecs, pipelined with backpressure (bounded queue of in-flight `VideoFrame`s, respect `encoder.encodeQueueSize`). Needed for resolution/codec change, filters, or when the source codec can't be copied into the target container.

**Tier 4 — `FfmpegWasmStrategy`.** Lazily imported, only offered when tiers 1–3 report `no`. Input mounted via `WORKERFS` so it isn't copied into memory. Hard-gate on output size: refuse jobs whose estimated output exceeds ~1.5 GB and explain why. Note the licensing dimension — FFmpeg builds that link x264/x265 are GPL and carry patent exposure; if you ship this commercially, that constrains which build you can distribute and may push you to an LGPL, decode-and-copy-only build.

### 2.8 Document model & command stack

Even though v1 has one source and one trim, model it as an EDL from day one — retrofitting this later is a rewrite.

```
Project {
  sources: Record<SourceId, MediaSource>       // file handle + index ref
  tracks:  Track[]                             // { id, kind: 'video'|'audio', clipIds }
  clips:   Record<ClipId, Clip>                // { sourceId, sourceIn, sourceOut, timelineStart }
  markers: Marker[]
}
```

v1 renders exactly one video track with one clip. Multi-clip becomes "the array has more entries", not a new architecture.

**Undo/redo via commands**, not snapshots (a snapshot of a project referencing gigabyte sources is fine, but command semantics give you drag-coalescing and better labels):

```
interface Command { label: string; apply(d: Draft): void; invert(): Command; mergeWith?(next: Command): Command | null }
```
`mergeWith` lets 200 pointermove events during a handle drag collapse into one undo entry. Ephemeral state (playhead, viewport, hover, in-flight thumbnails) lives outside the document and is never undoable.

---

## 3. Recommended libraries

| Concern | Recommendation | Notes |
|---|---|---|
| Demux / mux / WebCodecs glue | **mediabunny** | Pure TS, zero deps, tree-shakable, lazy on-demand file reading, streaming input *and* output with explicit arbitrary-file-size support. Covers MP4/MOV/fMP4/WebM/MKV/MP3/WAV/OGG/FLAC/TS and 25 codecs, with a conversion API that includes trimming. Licensed MPL-2.0 (file-level copyleft — fine for a web app, but read it before shipping commercially). |
| Alternative demuxer | mp4box.js | Battle-tested ISOBMFF; more manual, and you must be careful to release sample objects or memory balloons. Good second opinion / cross-check. |
| Fallback transcode | @ffmpeg/ffmpeg 0.12+ | With `WORKERFS` for input. Lazy-loaded chunk. |
| Worker RPC | Comlink | Keeps the worker boundary typed and boring. |
| State | Zustand (+ Immer) | Small, no context re-render storms, easy to keep the timeline out of React. |
| Build | Vite + TypeScript strict | Worker imports via `new Worker(new URL(...), {type:'module'})`. |
| Testing | Vitest (unit), Playwright (E2E) | Playwright can drive real file input and real WebCodecs in Chromium headed mode. |
| UI | React 18+, Radix primitives or headless, Tailwind | Nothing exotic; the interesting UI is canvas. |

Deliberately **not** recommended: a general video-editing framework. The hard parts here are file-size and accuracy constraints that no off-the-shelf editor library respects.

---

## 4. Browser API decisions

| API | Verdict | Reasoning |
|---|---|---|
| **File System Access API** | Yes, with fallback | `showOpenFilePicker` gives a persistable handle; `showSaveFilePicker` + `createWritable()` is the only way to stream a multi-GB output straight to disk. Chromium-only in practice — Firefox and Safari ship OPFS but not the local-disk pickers. Fall back to `<input type="file">` for open and anchor-download for save. |
| **`<video>` + object URL** | Yes, primary playback | Zero-copy, hardware decode, browser handles seeking. |
| **WebCodecs** | Yes, for analysis + re-encode | ~95% global coverage now (Chrome/Edge 94+, Firefox 130/133+ desktop, Safari 26+). Not on Firefox Android. Note AAC *encoding* is missing in Firefox and on desktop Linux — relevant only for tier-3 MP4 output. |
| **MediaSource** | No, not in v1 | See §2.3. Revisit for multi-clip preview or unsupported containers. |
| **OPFS** | Yes, for derived data only | Thumbnail atlases, waveform peaks, index snapshots, export scratch. `createSyncAccessHandle` gives fast worker-side random access. **Do not copy the source file into OPFS** — that's a 20 GB duplicate and violates the no-unnecessary-copies goal. |
| **Web Workers** | Yes, extensively | See §5. |
| **SharedArrayBuffer** | Only if you ship ffmpeg.wasm-mt | It forces cross-origin isolation (`COOP: same-origin`, `COEP: require-corp` or `credentialless`), which breaks third-party embeds and complicates hosting. Avoiding the wasm path avoids the headers. If you do need it, `credentialless` is the less painful COEP variant. |
| **WASM multithreading** | Deprioritise | Only benefits ffmpeg.wasm, which is already the fallback. WebCodecs is hardware-accelerated and off-thread by construction; it beats multithreaded wasm handily. |
| **`requestVideoFrameCallback`** | Yes | The only reliable frame-accurate playhead sync. Feature-detect; fall back to rAF + `currentTime`. |
| **WebGPU / WebGL** | Later | Only when compositing multiple tracks with effects. Canvas 2D is sufficient through M5. |

---

## 5. Main thread vs workers

**Main thread only:**
- React rendering and DOM
- The `<video>` element and all interaction with it (it is not transferable)
- Canvas draw calls for the timeline, plus pointer input and hit-testing
- The document/command store

**Workers:**

| Worker | Job | Instances |
|---|---|---|
| `index.worker` | Parse container, build sample tables, compute fingerprint | 1 |
| `thumbnail.worker` | Keyframe decode → bitmap → atlas → OPFS | `min(4, hardwareConcurrency/2)` |
| `waveform.worker` | Audio decode → peak reduction → OPFS | 1 |
| `export.worker` | Remux / smart render / transcode, writes to disk | 1 |
| `ffmpeg.worker` | ffmpeg.wasm, lazily instantiated | 0 or 1 |

**Transfer discipline:** pass `ArrayBuffer`s and `ImageBitmap`s as transferables, never structured-clone a large buffer. Transfer the sample-index typed arrays once at build time; if multiple workers need them simultaneously, back them with a `SharedArrayBuffer` *if* you already have cross-origin isolation, otherwise keep one authoritative copy in the index worker and answer queries by RPC.

**A subtlety:** `OffscreenCanvas` for the timeline is tempting but usually a net loss — the timeline needs synchronous hit-testing against pointer events that arrive on the main thread, and the draw work is small once you're layer-caching. Reach for it only if profiling shows canvas work blocking input.

---

## 6. Data flow

**Open →**
```
user gesture → showOpenFilePicker() → FileSystemFileHandle
  ├→ handle.getFile() → File → URL.createObjectURL → <video>.src   [playable immediately]
  └→ transfer File to index.worker
        → fingerprint → OPFS index cache hit? → yes: load, done
                                              → no: parse moov → SampleIndex
        → transfer typed arrays to main thread
              → timeline gets duration, fps, keyframe ticks
              → thumbnail pool starts at level 0
              → waveform worker starts
```

**Scrub →**
```
pointermove → xToTime() → store.setPendingSeek(t)
  → seek coordinator: if no seek in flight → video.currentTime = t
  → 'seeked' → if pendingSeek changed → issue next
  → rVFC → actual mediaTime → playhead layer redraw
```

**Export →**
```
in/out + mode → ExportJob
  → strategy selection (capabilities × job × source codec)
  → showSaveFilePicker() [must be inside the click handler, before any async work]
  → handle.createWritable() → WritableStream
  → export.worker: read ranges from File ──▶ mux ──▶ write stream
  → progress events → UI
  → writable.close()
```

Note the gesture constraint: `showSaveFilePicker()` throws if it isn't handling a user gesture, so acquire the handle *first*, then start computing.

---

## 7. Bottlenecks, performance, memory

### Ranked bottlenecks

1. **Index parse of a very long file.** The `moov` atom for a 4-hour recording can be tens to hundreds of MB, and naive object-per-sample parsing turns that into gigabytes of JS heap. Mitigation: typed-array sample tables, parse in a worker, cache the result in OPFS, show a determinate progress bar. *Measure this in week one — it's the highest-variance unknown.*
2. **Thumbnail throughput at deep zoom.** Mitigated by keyframe-only decode, the resolution pyramid, viewport-priority scheduling, and atlasing.
3. **Seek latency during scrub.** Mitigated by seek coalescing, `fastSeek` in scrub mode, and (later) a WebCodecs scrub-preview decoder that can render arbitrary frames without round-tripping through `<video>`.
4. **Disk read bandwidth during export.** This is the floor for tier 1 and it's fine — you're copying bytes. Coalesce adjacent sample reads into ~4 MB chunks; per-sample `slice()` calls on 860k samples add real syscall overhead.
5. **Timeline redraw at 60 Hz.** Mitigated by layer caching; only the playhead layer is hot.
6. **GPU memory from leaked `VideoFrame`/`ImageBitmap`.** Not a throughput bottleneck — a hard failure. Enforce `.close()` with a small ref-counted wrapper and assert in dev builds.

### Memory budget target

| Component | Steady state |
|---|---|
| Source file in JS heap | **0 bytes** — `File` is a lazy disk reference |
| `<video>` internal buffers | browser-managed, tens of MB |
| Sample index (~860k frames) | ~25 MB typed arrays |
| Live thumbnail bitmaps (LRU) | ~15–20 MB |
| Waveform peaks (in view) | < 5 MB |
| Export read buffer | ~4–16 MB |
| Canvas layers | ~20 MB |
| **Total** | **well under 200 MB for a 20 GB file** |

Compare to the ffmpeg.wasm-centric design: instant failure above ~2 GB.

### Rules that keep it there

- Every read is a `slice()` of the source; nothing accumulates.
- Every write goes to a `WritableStream`; nothing accumulates.
- Everything derived is bounded by an explicit LRU with a byte budget, not by "however much we generated".
- Nothing that references a `VideoFrame` escapes the function that created it.

---

## 8. Browser compatibility

**Target Chromium first and be honest about it in the UI.** This is a professional local-file tool; the capabilities it needs are Chromium capabilities today.

| Feature | Chrome/Edge | Firefox | Safari |
|---|---|---|---|
| `showOpenFilePicker` / `showSaveFilePicker` | ✅ 86+ | ❌ | ❌ |
| OPFS | ✅ | ✅ | ✅ 15.2+ |
| WebCodecs decode | ✅ 94+ | ✅ 130+ desktop | ✅ 26+ (partial 16.4–18.7) |
| WebCodecs AAC encode | ✅ (not Linux) | ❌ | ✅ 26+ |
| `requestVideoFrameCallback` | ✅ | ⚠️ verify | ✅ |
| SharedArrayBuffer | ✅ w/ COI | ✅ w/ COI | ✅ w/ COI |

**Degradation ladder:**
1. Full experience: Chromium desktop.
2. Firefox/Safari: open via `<input type="file">`, play, scrub, thumbnail, trim — but export must either stage in OPFS then download (costs a temporary full-size copy, so cap it) or be blocked above a size threshold with a clear explanation.
3. Mobile: out of scope. Aggressive memory limits and no pickers.

**Container/codec risk is the bigger product concern.** MP4/MOV with H.264+AAC plays natively everywhere. MKV does not play in Chrome. HEVC depends on OS/hardware. ProRes doesn't play in browsers at all. Since screen recorders and cameras emit exactly these formats, plan for it: detect at open time, and offer either (a) a WebCodecs-decoded canvas preview path, or (b) a generated low-res proxy in OPFS. Be upfront that proxy generation of a 20 GB file is a long operation — and note that trimming can still work via remux even when preview doesn't, since remuxing needs no decoder.

---

## 9. Key tradeoffs, stated plainly

**Stream copy vs re-encode.** Copy is I/O-bound and lossless but can only start at a keyframe, so the in-point may shift by up to a GOP length (typically 0.5–10 s, and much longer for some screen recorders). Re-encode is exact but costs decode+encode time and a generation of quality loss. Out-points are frame-accurate either way — only the in-point is constrained.
**Design response:** default to copy, render keyframe ticks on the timeline, snap the in-handle to them by default with a modifier to override, and show the user exactly how much the cut moved. Offer smart render as "exact cut, slightly slower". This turns a limitation into a visible, controllable feature rather than a surprise.

**mediabunny vs ffmpeg.wasm.** mediabunny is faster, streams both directions, has no size ceiling, and adds ~tens of KB after tree-shaking. ffmpeg.wasm covers more formats and filters but is size-capped, slow, ~30 MB of wasm, and drags in COOP/COEP plus GPL/patent questions. Use the first as the engine and the second as a lazily-loaded escape hatch.

**Canvas vs DOM timeline.** DOM is easier to style and gets accessibility and hit-testing free; canvas is the only thing that survives a 4-hour frame-level timeline. Canvas wins, at the cost of hand-rolled hit-testing and an explicit a11y story (keyboard-first controls, ARIA live region announcing playhead/in/out timecodes).

**Chromium-first vs universal.** Universal means giving up streamed export, which is the single most valuable property of the design. Chromium-first with graceful degradation is the right trade for a pro tool.

**EDL model in v1 vs YAGNI.** Modelling clips and tracks now costs maybe a day; retrofitting them costs a rewrite of the timeline, the export pipeline, and the command stack. Build the model, render one clip.

---

## 10. Project structure

```
src/
  app/                      React shell, providers, routes, error boundaries
  platform/                 THE browser-differences layer
    capabilities.ts
    fs/  openFile.ts  saveFile.ts  opfs.ts  fallbacks.ts
  domain/                   PURE TypeScript. Zero browser APIs. Node-testable.
    time/  rational.ts  timecode.ts  framerate.ts
    edl/   project.ts  clip.ts  track.ts  selection.ts
    commands/  command.ts  trimCommands.ts  history.ts
  media/
    index/   sampleIndex.ts  fingerprint.ts  indexCache.ts
    playback/  PlaybackEngine.ts  NativeVideoEngine.ts
    thumbnails/  service.ts  atlas.ts  scheduler.ts  cache.ts
    waveform/    service.ts  peaks.ts
    export/
      ExportStrategy.ts
      RemuxStrategy.ts
      SmartRenderStrategy.ts
      TranscodeStrategy.ts
      FfmpegWasmStrategy.ts
      selectStrategy.ts
    ffmpeg/  loader.ts  workerfs.ts        (lazy chunk)
  workers/
    index.worker.ts  thumbnail.worker.ts  waveform.worker.ts
    export.worker.ts  ffmpeg.worker.ts
    protocol/                              shared message types
  state/
    documentStore.ts  viewportStore.ts  playbackStore.ts  jobsStore.ts
  ui/
    timeline/
      TimelineCanvas.tsx                   thin React wrapper
      renderer/  Renderer.ts  layers/*.ts
      interaction/  hitTest.ts  drag.ts  snapping.ts  shortcuts.ts
    player/  inspector/  export/  common/
  lib/                      generic utils, no domain knowledge
tests/
  unit/  integration/  e2e/  fixtures/     small + synthetic-large media
```

**The load-bearing rule:** `domain/` imports nothing from `media/`, `platform/`, `ui/`, or `workers/`. Trim math, timecode conversion, snapping, and the command stack are pure functions you can test in milliseconds without a browser. Everything gnarly and browser-shaped lives behind a port in `media/` or `platform/`. If you keep that boundary honest, this codebase stays pleasant at 50k lines.

---

## 11. Implementation roadmap

### M0 — Feasibility spikes (~1 week). Throwaway code.
Prove the three riskiest assumptions before designing around them.
- Open a real 20 GB file, `createObjectURL`, play and seek. Watch Chrome's task manager: JS heap should not move.
- Parse the `moov` of that file. Time it. Measure peak heap. **If this is slow or memory-hungry, the whole thumbnail and trim design shifts** — better to know now.
- Decode 200 keyframes with WebCodecs and time it.
- Write 2 GB through `FileSystemWritableFileStream` and confirm flat memory.

*Exit:* four numbers written down. Delete the code.

### M1 — Walking skeleton (~3 weeks)
The thinnest vertical slice that trims a real file end to end.
- Open (FSA + fallback), native playback, basic scrub bar
- Index worker producing the sample index
- Timeline v0: fixed zoom, playhead, in/out handles, timecode readout
- `RemuxStrategy` with keyframe-snapped in-point, streaming to disk
- Progress + cancel

*Exit:* trim a 20 GB MP4 to a 30-second clip; output opens in VLC and QuickTime; peak memory < 300 MB.

### M2 — Professional timeline (~4 weeks)
- Zoom/pan with cursor anchoring, kinetic scrolling, layer-cached rendering
- Thumbnail service with the pyramid, OPFS cache, viewport-priority scheduling
- Keyframe tick marks and snapping
- Frame stepping off the real PTS list; drop-frame timecode
- Keyboard map (J/K/L, I/O, arrows, shift-arrows, +/-, home/end)

*Exit:* smooth 60 fps interaction on a 4-hour file at every zoom level.

### M3 — Accuracy modes (~4 weeks)
- `SmartRenderStrategy`
- Edit-list trim as an advanced option
- Export dialog that explains the modes and previews the actual resulting cut points
- `TranscodeStrategy` for format changes

*Exit:* a frame-exact cut whose first frames are visually indistinguishable from the source.

### M4 — Production hardening (~3 weeks)
- Capability detection UI, degradation paths, ffmpeg.wasm fallback behind a lazy chunk
- Error taxonomy (unsupported codec, permission revoked, disk full, decoder failure) with actionable messages
- Stress matrix: VFR sources, rotated video, multi-audio-track, B-frame-heavy, 8-hour, 4:2:2, HDR
- Structured telemetry (opt-in) and crash-safe job recovery

*Exit:* a stranger's screen recording trims correctly without you debugging it.

### M5 — Editor foundations (~6 weeks)
- Multi-clip on one track, ripple/roll trim, undo/redo across everything
- Waveform display, audio scrubbing
- Metadata inspector, batch trimming (queue of jobs against one source)

### M6 — Multi-track (open-ended)
- `CompositedEngine` (WebCodecs + WebGPU), multiple video/audio tracks, transitions, mixing
- This is where you finally do need to render preview yourself, and where the EDL model from M1 pays for itself

---

## 12. Open questions to settle before M1

1. **Format scope.** MP4/MOV only in v1, or MKV too? MKV can't be previewed natively in Chrome, which forks the playback design. Recommendation: MP4/MOV in v1, MKV in M4 via proxy or WebCodecs preview.
2. **Is Chromium-only acceptable for launch?** If not, M1 needs the OPFS-staging export fallback and a size cap.
3. **Do users need faststart output?** If they upload results, yes; it changes the muxer strategy.
4. **Persistence.** Should a project survive a reload? FSA handles can be stored in IndexedDB and re-permissioned, which makes this cheap — but only if you design for it now.
5. **Commercial licensing.** mediabunny is MPL-2.0; an ffmpeg.wasm build linking x264/x265 is GPL with patent exposure. Decide early whether tier 4 ships at all.

---

## References

- Mediabunny — https://mediabunny.dev/guide/introduction
- ffmpeg.wasm large-file discussion (WORKERFS) — https://github.com/ffmpegwasm/ffmpeg.wasm/discussions/516
- WebCodecs codec selection — https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Codec_selection
- File System Access API — https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker
