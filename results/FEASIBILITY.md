# M0.5 Feasibility Synthesis

Source: spikes A (remux + streamed write), B (index at scale), C (WebCodecs scrub +
thumbnails), all run against the real 27GB OBS fixture (and `longgop.mp4` /
`vfr-screen.mp4` where noted), per `prompts/m0.5-spike-prompts.md`. All numbers below
are real measurements taken during this work — reported in-browser (Chrome) unless
otherwise noted — not synthetic estimates, except where explicitly labeled
"extrapolated."

No `results/*.json` records or `M0-FINDINGS.md` existed prior to this document; every
number here was pulled directly from the session's real browser output and cross-checked
against the raw transcript rather than backfilled from memory.

## 1. Headline table

| Metric | Result | Fail bar | Status |
|---|---|---|---|
| Index build time (27GB, 1,442,030 samples / 7 tracks) | 107.1ms | ≤5s | **PASS** (47x margin) |
| Index retained bytes (27GB, all tracks) | 41.82MB (41,818,870 B) | ≤150MB | **PASS** |
| Extrapolated 8hr/60fps (~1.7M samples) retained/build | ~49MB / ~114ms | ≤400MB / — | **PASS** (extrapolated) |
| Remux export throughput (settled, 4MB coalesced R+W) | 91.1–92.0 MB/s | ≥100MB/s | **FAIL** (~8–9% short) |
| Export JS heap growth (5 real runs, 1MB/4MB/16MB windows) | peak growth 2.0–13.7MB, returns to baseline after close | ≤100MB growth | **PASS** (7–50x margin) |
| Abort-mid-export result (real run, 1620s mid-file range) | target left as real, unlocked, 0-byte file — never truncated | no truncated/locked file | **PASS** |
| Keyframe decode rate, 27GB, sequential | 42.2–42.5/sec | ≥50/sec | **FAIL** |
| Keyframe decode rate, 27GB, batched (16) | 150.4/sec | ≥50/sec | **PASS** (3x margin) |
| Keyframe decode rate, longgop.mp4, sequential | 178.0/sec | ≥50/sec | **PASS** |
| Keyframe decode rate, longgop.mp4, batched (16) | 648.8/sec | ≥50/sec | **PASS** |
| Real keyframe interval, 27GB | 4.166–4.167s (constant) | — | matches M0's ~4.2s estimate |
| Real keyframe interval, longgop.mp4 | 10.000s (constant) | — | — |
| Arbitrary-frame latency vs `<video>`, 27GB (cold-start) | WebCodecs p50=270ms vs `<video>` p50=281ms | beat `<video>` | **MARGINAL** (~4%, within noise) |
| Arbitrary-frame latency vs `<video>`, longgop.mp4 | WebCodecs p50=53ms vs `<video>` p50=49ms | beat `<video>` | **FAIL** (WebCodecs slower) |
| Warm-decoder forward scrub, stops arriving before trailing flush | hardware 0/29, software 1/29 | make sequential scrubbing cheap | **FAIL** |
| Cache-backed scrub, 60Hz drag sustainability | p50=0.00ms p95=0.01ms max=0.17ms | sustain 60Hz | **PASS** (~100x margin) |
| Cache build time (2fps, 5-min window, 600 slots) | 27.1s (18,210 frames decoded) | not stated numerically | real, non-trivial cost |
| Query latency (10k iters, 4 query types) | 61.5–352.0 ns/op | ≤1000ns (~1μs) | **PASS** (3–16x margin) |
| Worker index transfer (253,544-sample track) | transferables 25.34ms (1 worker) / SharedArrayBuffer 9.03ms (2 workers) | — | SAB faster despite serving more workers |
| OPFS index cache vs. rebuild-from-file (253,544-sample track) | 4.86ms vs. 110.26ms | — | **22.7x faster**, worth caching |
| Thumbnail atlas (10x10, WebP q0.6) | 391,160 B, encode 148.7ms, OPFS write 1.4ms, single-thumb read+decode 23.81ms | — | works; see gap note on per-tile decode cost |
| Leak test (no `frame.close()`) | ~11–13MB/frame linear growth, 0 errors thrown up to 800 frames / 9.3GB | — | no internal safety net |
| Mediabunny correctness cross-check (27GB + vfr-screen.mp4) | 0 mismatches | any mismatch fails | **PASS** (after 3 real bugs fixed) |

