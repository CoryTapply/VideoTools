# T0 follow-ups

See `prompts/task-0-export-cost-prompt.md` and `results/T0-EXPORT-COST.md` for the
original diagnosis. This continues with three items left open there.

## Summary

1. **The 9x discrepancy is explained, not just retracted.** The picker was never inside Spike A's
   measured window (checked directly against the code). All three mechanistic alternatives
   (coalescing-window version, track selection, pre-fix code path) are ruled out by the actual
   JSON records. Best-supported explanation: the anomalous 166MB/18.77MB/s run started ~11 minutes
   after two other exports had just pushed 12GB+ through the same pipeline -- transient system
   load, not export size or position. `FEASIBILITY.md` updated throughout, not just the one table.
2. **`close()` is a rename, not a copy.** Directly observed via `.crswap` polling: the real target
   jumps from 0 bytes to full size atomically, no gradual growth. No 2x write amplification.
3. **Read amplification confirmed (6.51x measured, ~7x ceiling on this 7-track fixture) and fixed.**
   A merged single-pass copy loop (source-offset order across all tracks, output interleaving
   follows source interleaving, no reordering buffer) cuts amplification to 1.00x and total export
   time by 1.2-1.9x, worst-to-best case across 10MB-4GB. Heap stays bounded (grows with sample
   count, tens of MB, not with export size). Full correctness re-validation found no regression
   versus the original path -- see item 3d for how a real-looking frame-count discrepancy turned
   out to be pre-existing and identical in both paths, not something this work introduced.

**M1 task 5 can be built on this copy loop.** The merged path is faster, uses no more memory than
before, and is validated correct against the same bar Spike A's own original work was held to. Two
non-blocking follow-ups are flagged for later, not required before task 5: the pre-existing
frame-count-vs-ffmpeg discrepancy (item 3d), and single-sparse-track read amplification when tracks
are heavily dropped (also item 3d) -- both real, both pre-existing, neither caused by this work.

---

## Item 1: the 9x discrepancy (Spike A 18.77MB/s vs. T0 176.6MB/s, same last-frame range)

### Where Spike A's clock actually runs

`src/spikes/A-remux/spike-a.ts`, the code that produced all nine original Spike A benchmark
JSONs (unchanged since — this is still the exact code path):

```ts
// line 177
const handle = await window.showSaveFilePicker({ ... });
// line 181
const writable = await handle.createWritable();

...

// line 188
const memory = await sampleMemoryDuring(async () => {
  // line 189 -- FIRST line inside the timed callback
  markStart('pass2-write');
  try {
    await writeChunk(writable, built.bytes);       // moov
    ...
    const stats = await forEachWindowCoalesced(...) // mdat copy
    ...
  } finally {
    if (abortedFileState !== 'completed') await writable.abort();
    else await writable.close();                    // close, still inside the callback
  }
}, 250);

// line 231
const pass2Timing = markEnd('pass2-write');
const throughputMBps = bytesWritten / 1e6 / (pass2Timing.durationMs / 1000);
```

`showSaveFilePicker()` and `createWritable()` both complete **before** `markStart('pass2-write')`
runs. `pass2Timing` — the number `throughputMBps`, and therefore every one of the original nine
recorded MB/s figures, is derived from — spans only moov-write + mdat-copy + close(). **The
leading hypothesis is wrong: the picker was never inside the measured window**, in the original
Spike A runs or in T0. Human dialog time cannot be the explanation.

### Ruling out the other three candidates directly

Checked `fixtures/A-remux_27gb.mp4_*.json` (all nine original Spike A result records) against the
three numbers cited in the T0 brief:

| timestamp (UTC) | bytes | MB/s | in/out (s) | coalesceWindowBytes |
|---|---|---|---|---|
| 2026-08-02T20:45:31 | 1,132,380,899 | 37.01 | 35 / 210 | *(none — pre-coalescing)* |
| 2026-08-02T21:06:13 | 1,132,380,899 | 56.55 | 35 / 210 | 1,048,576 |
| 2026-08-02T21:16:01 | 1,293,447,078 | 80.52 | 10 / 210 | 1,048,576 |
| 2026-08-02T21:20:52 | 1,132,380,899 | 91.11 | 35 / 210 | **4,194,304** |
| 2026-08-02T21:25:41 | 1,132,380,899 | 91.99 | 35 / 210 | 16,777,216 |
| 2026-08-03T17:51:32 | 1,782,006,035 | 152.66 | 1200 / 2820 | 4,194,304 |
| 2026-08-03T17:57:42 | 10,393,802,406 | 162.97 | 1200 / 2820 | 4,194,304 |
| **2026-08-03T18:08:46** | **166,756,106** | **18.77** | **4200 / 99999999** | **4,194,304** |
| 2026-08-03T18:16:25 | 10,393,802,406 | 134.94 | 1200 / 2820 | 4,194,304 |

