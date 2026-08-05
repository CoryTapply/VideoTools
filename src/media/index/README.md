# `src/media/index/` -- MP4 box parser and sample index

Production module. Turns an MP4/MOV file's `moov` box into a typed-array-backed, per-track
sample index with an O(log n)-or-better query API. Parses ISOBMFF (stss/stsc/stsz/stz2/
ctts/co64/edit lists, etc.) directly -- it does not depend on `mediabunny` or any other demuxer
at runtime; that library is only ever a differential-testing oracle (see below).

If you're new to this codebase: read this file, then start at `build-index.ts` (`buildIndex`),
which is the single entry point everything else is reached from.

## Why a `ByteSource` seam

`ByteSource` (`byte-source.ts`) is a two-method interface -- `size` and
`read(offset, length) -> Promise<Uint8Array>` -- that every parsing function in this module
depends on instead of a browser `File`. Three implementations exist:
`sources/file-byte-source.ts` (wraps a real `File`), `sources/node-byte-source.ts` (wraps a Node
file descriptor), and `sources/buffer-byte-source.ts` (wraps an in-memory `Uint8Array`).

This is the single most important design decision in the module, because of what it unlocks:
the ISOBMFF edge cases that actually break parsers (64-bit box sizes, `stz2`'s 4-bit packed
sample sizes, a track with zero samples, an `stsc` run that extends through the last chunk, ...)
are exactly the things that are painful to test against a real video file, and impossible to test
in Node against a browser `File`. With `BufferByteSource`, a test builds the malformed or unusual
structure it wants to check in a dozen lines of hand-assembled bytes (see
`test-helpers/build-box.ts`) and asserts directly on the result -- no fixture file, no browser.

Nothing in this module outside `sources/file-byte-source.ts`, `opfs-cache.ts`, `worker.ts`, and
`worker-client.ts` imports `File`, `Blob`, `window`, or any other DOM type. Those four files are
the deliberate, narrow exceptions -- they're the parts that inherently need a real browser
(a `File` to wrap, `navigator.storage`, or `Worker`) and so aren't Node-testable regardless of how
they're written. Everything else -- the box/table parsers, `build-index.ts`, `query.ts` -- runs
identically in Node and in the browser, which is what makes the whole test suite runnable via
`npm test` with no browser involved.

`build-index.ts` buffers `moov` in exactly one `ByteSource.read()` call (found via an async,
`ByteSource`-driven top-level scan that never buffers `mdat`), then parses that buffer
synchronously with a plain `DataView` -- this is a deliberate choice, not an oversight: `moov`'s
internal tables can have millions of entries even though `moov` itself is small enough to buffer
in well under 250ms at the project's target scale (the spike parser this module replaces builds a
1.44M-sample, 7-track index in 107ms). Making every table-entry read an awaited `ByteSource` call
would trade that budget for a genericness the module doesn't need. What `ByteSource` *is* for is
guarding against reading more than `moov`'s own size off a (possibly 27GB) file -- see
`CountingByteSource` in `byte-source.ts`, and the "bytesRead" assertions in `build-index.test.ts`.

## Time representation

Every timestamp and duration on a `TrackIndex` (`pts`, `dts`, `duration`, `editOffsetTicks`) is an
integer count of that track's own timescale units (`track.timescale`). **Nothing in this module
stores a float second anywhere.** Conversion happens only at the boundary, via `time.ts`:
`ticksToSeconds`/`secondsToTicks` for a plain timescale, and `localTicksToPresentationSeconds` for
a tick that also needs `editOffsetTicks` subtracted first (see the next section).

The reason is drift, not style: accumulating float seconds across a long timeline (minutes to
hours, thousands to millions of samples) loses precision unevenly, and eventually produces a cut
that's one frame off from what the user asked for. Integer tick arithmetic doesn't have this
problem. If you're adding a new field that represents a moment in time or a span of time, it
belongs in track-timescale ticks, not seconds -- convert only when you're about to show a number
to a user or accept one from a UI control.

## Edit lists, and why `editOffsetTicks` exists

