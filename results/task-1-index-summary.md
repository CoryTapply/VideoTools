# M1 Task 1 — production MP4 parser and sample index: summary

Status: implemented, tested, manually verified against the real 27GB fixture in both Safari and
Chrome. PR #2 (`worktree-m1-task1-media-index` -> `main`), marked ready for review.

This doc is a handoff/context summary for a future session picking this work back up — the full
design rationale lives in `src/media/index/README.md`; this file is about what was built, what
was decided along the way, and what the test results actually show.

---

## What was built

New module at `src/media/index/`, replacing the spike parser (`src/spikes/A-remux/mp4-index.ts`)
as the production ISOBMFF parser, without modifying or deleting the spike (kept alive as a
differential oracle per the task spec).

- **`ByteSource` seam** (`byte-source.ts` + `sources/{file,node,buffer}-byte-source.ts`) — the
  core design decision. Every parsing function depends on `{ size, read(offset,length) }`
  instead of a browser `File`, so the whole ISOBMFF parsing core (`box-cursor.ts` through
  `query.ts`) runs and is unit-tested in Node with zero browser dependency. Only four files touch
  DOM types by necessity: `sources/file-byte-source.ts`, `opfs-cache.ts`, `worker.ts`,
  `worker-client.ts`.
- **`TrackIndex`** (`track-index.ts`) — typed-array per-track sample data (`pts`/`dts`/`offset`/
  `size`/`isSync`), plus video meta (coded/display dims, rotation, nominal fps, VFR detection) and
  audio meta (channels, sample rate, language, handler name).
- **Query API** (`query.ts`) — `SampleIndex` class: `frameAtTime`, `timeOfSample`,
  `nearestSyncAtOrBefore`, `nextSync`/`prevSync`, `byteRange`, `keyframeTimes`, `sampleRange`, all
  binary-search-backed over a presentation-order index built once per track.
- **Error/warning surface** (`errors.ts`) — discriminated `IndexError` union (`not-isobmff`,
  `no-moov`, `truncated`, `fragmented-mp4`, `encrypted`, `unsupported-codec`, `malformed-box`)
  returned as a value, never thrown; `IndexWarning` for non-fatal conditions (non-trivial edit
  list, multiple stsd entries).
- **fMP4 / encrypted detection** — `mvex` in moov or a top-level `moof` -> `fragmented-mp4`; a
  top-level `pssh` or an `encv`/`enca`/`encs`/`enct` sample entry -> `encrypted`. Both checked
  before any track's `stbl` is trusted.
- **OPFS cache** (`fingerprint.ts` + `opfs-cache.ts`) — fingerprint = size + lastModified + FNV-1a
  hash of first/last 1MB (never the whole file). Binary format with a `SCHEMA_VERSION` header;
  refuses to deserialize a blob written at a different version. Handles miss/corrupt/quota-exceeded/
  stale-schema explicitly, never crashes.
- **Worker wrapper** (`worker-protocol.ts`, `worker.ts`, `worker-client.ts`) — `IndexWorkerClient`
  gives a single `index(file, onProgress?)` call; SharedArrayBuffer under `crossOriginIsolated`,
  transferables otherwise.
- **Manual browser harness** (`harness.ts` + `media-index.html`) — the only way to exercise the
  27GB fixture and real OPFS; not part of `npm test`, matching the project's spike-harness
  convention and the no-CI decision made for this task.

## The §7 investigation (1-frame boundary discrepancy)

Resolved, not left as a tolerance. Root cause: `src/spikes/A-remux/select.ts`'s
`lastSampleAtOrBefore` does a **decode-order forward scan** (keep the last index seen with
`cts <= target`), while `src/spikes/B-index/queries.ts`'s `searchAtOrBefore` binary-searches a
**presentation-order** array for the largest qualifying `cts`. These are different definitions
that provably diverge under B-frame reordering. `query.ts`'s `sampleRange` (the production home
for this logic — `select.ts` is off-limits to modify) uses the presentation-order definition
exclusively, with a regression test (`query.test.ts`) built from the exact reordering pattern
observed on the 27GB fixture's video track (decode-order pts `[1440, 5940, 2970, 4410, 10440]`).

## Decisions made along the way

- **Vitest** for the test runner, **ESLint + typescript-eslint** for lint (both new to this repo)
  — scoped so `src/spikes/**` is completely excluded from linting and untouched.
- **No CI/GitHub Actions added.** Node-side tests run via `npm test`; the 27GB/OPFS checks stay
  manual, following the existing spike-harness convention.