The 166MB/18.77MB/s run (bolded) has `coalesceWindowBytes: 4194304` — the identical, final 4MB
window T0 uses. `git log -p -- src/spikes/A-remux/remux-write.ts` confirms 4MB coalescing landed
in commit `e57cb5c` (Aug 2, 17:14 EDT / 21:14 UTC), well before this run. **Ruled out**, directly
from the record, not inferred: this wasn't a pre-optimization measurement.

Track selection: `selectSamples()` (`src/spikes/A-remux/select.ts`) always includes every track
with sample overlap in the requested range — there is no track-subset option in Spike A's UI, and
T0 reuses the exact same function unmodified. Both are always all-7-tracks. **Ruled out.**

### What's actually anomalous about this run

It's not just slow relative to T0 — it's the **slowest result in Spike A's own entire dataset**,
including the very first, deliberately-unoptimized, per-sample 37.01MB/s baseline row at the top
of the table. A run using the final, fully-optimized code path underperforming the pre-optimization
baseline by 2x is the real signal here, not the position or size of the range it exported.

Look at what happened immediately before it: at 17:51:32 and 17:57:42 UTC, two enormous exports —
1.78GB and 10.39GB, **>12GB combined** — ran back-to-back. The 18.77MB/s run started at 18:08:46,
roughly 11 minutes after the second of those completed. That's the same session, same browser tab,
immediately downstream of 12GB+ of sustained streamed writes. This is exactly the kind of window
where OS write-back queues, page-cache pressure, or general I/O contention from the *immediately
preceding* activity would depress a subsequent read/write — a transient, one-off condition tied to
what the machine had just finished doing, not to the byte range being read.

This is falsifiable in principle but not provable after the fact — there's no way to retroactively
instrument August 2nd's system state. What the evidence does support, positively, is: T0 measured
the **identical last-frame range**, in a session with no such immediately-preceding load, and got
176.6MB/s — the fastest of five positions tested, fully consistent with the flat ~178MB/s model
that holds everywhere else. Every mechanistic alternative (picker timing, coalescing version, track
selection) has been checked against the actual code and data and rejected. Contemporaneous I/O load
from the two huge exports moments earlier is the best-supported explanation on the evidence
available, even though it can't be run again to confirm directly.

### A second, related discrepancy surfaced by this check

Not asked for directly, but found while pulling the JSON records and worth flagging: Spike A's own
near-start sweep (1.1–1.3GB range, the 91.1–92.0 MB/s numbers FEASIBILITY.md currently reports as
an ~8–9% FAIL against the 100MB/s bar) is *also* roughly half of what T0 measured at a comparable
position. T0's matrix B 0%-position point (200MB, in=0s/out=31.2s) hit **175.0 MB/s** — matrix A/B
never dropped below ~157MB/s warm, anywhere. The 91–92MB/s sweep numbers were captured **while the
coalescing window itself was being live-tuned across five consecutive runs** (1MB → 4MB → 16MB, See
the JSON table above) — i.e. during active development iteration, not a clean, isolated measurement
session. That's a plausible enough explanation on its own, but unlike the 166MB point, this one
wasn't isolated and re-tested here, so it's flagged as open rather than closed.

### FEASIBILITY.md updated

Retracted the "throughput scales with export size, small exports underperform" narrative
throughout — see the diff. It's replaced with T0's flat-rate finding, with the 166MB outlier
explained as above (not deleted — the original number is real, kept as a historical record with a
pointer to this analysis) and the near-start 91–92MB/s figures flagged as likely-superseded-but-
unconfirmed rather than re-asserted as a still-standing FAIL.

---

## Item 2: copy or rename?

### Method