A track's `pts`/`dts` arrays are always in raw, un-adjusted local time. If the track has an
`edts`/`elst` box, `TrackIndex.editOffsetTicks` is the local tick that maps to presentation time
0 -- computed once in `moov/edit-list.ts`'s `computeEditOffset`, in the track's OWN timescale
(edit lists mix the movie timescale and the track timescale, and converting at the wrong point
produces small but real errors -- see that function's doc comment for the specifics). Use
`time.ts`'s `localTicksToPresentationSeconds(pts[i], track.timescale, track.editOffsetTicks)` to
get the presentation second a user or another demuxer would report for sample `i`.

An edit list that isn't exactly one trivial entry (`media_time 0`, full duration, rate 1.0) --
which includes the extremely common AAC-priming-delay pattern -- produces a
`{ kind: 'non-trivial-edit-list' }` warning on the parse result, never a thrown error. This is a
real, frequent case (see `differential-mediabunny.test.ts`: the project's own tiny committed
fixture has one), not an edge case to special-case away.

### Presentation time vs. media time (M1 Task 2, Part 1)

Every method on `SampleIndex` described so far (`frameAtTime`, `timeOfSample`,
`nearestSyncAtOrBefore`, ...) operates on **raw, un-adjusted local ticks** -- exactly what's stored
in `TrackIndex.pts`/`dts`. `<video>.currentTime` and `requestVideoFrameCallback`'s reported
`mediaTime`, by contrast, honor edit lists (the same edit-adjusted convention documented above for
mediabunny's `packet.timestamp`). Calling a raw-tick method with a naive `secondsToTicks(userSeconds)`
-- without adding back `editOffsetTicks` -- silently offsets every seek, keyframe tick, and frame
step by the priming delay: consistently, silently, and by an amount (tens of ms) small enough to
look like a rounding bug for months.

`SampleIndex` therefore also exposes a parallel, presentation-time-native surface --
`frameAtPresentationTime`, `presentationTimeOfSample`, `nearestSyncAtOrBeforePresentation`,
`nextSyncPresentation`, `prevSyncPresentation`, `keyframePresentationTimes` (all in `query.ts`) --
each a thin wrapper that applies `editOffsetTicks` at this boundary. **Playback code must call
these `*Presentation*` methods, never a raw method with `editOffsetTicks` added or subtracted by
hand at the call site.** `TrackIndex.pts`/`dts` themselves are never changed to store adjusted
values -- the remux/export path needs raw media time to reproduce or adjust the `elst` box on
output, so both representations are retained, under unmistakable names.

**Empirical status:** the expected result -- based on `time.ts`'s `localTicksToPresentationSeconds`
already existing specifically to match mediabunny's edit-adjusted `packet.timestamp` convention --
is that a real `<video>` element's `currentTime`/`requestVideoFrameCallback().mediaTime` agrees with
the *presentation*-time (edit-adjusted) methods above by a constant offset, and diverges from the
raw-tick methods by exactly `editOffsetTicks`. This has **not yet been confirmed against a real
`<video>` element** in this environment (no browser available to run it) -- `presentation-time.test.ts`
only checks that the index's own adjustment arithmetic is internally self-consistent, which is a
necessary but not sufficient check. Run `src/media/playback/harness.ts` (via `npm run dev`,
`playback.html`) against a real fixture with an edit list (e.g. the 27GB OBS fixture) to get the
actual delta table, and replace this paragraph with the confirmed finding. If the delta turns out
to vary rather than being constant, stop and treat it as a bug in the index or edit-list
interpretation, per that harness's own logged warning -- do not build further on an unconfirmed
assumption.

## The OPFS cache schema and its versioning contract

`opfs-cache.ts` serializes a parsed index to a single binary blob per file (keyed by
`fingerprint.ts`'s `computeFingerprint`: file size + `lastModified` + a fast, non-cryptographic
hash of the first and last 1MB -- **never** the whole file). The layout is a small JSON metadata
section (everything except the big per-sample arrays: codec strings, video/audio metadata, edit
lists, description bytes) followed by each track's `pts`/`dts`/`offset`/`size`/`isSync` arrays
back to back, each track's section padded to end on an 8-byte boundary so the next track's
`Float64Array`s stay properly aligned (a `Float64Array` view throws if its `byteOffset` isn't a
multiple of 8).

**`SCHEMA_VERSION` (in `opfs-cache.ts`) is a data-integrity control, not housekeeping.** A cached
index that disagrees with what the CURRENT parser would produce -- because a bug was fixed, or a
new field was added to `TrackIndex`, since this cache was written -- is not a performance problem,
it's silent data corruption: wrong byte offsets feeding an export that plays back but is subtly
wrong, with no error anywhere in the chain. `deserializeIndex` refuses to read a blob written at
any other `SCHEMA_VERSION` (see the `stale-schema` result) rather than attempt to interpret it.

**If you change anything about what a `TrackIndex` contains, or how a track's arrays are laid
out, bump `SCHEMA_VERSION`.** There's a regression test for the rejection path
(`opfs-cache.test.ts`) but nothing enforces that a real content change comes with a version bump
-- that's on you, and it's the single most important invariant in this file.

Other outcomes `readIndexCache`/`writeIndexCache` handle explicitly, all without throwing: cache
miss (`{ kind: 'miss' }`), a corrupt blob (`{ kind: 'corrupt', detail }`, falls back to rebuilding
from the source file), and OPFS quota exceeded on write (`{ kind: 'quota-exceeded' }`, proceed
without caching).

## The two differential oracles

Two independent implementations exist to catch what a single implementation's own tests can't:
one implementation's bug rarely produces a matching bug in another.

- **`src/spikes/A-remux/mp4-index.ts`** (the spike parser). Cheap, in-process, no external
  dependency -- runs in every `npm test` (`differential-spike.test.ts`). Its job is catching a
  regression from THIS rewrite specifically: since both parsers read the exact same bytes
  independently, any disagreement on `pts`/`dts`/`offset`/`size`/`isSync` per sample is almost
  certainly a bug in the new code, not the old one. `src/spikes/` must not be modified for this to
  keep working as a real second opinion.
- **`mediabunny`** (pinned in `package.json`), via its `CustomSource` (which maps directly onto
  this module's own `ByteSource` -- no Node shim needed). An entirely independent demuxer,
  catching classes of bug a same-author rewrite might share with the code it's replacing.
  `differential-mediabunny.test.ts` documents three known mediabunny quirks found during Spike B
  (a Chrome memory-ballooning bug in its default `BlobSource` mode, an unbounded full-track
  metadata walk that can crash at scale, and its `packet.timestamp` being edit-list-adjusted) and
  how each is worked around or accounted for in the comparison.

Both run against `__fixtures__/tiny.mp4`, a small real file committed to the repo (unlike
`fixtures/`, which is entirely gitignored -- see `scripts/make-tiny-fixture.sh` to regenerate it).
`differential-vfr.test.ts` runs the same two comparisons against the larger, gitignored
`fixtures/vfr-screen.mp4` when it happens to be present locally, and registers a skipped
placeholder suite (never a failure) when it isn't -- variable sample durations are where `stts`
run-length expansion actually breaks, so that fixture is worth running against by hand.

## What's NOT covered by `npm test`

The manual browser harness (`harness.ts` + `media-index.html`, run via `npm run dev` /
`npm run dev:coi`) is where the 27GB real fixture, real OPFS, and real build-time/retained-bytes
numbers get exercised -- none of those exist in Node. This follows the same convention as every
spike page under `src/spikes/`: run by hand, not part of CI.

## Known build-time delta (spike vs. production), and its explanation

The production parser builds the 27GB fixture's index in 164.7ms; the spike parser it replaces
(`src/spikes/A-remux/mp4-index.ts`) does the same file in 107.1ms, same browser (Chrome). Both are
comfortably under the 250ms budget, so this was never urgent, but this project has twice fitted a
confident story to an unexplained perf delta and been wrong (see git history around Spike A's
export-cost investigation) -- so the delta gets measured, not assumed.

**This still needs an actual profiler run** (Chrome DevTools Performance panel, on
`media-index.html`, comparing against the equivalent spike page) to attribute the ~57.6ms
difference to a specific cause rather than a guess at "production has more validation/error-path
checks." Whoever runs this: record the top few self-time frames from both profiles here, replacing
this paragraph with the actual finding.