- **`@types/node` added**, and `tsconfig.json`'s `types` array extended to include `"node"` —
  needed for `NodeByteSource`'s `node:fs/promises` import to typecheck.
- **`stsd.ts`'s RFC 6381 codec strings are new parsing work**, not a port (the spike never
  computed one). Scoped to H.264/AVC + AAC (what the project's fixtures actually produce); HEVC
  gets a best-effort implementation, untested against a real HEVC file.
- **Multiple stsd entries**: first entry used for `codec`/`description` (matches spike behavior),
  with a warning attached when `entryCount > 1`.
- **Edit lists**: any list other than a single trivial entry produces a warning, not a throw
  (the spike throws on >1 real edit) — includes the common AAC-priming-delay pattern.

## Automated test results

`npm test`: **89 / 89 passing**, 0 skipped, 0 failed.

- Unit tests for every §3 edge case (stco/co64, stsz/stz2 incl. 4/8/16-bit compact sizes, ctts
  v0/v1, stss absent/1-based, stsc run expansion incl. final-run extension, zero-sample tracks,
  'other'-kind tracks, largesize, size==0, malformed-box bounds checks).
- **Differential vs. the spike parser** (`differential-spike.test.ts`) on the committed
  `__fixtures__/tiny.mp4`: exact agreement on every sample's pts/dts/offset/size/isSync, across
  both tracks.
- **Differential vs. mediabunny** (`differential-mediabunny.test.ts`), via its `CustomSource`
  (maps directly onto `ByteSource`): exact agreement on timestamps (edit-list-adjusted — this
  fixture has a real priming-delay edit list), sync flags, byte-for-byte sample content, and the
  full keyframe list.
- **Differential vs. both oracles on `fixtures/vfr-screen.mp4`** (`differential-vfr.test.ts`):
  this suite self-skips when that gitignored fixture is absent, but **it is present in this
  worktree now** (symlinked from the main checkout) and **both comparisons passed for real** —
  real-world confirmation that stts run-length expansion handles variable durations correctly,
  not just the synthetic case.
- **Property test** (`stsc.property.test.ts`, fast-check): `computeSampleOffsets` agrees with a
  brute-force reference across randomized run structures.
- `npx tsc --noEmit`: clean across the whole repo (including `src/spikes/`).
- `npm run lint`: clean.
- `npm run build`: succeeds; `media-index.html` bundles correctly.

## Manual browser verification (`fixtures/27gb.mp4`)

Two runs, Safari and Chrome, both via `media-index.html` under `npm run dev:coi`:

| Metric | Safari | Chrome | Baseline / budget |
|---|---|---|---|
| Build time | 109ms | 164.7ms | spike: 107.1ms; budget <250ms |
| Bytes read | 27.24MB | 27.24MB (identical) | must stay far below the 27GB file size |
| Retained bytes | 41.82MB | 41.82MB (identical) | spike: 41.8MB — exact match |
| Tracks | 7 (1 video + 6 audio) | same | matches OBS fixture |
| Video samples | 253,544 | same | matches spike's known count |
| Audio samples/track | 198,081 | same | — |
| Warnings | 7 (one/track, edit lists) | same | expected — priming-delay edit lists |
| Cache write | 64ms | 102.7ms | — |
| Cache read-back | 23ms | 22.7ms | spike B: 4.86ms single-track; still far faster than build here |
| Round-trip correct | **true** | **true** | — |
| Memory peak | unavailable (Safari has no `measureUserAgentSpecificMemory`) | **88.5MB** | fail bar (FEASIBILITY.md): ≤150MB |
| Memory after == peak | — | **yes** (88.5MB both) | confirms no delayed-growth ballooning, unlike the mediabunny `BlobSource` bug found in Spike B |

Browser-to-browser timing differences (Chrome slower on build/cache-write) are implementation
overhead in `Blob.slice()`/OPFS, not the parser — `bytesRead`, `retainedBytes`, and every sample
count were bit-identical across both runs.

## What's still open

- HEVC (`hvcC`) codec-string generation is implemented but untested against a real HEVC file —
  flagged in `stsd.ts`'s doc comment.
- The worker path (`worker.ts`/`worker-client.ts`) isn't yet wired into the manual harness — it's
  exercised only by its own (untested-against-real-data) implementation; the harness currently
  calls `buildIndex` directly on the main thread. Worth adding a worker-path check to the harness
  in a follow-up if the transfer mechanics need real-world validation beyond Spike B's benchmark.
- No later-task work (playback/thumbnails/export) touches this module yet — it's a standalone,
  merge-ready foundation per the task's scope.