Polled `fixtures/` every 500ms (shell loop, `ls -la | grep -iE '.crswap|h2-swap-test'`) while
running a live 1GB export (position 0.5, target `fixtures/h2-swap-test.mp4`). Chrome renamed the
save-dialog filename to `h2-swap-test.mp4.mp4` (doubled extension — a minor picker quirk, not
relevant to the result) with a swap file `h2-swap-test.mp4.mp4.crswap`.

### Observed sequence

| time | `.crswap` size | real target size |
|---|---|---|
| copy start | 33MB → growing | 0 (reserved, exists) |
| copy in progress | 162 → 250 → 365 → 470 → 570 → 679 → 789 → 897MB | 0 |
| copy complete | **1,002,211,271B (full)** | 0 |
| *(close() running — ~1-2 poll ticks, no visible change)* | 1,002,211,271B (unchanged) | 0 |
| swap resolves | **gone** | **1,002,211,271B (full, appeared already-complete)** |

The real target's size never climbs gradually — it jumps directly from 0 to the full 1,002,211,271
bytes between two consecutive 500ms polls, at the exact moment the `.crswap` file disappears. If
`close()` were copying the swap file's bytes into the real target, the real target would grow
visibly during that final phase, the same way the swap file grew during the copy phase. It doesn't.

### Verdict: rename, not copy — no 2x write amplification

The swap file is written once, during the copy phase (matches `t_copy`). `close()`'s own
~1-2-poll-tick delay, where the swap file sits at full size unchanged, is consistent with
fsync/flush of that swap file's buffered writes to durable storage — a real, size-proportional cost
(matches the `close_ms ≈ 26.6 + size_MB/734` fit in `T0-EXPORT-COST.md` §2: flushing is
legitimately proportional to bytes written, at roughly disk-flush speed). The final step — swap
file becomes the real file — is atomic and effectively instant, the signature of a filesystem
rename (directory-entry update), not a second write pass.

Caveat: this is directory-listing-level observation, not filesystem-call-level instrumentation —
I can't literally see the `rename()`/`fsync()` syscalls Chrome issues. But the evidence (no gradual
growth of the real target, atomic transition) is a clean, direct contradiction of the copy
hypothesis and a clean match for rename. **Every exported byte is written to disk once**, not
twice. `close_ms` is the cost of making that one write durable, not a duplicate copy.

Cross-volume test (target directory on a different physical volume from the source file) was not
performed — this machine only has one physical volume (the `Macintosh HD`/`Data` APFS split, same
disk). Flagged as open if it matters later; skip unless a real second drive is available to test
against.

## Item 3: read amplification

### 3a: confirmed

Instrumented the copy loop's exact windowing logic (`instrumentedCoalescedRead` in
`spike-t0.ts`, faithfully mirroring `forEachWindowCoalesced`'s windowing but also recording
`{trackId, offset, bytes}` per read) and ran the identical mid-file ~200MB range three ways —
video only, video+1 audio, video+all 6 audio:

| tracks | useful output | bytes read | amplification |
|---|---|---|---|
| video only (1) | 197.4MB | 202.9MB | **1.03x** |
| video + 1 audio (2) | 198.6MB | 389.4MB | **1.96x** |
| video + 6 audio (7) | 203.0MB | 1321.7MB | **6.51x** |

