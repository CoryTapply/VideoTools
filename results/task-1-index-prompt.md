# M1 Task 1 — production parser and sample index

The first real production code in the project. About a week.

**The character of this task is different from every prompt before it.** The spikes optimised for finding things out; this optimises for being built on. That means module boundaries, a testable seam, real error handling, and tests that run without a browser. Speed is already proven — 107 ms for 1.44M samples — so this task is not about making it fast, it's about making it something four other subsystems can depend on.

---

```
Context: I'm building a browser video trimmer for 20GB+ local files. The feasibility
work is done and all spikes passed. The spike parser (src/spikes/ — mp4-index.ts and
friends) proved the approach: 1,442,030 samples across 7 tracks parsed in 107.1ms,
41.8MB retained, zero mismatches against mediabunny, correct 64-bit largesize
handling. This task turns that into production code.

This is NOT a spike. Different rules apply:
  - real module boundaries, designed to be depended on
  - strict TypeScript, no `any`, no non-null assertions on parsed data
  - tests that run in Node without a browser
  - explicit error types, not thrown strings
  - no measurement harness, no results/*.json

DO NOT modify or delete anything in src/spikes/. Spike A's remux still uses the spike
parser, and I want the spike index kept as a second differential oracle against the
new one. Write new code in src/media/index/ informed by the spike, don't move files.

=== 1. THE TESTABILITY SEAM (design this first) ===

The single most important decision in this task. Define a ByteSource port:

  interface ByteSource {
    readonly size: number
    read(offset: number, length: number): Promise<Uint8Array>
  }

Implementations:
  - FileByteSource   — wraps a browser File via slice().arrayBuffer()
  - NodeByteSource   — wraps a file descriptor, for tests
  - BufferByteSource — wraps an in-memory Uint8Array, for synthetic box fixtures

Every parser function takes a ByteSource. Nothing in src/media/index/ imports File,
Blob, window, or any DOM type. This is what lets the whole module be unit-tested in
Node against hand-built box structures, which is the only sane way to test the ugly
edge cases below.

Track and report total bytes read per parse — a cheap invariant that catches
accidental over-reading, which is exactly the class of bug that cost us 6.5x read
amplification in the copy loop.

=== 2. THE SAMPLE INDEX ===

Per-track, typed arrays, preallocated:

  interface TrackIndex {
    readonly trackId: number
    readonly kind: 'video' | 'audio' | 'other'
    readonly handlerType: string        // 'vide', 'soun', 'tmcd', ...
    readonly codec: string              // RFC 6381 string, e.g. 'avc1.640034'
    readonly timescale: number
    readonly duration: number           // in timescale units
    readonly sampleCount: number
    readonly pts: Float64Array          // composition time, timescale units
    readonly dts: Float64Array
    readonly offset: Float64Array       // absolute byte offset in source
    readonly size: Uint32Array
    readonly isSync: Uint8Array
    readonly description: Uint8Array    // avcC/hvcC/esds, copied verbatim
  }

Plus per-kind metadata the export UI needs:
  video: codedWidth, codedHeight, displayWidth, displayHeight, rotationDegrees
         (derived from the tkhd matrix), nominal frame rate, and whether durations
         are constant (VFR detection)
  audio: channelCount, sampleRate, language, and the hdlr box's human-readable name

That last one matters: the OBS fixture has 6 audio tracks and the export UI has to
let a user tell the mic from desktop audio. If a name is present, surface it.

TIME REPRESENTATION: store and compute in integer timescale units. Do not store
seconds as floats anywhere in this module. Expose conversion helpers at the boundary
only. Float seconds accumulate drift and will eventually put a cut one frame off.

Public query API, all O(log n) or better:
  frameAtTime(trackId, time)               -> sample number
  timeOfSample(trackId, n)                 -> composition time
  nearestSyncAtOrBefore(trackId, time)     -> sample number
  nextSync(trackId, time) / prevSync       -> sample number
  byteRange(trackId, n)                    -> { offset, length }
  keyframeTimes(trackId)                   -> Float64Array
  sampleRange(trackId, fromTime, toTime)   -> { first, last }

Keep a performance regression test: index build on the 27GB fixture must stay under
250ms (currently 107ms), and every query under 1μs (currently 61.5-352ns).

=== 3. EDGE CASES — handle each explicitly, test each ===

These are where a parser quietly produces wrong output. Every one needs a unit test
against a synthetic box structure via BufferByteSource:

  - stco vs co64 (32- vs 64-bit chunk offsets)
  - stsz with a uniform sample_size, vs per-sample table, vs stz2 compact form
  - ctts version 0 (unsigned) vs version 1 (signed) composition offsets
  - stss absent entirely -> every sample is a sync sample
  - stss present -> remember sample numbers are 1-BASED
  - stsc run expansion, including a final run that extends to the last chunk
  - multiple stsd entries in one track (parameter set changes mid-stream)
  - tracks with zero samples
  - non-media tracks (tmcd timecode tracks, chapter tracks) -> classify as 'other',
    do not attempt to build a sample index, do not crash
  - 64-bit box largesize (size==1) — already fixed in the spike, keep the test
  - box size==0 meaning "extends to EOF"

EDIT LISTS: if a track has an edts/elst box, do not silently ignore it. Parse it,
expose it on the TrackIndex, and if it contains anything other than a single trivial
entry (media_time 0, full duration, rate 1.0), surface it as a warning on the parse
result. Note that mediabunny has a systematic ~33ms edit-list offset bug found during
spike B — if your differential test compares timestamps on a file with an edit list,
that's the likely source of disagreement, not your code.

FRAGMENTED MP4: OBS and many recorders can emit fMP4, where samples live in
moof/traf/trun boxes and stbl is empty or absent. The spike parser almost certainly
does not handle this. Detect it (presence of mvex in moov, or moof after moov) and
fail with a specific, clear error rather than producing an empty or wrong index.
Do NOT implement fMP4 support in this task — just detect and report it cleanly.

ENCRYPTED: detect senc/pssh/sinf and fail with a specific error.

=== 4. ERROR HANDLING ===

Define a discriminated union of parse failures, not thrown strings:

  type IndexError =
    | { kind: 'not-isobmff' }
    | { kind: 'no-moov' }
    | { kind: 'truncated'; expectedBytes: number; actualBytes: number }
    | { kind: 'fragmented-mp4' }
    | { kind: 'encrypted' }
    | { kind: 'unsupported-codec'; codec: string }
    | { kind: 'malformed-box'; box: string; offset: number; detail: string }

Each needs an actionable user-facing message elsewhere in the app, so carry enough
context to write one. Never throw on malformed input from a user's file — a corrupt
or unusual recording is an expected condition, not an exceptional one.

=== 5. OPFS CACHE ===

Fingerprint = file size + lastModified + a hash (any fast non-cryptographic hash) of
the first 1MB and the last 1MB. Never hash the whole file.

Serialise the typed arrays directly to a binary format with a header containing a
SCHEMA VERSION. Bump the version on any parser change so stale caches invalidate
rather than silently feeding wrong offsets into an export. This is important: a
cached index that disagrees with the parser is a data-corruption bug with a very long
fuse.

Measured targets from spike B: read-back 4.86ms vs 110.26ms rebuild for a
253,544-sample track (7.35MB serialised). Verify you're in that range.

Handle: cache miss, corrupt cache entry (fall back to rebuild, don't crash), quota
exceeded (proceed without caching), and schema version mismatch (discard and rebuild).

=== 6. WORKER WRAPPER ===

Thin worker around the module. The parser itself stays pure and worker-agnostic.

Transfer the index to the main thread. Use SharedArrayBuffer when crossOriginIsolated
is true (spike B: 9.03ms to 2 workers vs 25.34ms transferables to 1), transferables
otherwise. Set the COOP/COEP headers per architecture v2 §5.2 —
Cross-Origin-Opener-Policy: same-origin, Cross-Origin-Embedder-Policy: credentialless.

The worker API should be a single call: index(file) -> TrackIndex[] | IndexError,
with a progress callback.

=== 7. RESOLVE THE 1-FRAME BOUNDARY DISCREPANCY ===

Spike A's ffmpeg comparison reported frame counts matching exactly on the last-frame
range but "within a 1-frame boundary tolerance" elsewhere. Find out why. Do not leave
this as a tolerance — it's either a real off-by-one or a defensible semantic
difference, and it should be understood before it becomes folklore.

Hypotheses worth checking, most likely first:
  - B-frame reordering: the last sample in DECODE order is not the last in
    PRESENTATION order, so selecting "last sample with CTS <= out" and "last sample
    written" can differ by one
  - ffmpeg's -to endpoint being exclusive where our selection is inclusive
  - selecting the out-point on DTS where it should be CTS
  - a rounding difference when converting the requested out-time into timescale units

Write it up in a short comment on the selection function, and if it's a real bug, fix
it and add a regression test.

=== 8. TESTS ===

  - Unit tests, Node, no browser: every edge case in §3 against synthetic boxes
  - Property test: stsc expansion against a brute-force reference implementation
  - Golden test: the full index of a small committed fixture, snapshot-compared
  - Differential test in CI, against BOTH oracles:
      (a) mediabunny — pin the version, and document in a comment how the three bugs
          found in spike B were handled (patched, worked around, or avoided)
      (b) the spike parser in src/spikes/ — cheap, and catches regressions from the
          rewrite specifically
    Compare: sample count per track, 1,000 random samples on pts/dts/offset/size/sync,
    and the full keyframe list. Print actual disagreements with indices and both
    values — never a pass/fail percentage.
  - Browser integration test: index the 27GB fixture, assert build time and retained
    bytes, assert OPFS round-trip correctness
  - Run the differential test against vfr-screen.mp4 too — variable durations are
    where stts run-length expansion breaks

=== 9. DO NOT BUILD ===

  - chunked or lazy index building (107ms doesn't need it; architecture v2 §0 item 1)
  - MKV, WebM, or any non-ISOBMFF container
  - fMP4 sample parsing (detect and reject only)
  - an abstraction layer anticipating future containers
  - anything in src/media/playback/, thumbnails/, or export/ — later tasks

=== DELIVERABLE ===

Working module at src/media/index/, tests green, plus a short README.md in that
directory covering: the ByteSource seam and why it exists, the time representation
rule, the cache schema and its versioning contract, and what the two differential
oracles are for. Write it for someone joining the project in three months.
```

---

## Why this task is shaped this way

**The `ByteSource` seam is the whole game.** Without it, every test needs a browser and a 27 GB file, and the edge cases in §3 — which are where parsers actually break — become untestable. With it, you can hand-build a malformed `stsc` in twelve bytes and assert on the failure.

**The cache schema version is a data-integrity control, not housekeeping.** A cached index that disagrees with the current parser feeds wrong byte offsets into an export that then produces a file that plays but is subtly wrong. That bug would take a very long time to find.

**Keeping the spike parser alive buys a second oracle for free.** Two independent implementations disagreeing is how spike B found three real bugs in mediabunny; the same trick works against your own rewrite.

**fMP4 is the most likely real-world surprise.** OBS can emit it, it has no `stbl`, and a parser that assumes `stbl` will produce a confidently empty index rather than an error. Detecting and refusing it clearly is a day's work; discovering it from a user report is not.