## 2. Per-spike verdict

### Spike A — remux + streamed write: **GO-WITH-CHANGES**

Correctness and index-build cost are excellent, and the core remux pipeline produces
structurally-correct output (frame count matches the ffmpeg reference within a 1-frame
boundary tolerance, clean multi-track A/V sync, zero decode errors, confirmed via
`scripts/compare-remux.sh`). But:

- Export throughput settled at **91.1–92.0 MB/s**, which is *below* the spec's own
  ~100MB/s bar by ~8–9%, even after fixing two real bottlenecks (per-sample reads at
  37.0MB/s, then per-sample writes at 56.6MB/s, both fixed via 4MB window coalescing).
  16MB windows plateaued with no further gain over 4MB — the ceiling isn't buffer size.
- JS heap growth during export was measured across 5 real runs (peak growth 2.0–13.7MB,
  always returning to baseline after close): a clean pass with 7–50x margin against the
  ~100MB fail bar.
- Abort-mid-export behavior is now confirmed in a real run (1620s mid-file range,
  aborted partway through pass 2): the target is left as a real, unlocked, exactly
  0-byte file — never truncated with partial content, matching the transactional
  File System Access API write model (all buffered writes are discarded atomically on
  `abort()`, regardless of how far into the write it happens).
- Several of the spec's own required validation steps were not yet confirmed complete
  (see Known Gaps): literal VLC/QuickTime GUI playback, all 3 required export ranges,
  and the write-side 64-bit `largesize` path on an actual >4.29GB output.

### Spike B — index at scale: **GO**

Zero mismatches against mediabunny on both the 27GB file and `vfr-screen.mp4`, after
fixing three real bugs found during this work (a severe Chrome memory-ballooning bug in
mediabunny's default `BlobSource` mode, an unbounded keyframe/metadata walk that crashed
the browser at scale, and a systematic ~33ms edit-list offset bug). Every quantitative
fail condition clears with large margin: build time 107.1ms (47x under the 5s bar),
retained bytes 41.82MB (3.6x under the 150MB bar), and all 4 query types 61.5–352.0ns/op
(3–16x under the 1μs bar). No caveats.

### Spike C — WebCodecs scrub + thumbnails: **GO-WITH-CHANGES** (architecture pivot required)

The originally-envisioned scrub architecture — arbitrary on-demand WebCodecs decode,
optionally kept warm across a drag — **fails the spec's own explicit fail condition**:
arbitrary-frame latency doesn't clearly beat `<video>` (a ~4% win within noise on the
27GB file, an outright loss on `longgop.mp4`), **and** warm-decoder forward scrubbing
fails to help (0/29 and 1/29 stops actually benefited from staying warm). The root
cause: `flush()` — required to get *any* output from this decoder at all — resets the
decoder's internal "key frame required" flag, so periodically flushing to check on a
scrub target's progress forces a keyframe-restart-equivalent cost on the very next
decode, defeating warmth before it can be measured. Per the spec's own words, this
combination "means the scrub design needs rethinking entirely."

The pivot — a pre-decoded 2fps cache serving lookups instead of on-demand decode — is
the actual answer, and it works decisively: 60Hz sustained with roughly two orders of
magnitude of latency margin (p50=0.00ms against a 16.67ms budget). This should be the
scrub architecture for M1, not on-demand decode. Keyframe throughput (the filmstrip
path, a separate and simpler use case than scrubbing) passes cleanly once batched
(150.4–648.8/sec vs. the 50/sec bar, a fix that came from amortizing `flush()` cost, not
from faster I/O — coalesced reads alone barely moved the number). The leak test and
thumbnail atlas both completed with real, actionable findings.

## 3. Design changes required

