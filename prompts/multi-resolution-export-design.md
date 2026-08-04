# Design exploration: multi-resolution export

Follow-on to the video trimmer brief. Same product, same visual system, same dark dense aesthetic. This explores one new capability and I want to see options before committing.

---

## The capability

Today the app trims a clip at full resolution using a stream copy — no decoding, no re-encoding, done in about a second regardless of file size.

I want to add downscaled variants: take the trim and also produce 1440p and 1080p versions for sharing online.

## The constraint that shapes everything

**These two operations are wildly different in cost and the UI must not hide that.**

| | Full-resolution trim | Downscaled variant |
|---|---|---|
| Work | copies bytes | decodes and re-encodes every frame |
| 5-min 4K60 clip | ~1 second | 45 seconds to 3 minutes |
| Quality | lossless | one generation loss |
| Predictability | exact | estimated |

If both sit behind a button labelled "Export" with identical weight, the product feels broken — sometimes instant, sometimes a three-minute wait, with no way to tell which you're about to get. Making that difference legible *before the user commits* is the core design problem here.

## Facts that constrain the UI

- Audio is always copied, never re-encoded. Only video is downscaled. Don't offer audio quality controls.
- Producing three resolutions costs barely more than one, because the expensive decode happens once and fans out. So multi-select should feel cheap, and the UI should say so.
- Multiple outputs go into a **folder chosen once**, not one save dialog per file. Design for a directory picker plus a filename template.
- The real user goal is usually "fits under a platform's upload limit," not "is 8 Mbps." Size targets are more useful than bitrate sliders.
- HDR sources can't be downscaled to SDR without tone mapping. Some files will need a warning or a refusal.
- Encodes take minutes and must not block the app. The user should keep scrubbing and setting new trim points while one renders.

---

## Four flows to explore

Design all four as distinct concepts. I want to compare them, not receive a merged compromise.

### Flow A — Variant checklist in the export dialog

One dialog, opened by the existing Export button. A list of output variants, each a row with a checkbox:

```
☑ Original          3840×2160   copy        ~2.1 GB    instant
☑ 1440p             2560×1440   re-encode   ~640 MB    ~1 min
☐ 1080p             1920×1080   re-encode   ~310 MB    ~50 s
```

Each row shows dimensions, whether it's a copy or a re-encode, estimated size, and estimated time. A footer shows combined totals and a single destination-folder chooser.

*Explore:* how the "copy vs re-encode" distinction reads at a glance. How totals update as rows toggle. Whether time estimates should be per-row or only combined.

### Flow B — Export first, offer conversion after

The user's own instinct, and it keeps the fast path uncontaminated.

Export produces the full-resolution file immediately — one second, done. The success toast then offers a follow-up: "Make a shareable version". That opens a lightweight conversion panel operating on the file just written.

*Explore:* the success toast carrying a secondary action without becoming cluttered. What the conversion panel looks like when it's a distinct, later step rather than a checkbox. How to make the offer feel available rather than nagging — it should be dismissible and re-reachable from the job queue.

### Flow C — Render queue

The rail's job-queue icon becomes a real panel. Variants are added to a queue and render in the background while the user keeps working.

```
● 1440p  clip_1440p.mp4    ████████░░  74%   1:12 left   ✕
○ 1080p  clip_1080p.mp4    queued                        ✕
✓ 2160p  clip_2160p.mp4    done  2.1 GB           Show ▸
```

*Explore:* the panel as a pinned dock versus a floating popover. How an active render is represented when the panel is closed — a badge on the rail icon, a slim bar under the top bar, or something else. How completed items are cleared.

### Flow D — Share targets instead of resolutions

Reframe the whole thing around destination rather than pixel count:

```
Discord      under 25 MB     720p, size-targeted
Slack        under 1 GB      1080p
YouTube      no limit        1440p, high bitrate
Custom       ...
```

Each preset resolves to a resolution, bitrate mode, and size cap. The user picks where it's going, not what encoder settings to use.

*Explore:* whether this can layer on top of A rather than replacing it — presets as a top row, manual resolutions below. How to show that a size target was met or missed after the render.

---

## Details to get right in whichever flow

**Time and size estimates are the whole game.** Show them before the user commits, and show them as ranges or approximations rather than false precision. `~1 min` and `~640 MB`, never `1:04` and `638.2 MB`.

**Never let a re-encode look like a copy.** Whatever visual device you choose — an icon, a colour, a label — it should be immediately obvious which rows are instant and which are minutes.

**Rendering must not block the app.** No modal progress dialog. The user keeps scrubbing, keeps setting in and out points, possibly queues a second trim while the first renders.

**Cancel is always one click** and should say what happens to the partial file.

**Quality confidence.** Somewhere, offer a before/after look at a single frame at the current playhead — source on one side, target settings on the other. Users have no other way to judge whether 1080p at the chosen bitrate is acceptable before waiting three minutes.

**HDR warning state.** A source with HDR transfer characteristics needs an inline notice on the variant rows: colours will shift when converting to SDR, with the option to proceed or cancel. Design this as a row-level warning, not a blocking modal.

**Filename template.** Multiple outputs need names. Show the pattern and let it be edited: `{name}_{height}p.mp4` → `session_recording_0417_1080p.mp4`.

**Non-16:9 sources.** Presets are defined by height with aspect preserved, so a 3440×1440 ultrawide "1080p" is 2580×1080. Show the computed output dimensions on every row rather than just the preset label — the label alone will mislead.

---

## States to cover

| State | Notes |
|---|---|
| Dialog with estimates, nothing selected yet | The default and most-seen state |
| One copy variant selected | Should feel instant and low-stakes |
| Multiple re-encode variants selected | Show that they render concurrently, not serially — the total is not the sum |
| Rendering in progress, app still interactive | The most important state to get right |
| One variant done, others still running | Mixed-state queue |
| Render failed | Encoder unavailable or unsupported source — needs an actionable message |
| HDR source detected | Row-level warning |
| Size target missed | The Discord preset produced a 31 MB file; say so plainly and offer a retry at lower quality |

---

## What I want back

Four distinct concepts, not a blend. For each, the main state plus whatever secondary state best demonstrates its idea. Then a short note on which you'd ship and why — I'm particularly interested in whether the two-step flow (B) is worth the extra click for how much clearer it makes the fast path.
