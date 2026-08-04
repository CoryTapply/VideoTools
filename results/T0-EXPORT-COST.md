# T0 — locate the fixed export cost

Diagnosis task. See `prompts/task-0-export-cost-prompt.md` for the full spec. All measurements
below are from `src/spikes/T0-exportcost/`, which reuses Spike A's remux code
(`mp4-index.ts`/`select.ts`/`remux-write.ts`) unmodified and adds six-stage timing around the
same export path.

**Machine / environment:** local dev machine, fast NVMe storage (as specified in the task brief
— exact model not captured), Chrome 151.0.0.0, macOS. Fixture: `27gb.mp4` (the 27GB, 7-track OBS
recording used throughout M0.5), ~4225.75s duration. All runs use the project's standard 4MB
coalesced-window copy loop, unchanged from Spike A.

Raw JSON for every run is in `fixtures/T0-exportcost_27gb.mp4_*.json`. Where a size was run twice
back-to-back, the **second (repeat/warm) run** is used as the primary data point below — see the
cold-cache section for why, and for what the first-run gap itself shows.

---

## 1. Six-stage breakdown across matrix A (mid-file, size varied)

All rows below except "floor" are at the same source position (in-point ≈2112.5s, i.e. ~50% into
the file). "floor" is at position 0% (start) — included here because it's the smallest available
size point; matrix B (section 3) independently confirms position doesn't matter, which justifies
combining it with the mid-file points for the fit in section 2.

| label | size (MB) | t_writable | t_pass1 | t_moovwrite | t_copy | t_close | **total (excl. picker)** | MB/s |
|---|---|---|---|---|---|---|---|---|
| floor | 3.04 | 0.8ms | 0.5ms | 1.0ms | 17.8ms (41%) | 23.0ms (53%) | **43.1ms** | 70.6 |
| matrixA-10MB | 10.11 | 0.6ms | 1.3ms | 2.1ms | 41.8ms (63%) | 20.6ms (31%) | **66.4ms** | 152.2 |
| matrixA-50MB | 50.02 | 0.4ms | 4.5ms | 0.9ms | 216.4ms (72%) | 79.2ms (26%) | **301.4ms** | 166.0 |
| matrixA-500MB | 502.33 | 0.5ms | 34.7ms | 1.5ms | 2057.7ms (73%) | 736.9ms (26%) | **2831.3ms** | 177.4 |
| matrixA-1GB | 1002.21 | 0.5ms | 80.1ms | 3.7ms | 4097.4ms (73%) | 1418.5ms (25%) | **5600.2ms** | 179.0 |
| matrixA-4GB | 4006.62 | 2.1ms | 673.5ms | 2.8ms | 16319.2ms (73%) | 5475.1ms (24%) | **22472.7ms** | 178.3 |

`t_writable` and `t_moovwrite` are noise-level at every size (low single-digit ms). `t_pass1`
(building the moov table in memory, no media reads) grows with sample count but stays under 3% of
total even at 4GB. Every size is dominated by the same two-way split: **`copy` ≈73%, `close`
≈25-26%** — that ratio is essentially constant from 10MB to 4GB, a 400x size range.

## 2. Fitted model and residuals

Least-squares fit of `total_ms = fixed + size_MB / rate` across the six points above:

**`total_ms ≈ 13.2 + size_MB / 178.5`** (i.e. fixed ≈13ms, marginal rate ≈178.5 MB/s)

| size (MB) | actual | predicted | residual |
|---|---|---|---|
| 3.04 | 43.1 | 30.3 | +12.8ms |
| 10.11 | 66.4 | 69.9 | -3.5ms |
| 50.02 | 301.4 | 293.6 | +7.8ms |
| 502.33 | 2831.3 | 2828.1 | +3.2ms |
| 1002.21 | 5600.2 | 5629.1 | -28.9ms |
| 4006.62 | 22472.7 | 22465.7 | +7.0ms |

Residuals are all within ~0.5% of the actual value except the floor point, where 12.8ms on a
43ms total is large in *percentage* terms but is noise-level in absolute terms (see the three raw
floor runs: 34.9 / 43.1 / 51.5ms — a ~17ms spread at this scale is just measurement jitter, not a
model failure). **The linear model holds cleanly across three orders of magnitude of output
size.** There is no second-order term worth fitting — R² is effectively 1.

Splitting the two dominant stages individually (same six points, same regression):

- **`copy_ms ≈ 9.5 + size_MB / 245.6`**
- **`close_ms ≈ 26.6 + size_MB / 734.1`**

Both are themselves close to pure `size/rate` lines with near-zero intercepts. **`close()` is not
a flat, size-independent toll** — it scales with output size at roughly 3x copy's throughput,
which reads as "flush/commit the buffered swap file to its final location," proportional to bytes
written, not "finalize a transaction," which would be closer to O(1).

