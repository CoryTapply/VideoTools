# Seek promise semantics: current behavior (Option A) and the path to Option B

`PlaybackEngine.seek()` returns `Promise<void>`. Under seek coalescing (see
`NativeVideoEngine.ts` and `README.md`'s coalescing section), a caller's requested
target can be superseded by a newer `seek()` call before it ever reaches the video
element. This document covers what a superseded call's promise does, why, and what
switching to the alternative would cost -- written so a future decision to switch is a
known-size change, not a re-design.

## Current behavior: Option A

**Every `seek()` call's promise resolves together, at the moment the engine reaches a
fully-settled state** -- no pending target, no seek in flight -- regardless of whether
that particular call's target was the one that actually landed.

```
seek(A) -> promiseA
seek(B) -> promiseB   // supersedes A before A ever reaches the video element
seek(C) -> promiseC   // supersedes B

// engine eventually lands on C and goes idle
// promiseA, promiseB, promiseC ALL resolve at that same instant
```

**Caller-facing caveat: a resolved promise does NOT mean your exact requested target
was reached.** It means "the engine finished processing the burst of seeks your call
was part of." A caller that does `await engine.seek(A); assumeWeAreAtA()` is wrong to
make that assumption whenever more than one seek is in flight at a time (e.g. fast
drag input -- see `README.md`'s note that a burst of ~13 requests per completed seek is
the expected shape at 60Hz drag input against this project's measured ~220ms seek
latency).

This is the simpler implementation (one flat waiter list, flushed on settle) and
matches the "convergence" property the task asks to test hardest
(`NativeVideoEngine.seek-coalescing.test.ts`).

## Switch criteria: when Option B would earn its cost

Move to Option B (below) only if one of these becomes true -- absent one of them,
there's no reason to switch:

- **A caller needs to cancel per-request work the instant its own request is known
  stale**, rather than waiting for an entire drag gesture to finish -- e.g. a
  drag-scrub UI that schedules a thumbnail render or canvas redraw per pointermove and
  wants to abort that work as soon as a newer seek supersedes it, not when the whole
  burst settles.
- **Telemetry wants a "requests superseded vs. landed" count**, which Option A's
  batch-resolve can't distinguish (every call in a burst looks identical from the
  caller's side).
- **Caller code is found assuming `await engine.seek(t)` implies
  `engine.currentTime === t`** -- if this assumption creeps into the codebase and
  causes a real bug, that's a sign the caller-facing contract needs to be more
  precise than Option A provides.

## Option B: what it would look like

**Each call's promise resolves as soon as *that specific call* is known superseded**,
decoupled from when the video element actually finishes settling:

```
seek(A) -> promiseA
seek(B) -> promiseB   // the moment B is issued, promiseA resolves right away (A is dead)

// ... video is still seeking toward B/C ...
seek(C) -> promiseC   // promiseB resolves right away too (B is now dead)

// only promiseC waits for the real 'seeked' event and resolves when the video lands on C
```

## Implementation delta for the switch

Confined entirely to `NativeVideoEngine`'s internal seek-coalescing waiter bookkeeping.
**No change to:**

- `seek()`'s public signature (`Promise<void>` either way).
- `VideoElementLike` / `FakeVideoElement`.
- The coalescing state machine itself (`pendingSeekTarget` / `seekInFlight` /
  overwrite-and-reissue logic) or the convergence property it guarantees.

**What changes:**

1. Replace the flat `seekSettleWaiters: Array<() => void>` with a tagged list:
   `Array<{ forTarget: Time; resolve: () => void }>`.
2. In `seek()`, when a new request overwrites `pendingSeekTarget`, walk the existing
   waiter list and immediately resolve+remove any waiter whose `forTarget` no longer
   matches the new target -- those calls are now stale. The waiter(s) tied to whatever
   target actually survives to settle still resolve from `handleSeeked`'s settle
   branch, exactly as today.
3. Update `NativeVideoEngine.seek-coalescing.test.ts`: the 200-seek convergence test's
   *position* assertion (`engine.currentTime` equals the last requested target) is
   unaffected either way -- that's the coalescing state machine, not promise timing.
   What needs rewriting is any assertion that currently treats "all N promises resolve
   together" as correct; under Option B those assertions become "superseded calls'
   promises resolve promptly (before the burst settles), only the surviving call's
   promise waits for the real `'seeked'` event."

Estimated size: ~10-15 lines in `seek()` + `handleSeeked()`, plus the test rewrite
described above. Low risk, well isolated, no public API change.