- **Drag-to-scrub via on-demand WebCodecs decode is not viable, warm or cold.** The
  interaction must change to: pre-decode a sparse cache (2fps / 5-minute window, the
  spec's own tested config) and serve drag events from cache lookups, never decoding
  live during a drag. This is a real, working architecture, but it means the product
  cannot promise frame-accurate scrubbing at *every* timeline position — only positions
  within a pre-built cache window. Scrubbing far outside a cached window (e.g., a
  multi-hour recording, cache limited to a 5-minute span) needs its own fallback
  behavior (rebuild the cache around the new position, show a loading state, etc.) —
  not designed or tested here.
- **The index does not need to be chunked or lazily built** at the tested scale (27GB /
  1.44M total samples / 253,544 video samples) — 107.1ms build time is nowhere near a UX
  problem, and even the extrapolated 8hr/60fps case (~1.7M samples, ~114ms) stays
  comfortably under the fail bar. Chunked/lazy building would solve a problem that
  doesn't exist at these scales; don't build it speculatively.
- **The real-world GOP length (~4.2s on OBS footage)**, confirmed independently by both
  M0 and this session's direct measurement (4.166–4.167s, constant), means the
  keyframe-shift UI must clearly communicate potentially multi-second shifts when
  snapping a trim in-point to the preceding keyframe. Spike C's arbitrary-frame-latency
  numbers make concrete *why* that snap exists: a cold-start decode chain averages ~146
  frames (up to ~234) on this footage, which is the direct cost driver behind both the
  latency numbers and the decision to snap to keyframes rather than decode arbitrary
  frames on the fly.
- **Faststart output in one pass is affordable time-wise** (pass-1 moov build measured
  at 17–29ms on real export ranges) but throughput is the open question: 91–92MB/s
  settled, short of the spec's 100MB/s bar by ~8–9%. Both tested window sizes above 4MB
  plateaued, so the next lever is probably overlapping read and write (pipelining)
  rather than bigger buffers — worth a focused pass in M1 if 100MB/s matters for
  user-facing export-time promises.

## 4. Constants for M1

- **Read/write coalescing window: 4MB.** Settled after testing 1MB (80.5MB/s), 4MB
  (91.1MB/s), 16MB (92.0MB/s, no further gain) on a real ~1.05GB export range.
- **Thumbnail decode batching: 16 `decode()` calls per `flush()`.** 3.6x throughput over
  fully-sequential decoding (which flushes after every frame), clearing the ~50/sec bar
  by 3x on both test files. This is the single highest-leverage fix found in Spike C.
- **Index cache strategy: cache to OPFS.** Read-back (4.86ms) is 22.7x faster than
  rebuilding from the source file (110.26ms) for a 253,544-sample track (7.35MB
  serialized) — an easy win for repeat-open scenarios.
- **Multi-worker index sharing: use `SharedArrayBuffer`, not per-worker transferable
  copies**, if more than one worker needs read access to the index — 9.03ms to 2 workers
  concurrently beat 25.34ms to a single worker via transferables in this test.
- **Scrub cache window/frame rate: 2fps, 5-minute window (600 frames @ 320x180)** is the
  validated config — sustains 60Hz with ~100x latency margin. Expect **~27s** to build
  this cache (18,210 frames actually decoded to fill 600 slots — a ~30:1 decode-to-keep
  ratio inherent to needing every intervening frame, not a bug). This must happen
  progressively / in the background, never as a blocking operation before first scrub.
- **Expected export throughput for progress estimation: ~91–92MB/s** — use this measured
  number, not the original 100MB/s target, for user-facing time estimates until the
  pipelining work above closes the gap.
- **Frame lifecycle discipline is entirely the caller's responsibility.** WebCodecs
  provides no backpressure or safety net for forgotten `frame.close()` calls (confirmed:
  linear ~11–13MB/frame growth with zero thrown errors up to 800 unclosed 4K frames /
  9.3GB). Any production code path handling `VideoFrame` objects needs rigorous,
  defensive `close()` discipline (try/finally, not just the happy path) — the runtime
  will not catch this class of bug.
- **Thumbnail atlas: decode once per session, crop many times from the resulting
  bitmap in memory.** `createImageBitmap(atlasFile, sx, sy, sw, sh)` decodes the *entire*
  atlas internally even for a single requested tile (23.81ms per call) — repeating that
  call per visible thumbnail in a filmstrip would cost far more than necessary.

## 5. Known gaps

- ~~Spike A: the abort-mid-export test was never triggered and observed in a live
  run~~ — **CLOSED**: confirmed in a real run (1620s mid-file range, aborted partway
  through pass 2). The target is left as a real, unlocked, exactly 0-byte file — never
  truncated with partial content, matching (with one correction: the target isn't
  literally absent, since `showSaveFilePicker` already reserved that directory entry)
  the code's original transactional-write hypothesis.
- **Spike A: incomplete confirmation of the "3 export ranges" requirement** (near-start,
  mid-file, ending at the very last frame). ffprobe/ffmpeg structural comparison passed
  cleanly for the range(s) that were tested, but I don't have confirmation all three —
  especially the last-frame truncation edge case — were exercised.
- **Spike A: literal human playback confirmation in VLC and QuickTime** (not just
  Chrome/ffprobe) was flagged mid-session as still needing a human with the actual
  browser/file, with no later confirmation found that it happened.
- **Spike A: the write-side 64-bit `largesize` path** (output `mdat` > 4.29GB) was
  implemented per the spec's explicit instruction, but the evidenced test export ranges
  were all under ~1.1GB. No confirmation this path was deliberately exercised with a
  real >4.29GB export — only that the read-side equivalent (parsing the 27GB source's
  own `moov`) was. Matters specifically because a long 4K export can plausibly exceed
  4.29GB; should be tested deliberately before launch, not carried as an assumption.
- **Spike C: the cache-backed scrub memory footprint** (item 3's "report the memory held
  by 600 cached ImageBitmaps") could only be estimated theoretically (~131.8MB raw
  RGBA), not measured — `performance.memory.usedJSHeapSize` does not count
  `ImageBitmap`'s GPU/native-backed storage in this Chrome build.
- **Methodology note, project-wide:** JS heap APIs (`performance.memory`,
  `measureUserAgentSpecificMemory`) systematically undercount memory held by
  ArrayBuffers/GPU-backed objects living outside the JS heap. This was independently
  rediscovered twice in this session — once during Spike B's mediabunny
  memory-ballooning investigation, once during Spike C's cache-scrub memory report — and
  once during the leak test, where hardware-decoded frames didn't show up in Chrome's
  own process list at all (macOS hardware decode runs through a system service,
  `VTDecoderXPCService`, entirely outside Chrome's process tree). Any future memory
  claim based on JS-level APIs alone should be cross-checked against OS-level Activity
  Monitor, and hardware-path memory claims specifically need the *system* process list,
  not just Chrome's.
- **All measurements come from one machine** (M1 Max, fast NVMe SSD, per the
  carried-forward M0 context) running Chrome. Numbers most likely to degrade on slower
  storage or weaker hardware:
  - **Remux export throughput (91–92MB/s)** — directly disk-I/O-bound, would scale down
    roughly with storage read/write bandwidth on a slower drive.
  - **Cache build time (27.1s for a 600-frame/5-min window)** — bound by decode
    throughput. Software decode was ~4x slower than hardware in this session's own
    measurements (9.8–9.9/sec vs. 42.2–42.5/sec on the 27GB file), so a machine without
    capable hardware H.264 decode would see this multiply accordingly.
  - **Keyframe/thumbnail decode throughput generally** — same hardware-vs-software gap
    applies to both the atlas and filmstrip paths.
  - **Index build time (107.1ms) and query latency (tens-to-hundreds of ns/op)** are
    CPU/memory-bound rather than disk-bound and should be comparatively
    storage-independent, though a slower CPU would still scale these up somewhat.
- **Launch-blocker assessment:** heap growth and abort behavior are both now confirmed
  fine (7–50x heap margin over 5 real runs; abort leaves a real, unlocked, 0-byte file,
  never truncated with partial content). The VLC/QuickTime and multi-range gaps are
  lower risk given the structural ffprobe comparison already passed, and are closer to
  "nice to
  close" than launch-blocking. The write-side >4.29GB `largesize` gap matters
  specifically if a single trimmed export can exceed that size (plausible for long 4K
  exports) and should be deliberately tested before launch rather than assumed correct.