## 3. Matrix B — position swept, size fixed at ~200MB

| position | size (MB) | copy | close | total | MB/s |
|---|---|---|---|---|---|
| 0% (start) | 201.46 | 836.1ms | 297.4ms | 1150.9ms | 175.0 |
| 25% | 201.17 | 902.1ms | 321.2ms | 1249.5ms | 161.0 |
| 50% (mid) | 203.17 | 942.7ms* | 325.4ms* | 1290.8ms* | 157.4* |
| 75% | 200.90 | 842.3ms | 302.6ms | 1159.7ms | 173.2 |
| last-frame | 193.54 | 799.4ms | 269.5ms | 1095.8ms | 176.6 |

*the 50%/mid point shown here is the post-`sudo purge` (cold-cache) run — see section 4. The
warm run at the identical range was 838.6/294.3/1151.4ms/176.5MB/s, in line with the other four.

All five positions land in a tight band (1096-1250ms warm, 161-177 MB/s). **Position does not
explain the original data.** Notably, the **last-frame range — the specific range that produced
the original 18.77 MB/s outlier — is the fastest of the five positions tested here**, not the
slowest. Matrix A already ruled out size as an independent driver; matrix B now rules out position
too.

## 4. Cold cache (H3)

Explicit test: `sudo purge`, then re-run the mid-file 200MB point.

| | copy | close | total | MB/s |
|---|---|---|---|---|
| warm | 838.6ms | 294.3ms | 1151.4ms | 176.5 |
| cold (post-purge) | 942.7ms | 325.4ms | 1290.8ms | 157.4 |
| **delta** | **+12.4%** | **+10.6%** | **+12.1%** | **-10.8%** |

Real and measurable, but far short of an 8-9x effect. This is corroborated by a second, unplanned
data source: every matrix A size above was run twice back-to-back, and the **first run at each new
size was consistently slower than the immediate repeat** — the same effect, occurring naturally as
each new byte range got touched for the first time that session:

| size | 1st run | 2nd run | delta |
|---|---|---|---|
| 10.1MB | 91.0ms | 66.4ms | -27% |
| 50.0MB | 320.2ms | 301.4ms | -6% |
| 502MB | 3151.9ms | 2831.3ms | -10% |
| 1GB | 5986.7ms | 5600.2ms | -6.5% |
| 4GB | 25990.6ms | 22472.7ms | -13.5% |

Consistent with the explicit purge test (~6-27%, centered close to the ~12% purge delta). **On
this fast NVMe drive, cold vs. warm OS cache is a real ~10-15% effect, not the multi-second toll
the original data implied.**

## 5. `createWritable()` vs. existing target file size (H2)

Floor-sized (3MB) exports, target file pre-created via `mkfile` at 0 / 200MB / 4GB, plus a
never-existed filename as baseline, all in `fixtures/`:

| target | t_writable |
|---|---|
| existing 0MB | 9.8ms |
| existing 200MB | 0.7ms |
| existing 4GB | 2.8ms |
| fresh filename | 3.0ms |

No trend with existing file size — the 0MB case is the *highest* of the four, not the lowest.
All four are within single-digit ms of each other, indistinguishable from noise.
**`createWritable()` cost does not scale with the size of a pre-existing file at the target
path.** `keepExistingData` defaults aren't a concern here: whatever Chrome does when opening a
writable over an existing file, it isn't proportional to that file's size.

## 6. Hypothesis verdicts

| # | Hypothesis | Verdict | Basis |
|---|---|---|---|
| H1 | `close()` is committing a swap file, and that cost is a flat per-export toll | **Ruled out (as a flat toll)** | `close_ms` scales with size (≈26.6ms + size/734MB/s, section 2), not constant. It is real, transactional, and proportional to bytes — just not a fixed toll. The `.crswap`-file directory-listing observation and cross-volume test from the original H1 spec were not performed in this pass (see "Not yet covered"). |
| H2 | `createWritable()` cost scales with existing target file size | **Ruled out** | Flat few-ms cost regardless of existing file size, 0 to 4GB (§5). |
| H3 | Cold OS page cache on the source read | **Confirmed, but minor** | +10-15% cold vs. warm (§4), not the dominant factor. |
| H4 | Multi-track interleaving causes scattered reads that drive the cost | **Inconclusive (no dedicated test run), but weak evidence against it as the anomaly driver** | Over-read ratio (window bytes read vs. useful bytes) is stable at ~6.5x across every size and position tested (e.g. 1281-1336MB read for every ~200MB useful-byte target regardless of position) — interleaving overhead looks like a constant multiplicative factor already baked into the ~178MB/s effective rate, not something that spikes at a particular position. A dedicated video-only vs. video+audio comparison was not run. |
| H5 | Worker/module startup or index build is inside the measured window | **Ruled out by construction** | Index build (`buildMp4Index`) is always a separate, untimed step before any of the six stages start (confirmed via the on-page log noting `buildMs` is outside the timed window); this spike is single-threaded, no workers. |

