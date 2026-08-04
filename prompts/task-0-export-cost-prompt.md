# M1 Task 0 — locate the fixed export cost

A diagnosis task, not a build task. Two days. Blocking the export UX design.

**Why it matters:** the three M0.5 export measurements fit `time = fixed + size / rate` with a constant of roughly 5–8 seconds and a flat marginal rate of ~160 MB/s. If that's right, throughput isn't scaling with size at all — every export pays a fixed toll, and short trims (the primary use case) pay it almost entirely. Pass-1 moov build is only 24 ms at small sizes, so the time is somewhere else.

**Critical confound:** the three existing data points differ in *three* ways at once — output size, position in the source file, and sample count. Near-start 1.15 GB, mid-file 10.39 GB, last-frame 166 MB. Any of the three could be driving the difference. The experiment has to decouple them.

---

```
Context: I'm building a browser video trimmer. Spike A produced a working MP4 remux
that streams output to disk via showSaveFilePicker + createWritable. Three export
runs measured 18.77 MB/s (166MB, last-frame range), 91-92 MB/s (1.15GB, near-start),
and 134.9-163.0 MB/s (10.39GB, mid-file).

Those were read as "throughput scales with size." Fitting them to
time = fixed + size/rate instead gives a constant of ~5-8 seconds plus a flat
marginal rate of ~160 MB/s. If that's correct, every export pays a fixed toll and
short trims — which are this product's main use case — pay almost nothing but toll.

I need to know where those seconds go before I design the export progress UI.
This is a DIAGNOSIS task. Do not optimise or refactor the export path yet. Measure
first, attribute the time, then recommend. I want to see the numbers before any fix.

Work in src/spikes/T0-exportcost/, reusing spike A's remux code as-is.

=== PHASE 1: the floor ===

The single most informative measurement. Export the smallest possible valid output —
one keyframe-aligned GOP, a few MB — and time every stage separately:

  t_picker      showSaveFilePicker() call to handle returned
  t_writable    handle.createWritable() to stream ready
  t_pass1       moov table computation (metadata only, no media bytes)
  t_moovwrite   writing the moov
  t_copy        the mdat copying loop, start to last write() resolving
  t_close       writable.close() to promise resolved

If the fixed cost is real, one of these will hold most of it at a size where the
copy loop is nearly free. Report all six as absolute ms and as a percentage.

IMPORTANT: start the clock AFTER the picker returns for the main measurement, and
report t_picker separately. Human interaction time must not be inside the number.

=== PHASE 2: decouple size from position ===

Run a matrix, 3 repetitions each, report median and spread:

  A. Position fixed at mid-file, size varied:
     10MB, 50MB, 200MB, 500MB, 1GB, 4GB
  B. Size fixed at 200MB, position varied:
     0-5%, 25%, 50%, 75%, and the final range ending at the last frame

For every run report the same six-stage breakdown from phase 1, plus total wall time
and effective MB/s.

From matrix A, fit time = fixed + size/rate by least squares and report both
coefficients with the residuals. State plainly whether the linear model fits or
whether something non-linear is happening.

From matrix B, state whether position in the source file affects export time at
constant size. If the last-frame range is an outlier, say so and investigate why —
that range is where the original 18.77 MB/s number came from.

=== PHASE 3: test specific hypotheses ===

H1 — close() is committing a swap file.
  Chrome's FileSystemWritableFileStream is transactional (confirmed: aborting leaves
  a 0-byte file, not a truncated one), which implies a temp file plus an atomic move.
  - Time close() separately at every size in matrix A. Does it scale with output
    size, or is it constant?
  - While an export is running, list the target directory and look for a .crswap
    file. Report its name, whether its size grows during the write, and when it
    disappears. This is direct observable evidence for or against the swap model.
  - Test whether the target directory being on a different volume from the source
    changes close() time.

H2 — createWritable() is doing work up front.
  Time it against a fresh filename versus an existing file of each of: 0 bytes,
  200MB, 4GB. If createWritable() cost scales with the size of the file already at
  that path, that's the answer, and keepExistingData defaults matter.

H3 — cold OS page cache on the source read.
  Run matrix A twice back to back without dropping caches (warm), then again after
  `sudo purge` on macOS (cold). Report the delta. If the fixed cost vanishes when
  warm, it's read-side, not write-side.

H4 — multi-track interleaving is causing scattered reads.
  The 27GB fixture has 7 tracks. A 200MB export may require alternating reads across
  7 separate regions of the file. Instrument the copy loop: count read() calls,
  total bytes read, mean read size, and the distribution of seek distances between
  consecutive reads. Compare a video-only export against a video-plus-6-audio export
  of the same duration. If interleaving is the driver, this shows up immediately.

H5 — worker or module startup is inside the window.
  Confirm whether worker spin-up, WASM/module loading, or index build is being
  counted. If any of it is, exclude it and re-report.

=== PHASE 4: comparison baselines ===

Write the same byte volume three ways and compare total time, to isolate whether the
cost is specific to the File System Access API:
  - showSaveFilePicker + createWritable (the current path)
  - OPFS via createSyncAccessHandle in a Worker
  - an in-memory Blob plus an anchor download (small sizes only)

Also run `ffmpeg -ss X -to Y -i input -c copy out.mp4` on the same ranges and report
its wall time as a native reference floor. I want to know how much of the gap is
browser overhead versus inherent I/O cost.

=== DELIVERABLE ===

Write results/T0-EXPORT-COST.md containing:

1. The six-stage breakdown table across all matrix A sizes.
2. The fitted fixed cost and marginal rate, with residuals, and a plain statement of
   whether the linear model holds.
3. A verdict on each hypothesis: confirmed, ruled out, or inconclusive with reason.
4. An attribution: where the seconds actually go, in one sentence.
5. A recommendation split into two parts:
   - Is it reducible? If so, how, and what's the estimated win. Do not implement yet.
   - If it is not reducible, what the progress UI must do about it. Specifically:
     does the export need an explicit "finalising" phase so the last seconds aren't
     a bar frozen at 99%, and roughly how long is that phase at each output size.
6. A revised progress-estimation model to replace the flat MB/s number currently in
   the architecture doc: given output size and sample count, predicted duration.
7. Anything that surprised you.

All measurements on the 27GB OBS fixture in Chrome. Do not chase Safari or Firefox.
Report the machine and storage type with the results, since these numbers are
disk-bound and this is a fast NVMe machine.

Do not fix anything in this task. If you find an obvious win, write it down as a
recommendation and stop.
```

---

## What a good outcome looks like

- **If it's `close()`:** likely irreducible via the FSA API. The fix is UX — an explicit finalising phase, and possibly starting the export optimistically before the user confirms the destination.
- **If it's `createWritable()` on an existing file:** reducible immediately by writing to a temp name and renaming, which you want anyway for the overwrite-on-abort hazard.
- **If it's read-side (H3/H4):** reducible by better read scheduling — batching per-track region reads rather than strictly interleaving, or reading ahead across track boundaries.
- **If it's worker startup (H5):** it isn't a real cost at all, just a measurement artefact, and the export is faster than you thought.

Any of those four is a good day. The bad outcome is "inconclusive," which is why phase 1 exists — the floor measurement alone should localise it even if nothing else does.
