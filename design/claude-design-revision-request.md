# Revision request for Claude Design

Paste the block below into the existing Claude Design conversation.

---

```
This design is close and most of it is landing well — the palette, the preview
dominance, the floating rail panels, the keyboard overlay, and especially the
keyframe-shift popover copy are all right and shouldn't change. Five things need
revising, mostly because the implementation has advanced and some of the mockup's
assumptions no longer match what the product actually does.

1. THE SOURCE FILE IS MP4, NOT MKV

Every screen shows rec_2026-07-18_session-4.mkv, the format chip reads MKV, and the
export panel writes session-4_clip.mkv with container: mkv.

The app can't open MKV. The parser handles MP4/MOV only, Chrome won't preview
Matroska natively, and there's no MKV muxer — so the export panel is describing an
operation that doesn't exist. Change every reference to .mp4 and MP4.

2. FLIP THE FILMSTRIP AND WAVEFORM PROPORTIONS

Right now the waveform is roughly two and a half times the height of the filmstrip,
and the filmstrip is dark enough that frame boundaries are barely visible.

That's backwards. The filmstrip isn't decoration — it's how the app scrubs. Seeking
the video element takes ~280ms, far too slow for a drag, so during a scrub the
preview reads frames directly from the filmstrip cache. It's also the primary way
someone finds a moment in a four-hour recording.

Make the filmstrip the tall, bright, dominant row. Put the waveform beneath it as a
shorter, quieter band. The waveform also arrives in a later milestone, so please
show one variant with the waveform row present and one without it, so the first
release has a design to build against.

3. ADD A KEYFRAME TICK ROW

There's currently no distinct row of keyframe marks. It should sit between the ruler
and the filmstrip — a thin band of vertical ticks, one per keyframe.

This row is the visual explanation for why a cut moved. Without it, the amber "in
moved" pill in the status bar is the user's only clue that anything happened. At
wide zoom it reads as texture; at close zoom individual ticks should read as targets
you could snap to.

4. THE EXPORT AND SOURCE PANELS NEED A TRACK LIST

Both panels currently show a single audio track ("aac 2.0 · 48 kHz"). Real
recordings from OBS have multiple audio tracks — the test file has seven tracks
total: one video and six audio (separate mic, desktop, and application audio).

The export panel needs a track selection control: video plus the first audio track
selected by default, the rest listed and toggleable. Each row should show enough for
someone to tell the mic from the desktop feed — handler name, language, channel
count, duration. Exporting without this either bloats every output with six audio
streams or silently drops the user's microphone.

The source panel should list the tracks too, rather than summarising audio as one
line.

5. INDEXING IS ~120 MILLISECONDS, NOT 41 SECONDS

The jobs panel shows "index done · 41 s". The real measured figure on a 27GB file is
110-165 milliseconds.

This matters beyond accuracy: near-instant indexing of an enormous file is one of
the product's defining properties, and the current mockup implies a long wait that
would need its own loading experience. Show it as done in well under a second.

SMALLER CORRECTIONS

- The keyframe shift is larger than shown. Real recordings have a keyframe roughly
  every 4.2 seconds, not 2. Change "in moved −0.84 s" to "in moved −4.17 s" and the
  popover's "Re-encodes 2 s at the head of the clip" to "~4 s", then check that the
  status-bar pill and popover still sit right — a four-second shift reads as a much
  bigger deal than a sub-second one, and it may want more visual weight.

- The "exact" trim mode ships in a later milestone. Please add a variant of the
  transport bar where the "exact" half of the copy | exact toggle is visibly
  disabled, and a variant of the keyframe-shift popover showing only the explanation
  and Dismiss, without the "Keep exact frame" button.

- The export progress bar currently takes its own row and pushes the preview down,
  which resizes the video and re-letterboxes it mid-session. Either overlay it or
  reserve the row permanently so the preview never changes size.

WHAT I'D LIKE BACK

Updated versions of: the main ready state, a zoomed-in crop of just the timeline
region (most useful for judging the new row proportions and the keyframe ticks), the
export panel with track selection, the source panel with the track list, and the
jobs panel. Plus the two variants noted above — no waveform, and disabled exact mode.
```