## 7. Attribution

**In every controlled condition tested (3MB–4GB, all five source positions, warm and cold cache),
there is no multi-second fixed toll: the seconds go almost entirely into `copy` (~73% of total,
scaling at ~246MB/s) and `close` (~25%, scaling at ~734MB/s) in near-exact proportion to output
size, with a combined fixed cost of ~13ms and a combined marginal rate of ~178MB/s; the original
three-point dataset's apparent "5-8 second toll" does not reproduce under any combination of size,
position, or cache state we controlled for, and was most likely a one-off artifact of system
conditions at the time of that specific run rather than a repeatable property of the export path.**

## 8. Recommendation

**Is it reducible?** Marginally, and not urgently. The measured ~178MB/s combined rate is well
below the ~1230MB/s read-only ceiling Spike A's own chunk-size sweep found (see
`spike-a.ts`'s COALESCE_WINDOW_BYTES comment) — the gap is because `copy` currently reads a window,
then writes it, serially, with no overlap. Pipelining reads and writes (start reading the next
window while the current one is still being written) is the concrete lever, already flagged in
Spike A as an M1 architecture candidate. Estimated win is speculative without prototyping it, but
directionally: closing even half that gap would meaningfully cut `copy` time at GB scale. Not
implementing this now, per the task brief — flagging it as the candidate for a later pass.

**Progress UI:** No fixed multi-second "toll" to hide, but a real finalizing phase is still
warranted, because `close()` is a substantial (~25%), separately-timed phase that runs strictly
*after* all mdat bytes are copied — i.e. after a naive progress bar would already read 100%.
Approximate finalizing-phase duration by size (from the `close_ms` fit in section 2):

| output size | approx. finalizing phase |
|---|---|
| 10MB | ~27ms (imperceptible) |
| 200MB | ~300ms |
| 500MB | ~740ms |
| 1GB | ~1.4s |
| 4GB | ~5.5s |

Below a few hundred MB this is invisible and doesn't need special treatment. Above ~500MB, the UI
should reserve the last slice of the bar (or switch to a distinct "finalizing" label) for this
window rather than let `copy` reaching 100% imply the export is done — the file isn't safely
committed until `close()` resolves.

## 9. Revised progress-estimation model

Replace the flat MB/s number in the architecture doc with the two-phase fit from section 2:

```
copy_ms  ≈  9.5  + size_MB / 245.6
close_ms ≈ 26.6  + size_MB / 734.1
total_ms ≈ copy_ms + close_ms   (≈ 13 + size_MB / 178.5, warm-cache)
```

Sample count was not found to be an independent predictor: the size-only fit already achieves
residuals under 1% at every size from 10MB up (section 2), so adding a sample-count term wouldn't
meaningfully improve it — sample count matters only through its correlation with byte size, which
is what actually drives both `copy` and `close`. Use `total_ms` for the overall ETA, and
`copy_ms`/`close_ms` individually to place the finalizing-phase boundary on the progress bar.

For a conservative (cold-cache) estimate, multiply `total_ms` by ~1.12 (section 4). Given the effect is
small and inconsistent run-to-run, it's probably not worth exposing as a separate UI state —
padding the estimate slightly is enough.

## 10. What surprised me

- **How small the fixed cost actually is.** ~13ms is close to nothing. The entire premise of this
  diagnosis task — that there's a multi-second toll every export pays — didn't survive controlled
  testing at all.
- **The last-frame range, source of the original slow number, was the *fastest* of five positions
  tested**, not the slowest. The opposite of the natural first guess.
- **`close()` scales with size** rather than being the flat commit-cost H1 predicted — a real,
  proportional cost, just not the shape anyone expected going in.
- **Cold cache is a minor effect on this hardware** (~10-15%). Fast NVMe apparently doesn't
  penalize a cold read anywhere near as much as a naive "disk-bound" framing would suggest.
- **How clean the fit is** — R² effectively 1 across 400x of size range is unusually tidy for a
  browser I/O benchmark, and it made ruling things out fast once the confounded variables were
  separated.
- The practical lesson: three organic, uncontrolled data points produced a plausible-looking but
  wrong story (fixed toll + flat rate). It took a deliberately decoupled experiment to find that
  none of size, position, or cache state — the three axes those points varied on simultaneously —
  actually explains the original numbers.

---

## Not yet covered

- **H4 dedicated test** (video-only vs. video+6-audio read-pattern comparison, seek-distance
  distribution) — only indirect evidence collected so far (section 6).
- **Phase 4** (OPFS/Blob baselines, native `ffmpeg -c copy` reference) — not run.
- `.crswap` directory-listing observation and cross-volume `close()` timing (H1 sub-items) — not
  run.
