# Project context — browser video trimmer

Written for a session (human or model) picking this project up cold. Read this before the architecture document.

**Last updated:** after M1 task 5 (export) landed — M1 complete.

---

## What this is

A browser application for reviewing and trimming very large local video recordings — 20 GB and up. Everything runs client-side; nothing uploads. The primary use case is pulling a short section out of a long recording quickly. Long-term ambition is a lightweight browser NLE, but scope discipline has been strict: one source, one clip, one range.

Stack: TypeScript, React, Vite, modern browser APIs. Chromium-first.

## The architectural thesis, in one paragraph

A stream-copy trim is not a video-processing operation — it's a remux. Parse the container index, select a range of samples, write a new container. No decoding, no encoding. That means it runs at disk speed with constant memory regardless of file size, which is why this product can open a 27 GB file instantly and export from it in seconds. Everything else in the design exists to protect that property: native `<video>` for preview so no bytes pass through JS, a keyframe-sampled frame cache so scrubbing never waits on a seek, and a single merged read pass so the copy loop reads each byte once. FFmpeg appears nowhere in the main path.

## What was ruled out, and why

These were live options that got killed by measurement or by scope. Don't relitigate without new information.

| Rejected | Reason |
|---|---|
| **ffmpeg.wasm as the export engine** | WASM32 caps the in-memory filesystem around 2 GB, covering input plus output plus working memory. `WORKERFS` fixes large *input* but output stays memory-backed. Retained only as a lazily-loaded tier-4 fallback for formats nothing else handles. |
| **mediabunny as the parsing engine** | Three real bugs found during spike B: `BlobSource` memory ballooning, an unbounded keyframe walk that crashed the browser, and a ~33 ms edit-list offset error. Demoted to a differential test oracle, where it has been genuinely valuable. |
| **MediaSource for preview** | Requires feeding buffers from JS, meaning demuxing yourself and holding segments in memory, against a modest `SourceBuffer` quota. `<video>` already does this better for a single source. Revisit only for multi-clip. |
| **On-demand WebCodecs decode for scrubbing** | Measured p50 270 ms versus `<video>`'s 281 ms — no win. A warm decoder doesn't help because `flush()` resets the key-frame-required flag. Replaced by a pre-decoded cache. |
| **A 2 fps / 5-minute scrub cache** | Decoded 18,210 frames to keep 600, cost 27.1 s per window, and left 93% of a 70-minute timeline uncached with no designed fallback. Replaced by keyframe sampling across the whole file. |
| **Multi-resolution export** | Cut on product grounds. Full-quality output goes to YouTube, which handles downscaling better than a browser encoder working from an already-degraded file. |
| **Chunked or lazy index building** | Unnecessary. 1.44M samples index in ~110–165 ms. |
| **Safari and Firefox as first-class targets** | Neither implements `showSaveFilePicker`, so neither can stream a multi-GB export to disk. They remain view-and-small-export targets. |

**Not** ruled out, despite a related cut: **smart render** (partial re-encode for frame-exact in-points) is still planned as M3, and is now the only re-encode path in the product.

## The measured facts

Everything below is real, from a 27 GB / 70-minute OBS recording (7 tracks, 253,544 video samples, GOP 4.166 s constant) on an M1 Max with NVMe, in Chrome 151. Treat as optimistic — this is fast hardware.