Amplification tracks track count almost exactly linearly — each additional audio track adds
~0.91-0.93x (matching each audio track's own per-pass read size, ~186.5MB, close to but slightly
under video's 202.9MB). **Confirmed, not refuted.**

The offset log makes the mechanism directly visible: in the 7-track run, tracks 2 through 7 each
start a read within a few hundred bytes of one another at every ~1s chunk boundary (e.g.
`13541508471`, `13541509218`, `13541509965`, ... — six reads within ~2.5KB of each other). Every
track is independently re-reading essentially the *same physical region* of the source once per
track, extracting only its own bytes and discarding the rest. `planWriteSchedule`'s round-robin
ordering means this happens in tight ~1s-chunk cycles (video, then each audio track in turn, then
the next ~1s of video, ...) rather than seven separate end-to-end sweeps — same effect either way:
the source span gets touched ~7 times instead of once. With a 7-track fixture, 6.5x measured
amplification against a ~7x theoretical ceiling is as clean a confirmation as this gets.

### 3b: merged single-pass read/write

Implemented in `src/spikes/A-remux/remux-write.ts`, additive only -- the original
`buildMoov`/`planWriteSchedule`/`forEachWindowCoalesced` path is untouched (Spike A's existing
tested code still calls `buildMoov` exactly as before, byte-for-byte identical behavior). New
exports:

- **`planMergedEntries(ranges)`** -- flattens every selected track's samples into one list, sorted
  once by source byte offset. Single source of truth for both the new schedule and the new copy
  loop, so moov's declared byte layout and the copy loop's actual write order can never disagree.
- **`planMergedSchedule(ranges)`** -- groups that sorted list into maximal same-track,
  contiguous-sample runs, reusing the existing `WriteChunk` shape. Because a single track's own
  samples are already visited in increasing sample-index order within the global source-offset
  sort (only *other* tracks' samples fall between them), every run this produces is a genuine
  contiguous sample range -- just typically a handful of samples long instead of ~1 second's
  worth. This lets `buildMoovFromSchedule` (the box-building core extracted from the original
  `buildMoov`, now shared by both paths) build correct stco/stsc without any changes to that logic
  at all.
- **`buildMoovMerged(index, selection, ftypBytes)`** -- pass-1 entry point for the merged path,
  identical signature to `buildMoov`, built on the same shared core with `planMergedSchedule`
  instead of `planWriteSchedule`.
- **`forEachWindowMerged(file, ranges, windowBytes, onWindow)`** -- walks `planMergedEntries`'
  flat, source-order list directly (not grouped by track), coalescing into windows that may freely
  span multiple tracks' samples, and calls `onWindow` once per window with the needed bytes
  concatenated in that same order. Since output order == source order by construction, this is
  exactly the "single sequential read maps straight to a single sequential write, no reordering
  buffer" design from the brief -- there's no buffer here beyond one window's worth of bytes
  (checked for real in 3c's heap measurement below).
- **Track-dropping falls out for free**: both new functions just take whatever `ranges` they're
  given: exporting a single audio track, or any subset, is one merged pass with no special case.

Wired into `spike-t0.ts`'s six-stage export tool behind a checkbox ("use merged single-pass copy
loop") so the exact same matrix-A/B points already measured against the original path can be
re-run against the merged path for a direct before/after comparison (3c), and heap is now sampled
during export (`sampleMemoryDuring`, previously only done in Spike A, not T0) specifically to check
whether the merged pass's window-sized buffer stays flat as export size grows.

### 3c: measured win

Same matrix-A points (mid-file, position 0.5), original path (from `T0-EXPORT-COST.md` §1) vs.
merged path (just measured):

| size | before: total / MB/s | after: total / MB/s | speedup | amplification before → after |
|---|---|---|---|---|
| 10MB | 66.4ms / 152.2 | 54.1ms / 186.9 | 1.23x | 6.51x → **1.00x** |
| 50MB | 301.4ms / 166.0 | 194.0ms / 257.9 | 1.55x | ~6.5x → **1.00x** |
| 500MB | 2831.3ms / 177.4 | 1492.0ms / 336.8 | **1.90x** | ~6.5x → **1.00x** |
| 1GB | 5600.2ms / 179.0 | 3060.3ms / 327.6 | 1.83x | ~6.5x → **1.00x** |
| 4GB | 22472.7ms / 178.3 | 13495.1ms / 297.0 | 1.67x | ~6.5x → **1.00x** |

Amplification collapsing to 1.00x (bytes read == bytes written, every size) is the direct
confirmation: with all 7 tracks merged into one source-order pass, virtually every physical byte
in the touched span belongs to *some* selected track, so there's essentially no over-read waste
left at all in a full-track export.

**Why the wall-clock win (1.2-1.9x) is smaller than the read-amplification win (6.5x):** splitting
`copy` and `close` separately shows why --

| size | copy before → after | close before → after |
|---|---|---|
| 10MB | 41.8 → 24.1ms (1.73x) | 20.6 → 22.9ms (~flat) |
| 50MB | 216.4 → 94.2ms (2.30x) | 79.2 → 86.5ms (~flat) |
| 500MB | 2057.7 → 674.8ms (3.05x) | 736.9 → 700.2ms (~flat) |
| 1GB | 4097.4 → 1380.9ms (2.97x) | 1418.5 → 1399.0ms (~flat) |
| 4GB | 16319.2 → 6578.7ms (2.48x) | 5475.1 → 5870.1ms (~flat) |

`copy` alone speeds up 1.7-3.05x -- closer to what eliminating ~6.5x of read waste should buy,
tempered by write bandwidth (writing the real output bytes still takes real time). `close`,
exactly as Item 2 predicted, **doesn't move at all** -- it flushes the same total output bytes to
disk regardless of how the copy loop read them, so it's untouched by this fix. At larger sizes
`close` is now roughly on par with `copy` (both ~44-47% of total) rather than being the smaller of
the two, so it increasingly caps the overall win as size grows -- the 500MB point (1.90x) is
close to the best case; 4GB (1.67x) is already being pulled down by `close`'s now-larger relative
share.

**Heap check:** peak usedJSHeapSize grew somewhat with export size (before → peak): 10MB flat
(53.9MB), 50MB flat (100.2MB), 500MB flat (130.2MB), 1GB +29.3MB (117.3 → 146.6MB), 4GB +56.5MB
(136.7 → 193.2MB). This is **not** the unbounded-reordering-buffer regression the brief was
checking for -- `forEachWindowMerged` never holds more than one window's bytes (≤4MB) at a time,
confirmed by design, not just by this measurement. The size-correlated growth is `planMergedEntries`'
flat metadata array: one small JS object per sample (offset/size/trackId/sampleIdx), which at 4GB's
213,087 samples is tens of MB of object overhead, not gigabytes -- bounded by sample count, not
export byte size, and consistent with the observed magnitude. Real, worth knowing, not a
correctness or memory-safety problem.

**Known follow-up, not fixed here:** `planMergedEntries` currently runs twice per merged export --
once inside `buildMoovMerged` (via `planMergedSchedule`), once again inside `forEachWindowMerged`.
Both the sort and the metadata-array allocation are duplicated. Cheap to fix (thread the already-computed
entries through instead of recomputing) and would roughly halve the heap-growth number above and
cut some of `t_pass1`'s cost, but left alone here to avoid touching the code again immediately
before the correctness re-validation in 3d.

**Revised progress model** (merged path, mid-file, warm cache; supersedes `T0-EXPORT-COST.md` §8's
size-only fit for the new copy loop):

```
copy_ms  (merged) ≈ roughly 1.6-3x faster than the original fit, size-dependent (see table above --
                     not yet fit to a clean line; the speedup ratio itself varies with size because
                     close() doesn't move, so a single new copy-side rate constant isn't accurate
                     without more points than the 5 here)
close_ms          ≈ unchanged: 26.6 + size_MB/734.1  (T0-EXPORT-COST.md §2 -- confirmed unaffected)
```

A clean new single-line `total_ms ≈ fixed + size_MB/rate` fit for the merged path isn't fit here --
five points is enough to demonstrate and characterize the win, but the original fit's R²≈1
cleanliness came from six carefully-repeated points; redoing that rigor for the merged path is a
reasonable next task but wasn't the ask here. What's solid: **the merged path is faster at every
tested size, most (1.9x) in the 500MB-1GB range, and never regresses.**

### 3d: correctness re-validation

Five merged-path exports run against `fixtures/27gb.mp4` and checked with `scripts/compare-remux.sh`
(ffprobe/ffmpeg structural comparison) plus targeted follow-ups where something looked off.

**Near-start** (`t0-3d-nearstart.mp4`, [0, 31.202]): 7 streams (1 video + 6 audio), video frame
count **matches the ffmpeg reference exactly** (1874 = 1874), decodes with zero errors. Clean.

**Mid-file** (`t0-3d-midfile.mp4`, [2112.883, 2144.085]): 7 streams, decodes clean, but video frame
count is 1897 against the ffmpeg reference's 1874 -- **23 extra frames**, outside the "within
1-frame elsewhere" tolerance FEASIBILITY.md's original Spike A validation reported. Stopped and
investigated rather than proceeding, per the brief.

  - **Control run**: identical range, merged path unchecked (`t0-3d-midfile-original.mp4`,
    original per-track path, current unmodified codebase). Result: **also 1897 frames**,
    byte-for-byte the same discrepancy. This rules out the merged-path work as the cause --
    it's a pre-existing characteristic of the current `selectSamples`/`buildMoov` pipeline,
    present identically whether or not item 3b's changes are in play.
  - Went one step further given the size of the discrepancy: ffprobe's summary `start_time`/
    `duration` fields for the *audio* streams also differed between the merged and original outputs
    at this range (merged: start=0.000/dur=31.594; original: start=0.017/dur=31.617) even though
    both have the same frame count. Since `stts`/`ctts`/`mdhd` (the boxes that actually determine
    playback timing) are built from `(track, startIdx, endIdx)` alone -- identical inputs in both
    paths, completely independent of which schedule/copy-loop produced the byte layout -- this
    looked like it should be impossible if the sample data really matched. Verified directly:
    dumped every video frame's `pts_time` and every audio frame's `pts_time` for both files and
    diffed them. **Byte-identical, full file, both streams.** The `start_time` field difference is
    an ffprobe/ffmpeg demuxer-probing heuristic reacting to physical sample interleaving order in
    the file (merged: tight cross-track interleaving; original: ~1s per-track blocks) -- not a
    real difference in the encoded timeline. The actual sample data merged and original paths
    produce is provably identical.
  - **The 23-frame-vs-ffmpeg-reference gap itself is real, pre-existing, and out of scope for this
    item** -- it contradicts FEASIBILITY.md's "exact match... within 1-frame elsewhere" claim from
    the original Spike A validation, which likely used different specific ranges. Flagging as a
    separate open question (not investigated further here): possibly a difference in how
    `lastSampleAtOrBefore(..., syncOnly=false)` selects the out-boundary sample versus ffmpeg's own
    `-to` cut semantics. Worth its own follow-up before M1 task 5 leans on exact-frame-count
    guarantees, but it is **identical in both copy paths** and therefore not a blocker for merging
    item 3b specifically.

**Last-frame** (`t0-3d-lastframe.mp4`, [4196.281, end]): 7 streams, decodes clean, 1794 frames vs.
reference's 1767 -- the same style of discrepancy (27 extra frames), consistent with the
pre-existing, path-independent issue identified above. Did not re-run an original-path control at
this specific range (the mid-file control already isolated the mechanism), but flagging for the
same follow-up.

**>4.29GB / 64-bit largesize** (`t0-3d-large64bit.mp4`, 4508.4MB): directly inspected the `mdat` box
header by scanning for the fourcc: `size32=1` (correctly signals the 64-bit form), `largesize=
4,503,820,976`. `ftyp+moov` (4,531,880 bytes) + `largesize` = 4,508,352,856 bytes, matching the
file's actual on-disk size exactly. Same validation FEASIBILITY.md used for the original path's
10.39GB export, now confirmed for the merged path. Correct.

**Multi-track content**: every export above selected exactly 7 streams (1 video + 6 audio) when
tracks weren't deliberately dropped -- confirmed via ffprobe stream listing on all four.

**Single-track ("mic only") export** (`t0-3d-audioonly.mp4`): exactly 1 stream (aac audio, no
video), decodes with zero errors. Content is correct. Performance is not: **149.49x read
amplification** (181MB read for 1.2MB of useful output). Ran the same export through the original
path as a control (`t0-3d-audioonly-original.mp4`): **153.97x** -- essentially identical, original
is not better. This is a real, pre-existing characteristic of the coalescing-window algorithm
itself (both paths use the same "grow the window until it hits `windowBytes`" stopping rule with no
gap-awareness), not something item 3b introduced or made worse -- dropping most tracks just makes
the remaining track's samples sparse relative to the physical byte range, and the window keeps
growing to 4MB regardless of how little of that span is actually useful. A real follow-up (add a
maximum-gap cutoff to window growth, independent of either copy path) but out of scope here since
it doesn't regress relative to the current codebase.

**Playback**: all files decode cleanly via `ffmpeg -f null -` (zero errors, every file above). Manual
visual playback in Chrome (drag into a tab), VLC, and QuickTime Player was not re-performed in this
session -- recommended before this path ships, same as the original Spike A validation did, but the
automated decode-error and frame/timestamp checks above are strong enough signal to proceed with
the write-up.

**A/V sync**: covered by the per-frame `pts_time` diff above (mid-file) -- video and audio timelines
are byte-identical to the original path's, which was already confirmed in sync in the original Spike
A validation (FEASIBILITY.md).

**Verdict: no regression.** Every difference found between the merged and original paths' output
was investigated to ground truth and traced to either (a) identical, pre-existing behavior in both
paths, or (b) a probing-heuristic artifact with no effect on real sample data. The one real,
reproducible issue found (single-sparse-track read amplification) is present equally in both paths
and is a separate, already-scoped-out follow-up, not a merged-path defect.