| Area | Number |
|---|---|
| Index build | 110–165 ms for 1.44M samples, 41.8 MB retained, 27.24 MB read |
| Index cache read-back | ~23 ms vs ~110 ms rebuild |
| `<video>` seek | p50 281.6 ms, p95 369.4 ms |
| rVFC drift over 60 s | max 28 ms, mean 12 ms |
| Coarse frame cache warm | 5.19 s for 1,015 keyframes (195.5/sec, 2 workers) |
| `getNearest()` | p50 0.000 ms, max 0.040 ms |
| Dense window build | 1.61 s; rebuild after cancel 1.32 s |
| Atlas decode-once | 23.4 ms per atlas (matches spike C's 23.81 ms) |
| Export, post-merged-read-pass | read amplification 1.00×, copy 1.7–3× faster than the per-track version |
| Export model (pre-merge fit) | `total_ms ≈ 13.2 + size_MB / 178.5`, R² ≈ 1 across 3 MB–4 GB |
| Export peak process memory | 460 MB real (Activity Monitor), under the 500 MB M1 ceiling |
| Memory, coarse warm | +121 MB real (Activity Monitor), ~2× the naive RGBA estimate |
| Memory after `clear()` | +5 MB over idle (~3%), confirmed by two independent signals |

## Working practices that have earned their place

These emerged during the project and have repeatedly paid for themselves. Keep them.

**Testability seams, one per module.** `ByteSource` for the parser, `VideoElementLike` for playback, `FrameDecoder` for the cache. Each has a real implementation and a Node-testable fake. The pattern makes edge cases cheap to construct — a malformed `stsc` is twelve bytes — and it means all the *logic* is proven before a browser is involved.

**But run it in a browser anyway.** Every single module has produced real bugs that no Node test could catch, because they were browser-behaviour bugs. Task 2: a seek to the current position never fires `seeked`, which would have permanently stalled the coalescing pipeline. Task 3: the `avcC` box header must be stripped from `VideoDecoderConfig.description`, decode chains were being split at flush boundaries in two separate places, and a decode error left the worker's decoder wedged for all subsequent requests. Task 5: `createWritable()`/`abort()` does not protect an existing destination file from a cancelled write, despite the WHATWG spec text reading as though it should — confirmed by reproducing it directly against real Chrome, not by re-reading the spec more carefully. A checksum comparison taken immediately after cancelling looked like proof of safety and was wrong; the file was corrupt a few minutes later. The seam proves the logic; the browser pass proves the integration, and *only* the browser pass can prove a claim about what the browser actually does. Both are mandatory.

**Differential oracles.** The parser is checked against both mediabunny and the original spike parser; the export copy loop keeps its pre-merge implementation alongside the merged one for the same purpose. Two independent implementations disagreeing is how three real mediabunny bugs were found.

**Don't attribute an unexplained delta.** This project has produced a confident, wrong story from uncontrolled data three times: "export throughput scales with size" (it doesn't — read amplification), "5–8 second fixed export cost" (didn't exist), and an 18.77 vs 176.6 MB/s gap written off as system conditions. The pattern is always the same — points varying along several axes at once, fitted to a single-variable story. When a number is surprising, decouple the variables before explaining it.

**Measure memory at the OS level.** `ImageBitmap` and `VideoFrame` memory is GPU-backed and invisible to `performance.measureUserAgentSpecificMemory()`. On macOS, hardware-decoded frames live in `VTDecoderXPCService`, outside Chrome's process tree entirely — so Chrome's own task manager can't see them either. A memory number from a JS API in the frames module has not been measured.

**Frame lifecycle is structural, not disciplinary.** An unclosed `VideoFrame` grows memory 11–13 MB/frame, linearly, with zero errors thrown, to 9.3 GB. There is no runtime signal. `withFrame`/`withFrameAsync` close in `finally`; no raw frame escapes its call site.

## Where things stand

**M1 is complete — 8 of 8 tasks done.** M0 and M0.5 feasibility spikes; M1 task 1 (index), task 2
(playback), task 3 (frame cache), task 3.5 (budget re-tune), task 4a (app shell and design system
— `src/ui/`, greenfield React 19 added to the toolchain, plus an immediate follow-up wiring task
1's parser and task 2's playback engine into that shell for real —
`results/task-4a-media-integration-summary.md`), task 4b (timeline renderer — canvas layer stack,
drag-scrub), task 4c (feel calibration — no seek-drift repro found, kinetic-pan retuned), and task
5 (export — `src/media/export/`, real-browser verification found and fixed a `createWritable()`/
`abort()` safety gap; full writeup `results/task-5-export-summary.md`). CI running typecheck,
lint, and tests on every push.

M1 exit criteria are met with two flagged, non-blocking gaps (roadmap.md has the detail): VLC
playback is untested (not installed on the verification machine), and the primary video track is
locked in the track-selection UI so a literal video-free export isn't reachable through the
product UI today, only through the pipeline directly.

**Next:** M2 (timeline polish — waveform, dense-tier zoom tuning, drop-frame timecode, full
keyboard map, metadata inspector).

**Design:** a UI design exists from Claude Design; the revision request covering the MKV→MP4
correction, filmstrip/waveform proportions, the missing keyframe tick row, multi-track selection,
and the index timing figure has been incorporated — `design/README.md` is the current, authoritative
handoff doc and task 4a built directly from it.

## Document map

| Document | Purpose |
|---|---|
| `PROJECT-CONTEXT.md` | This file. Read first. |
| `architecture-v3.md` | Current architecture and subsystem state |
| `roadmap.md` | Milestones, status, exit criteria, risks |
| `results/FEASIBILITY.md` | Spike results and the constants derived from them |
| `results/T0-EXPORT-COST.md` | Export cost diagnosis |
| `src/media/*/README.md` | Per-module design rationale — the authoritative source for each |
| `design/README.md` | Design handoff contract and deltas |

## The open questions

1. **The eviction budget is not validated.** 96 MB was calibrated against a naive 58 MB estimate; real coarse-warm cost is ~121 MB.
2. **The dense-warm-below-coarse-warm anomaly.** Recorded as transient buffers; more likely LRU eviction (see architecture v3 §4). If it's eviction, zooming in silently empties the filmstrip.
3. **Post-load seek accuracy.** Accurate seeks occasionally land one frame off after heavy decoder activity. Matters for scrub-settle in task 4.
4. **The index build-time delta.** 107 ms in the spike versus 165 ms in production, same browser, still unprofiled.
5. **HEVC codec strings** are implemented but untested against real HEVC.
