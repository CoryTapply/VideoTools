# M3.5 — per-track volume export

Bakes the per-track preview volume sliders (shipped in `src/ui/panels/TrackList.tsx` /
`src/media/audio-mix/`) into the actual exported file. Scoped in `roadmap.md`'s M3.5 section —
read that first, especially the scope-boundary conflict it flags.

**Do not hand this prompt to an agent yet.** `roadmap.md` explicitly calls out that this milestone
conflicts with the project's own firm scope boundary ("transcoding as a product feature" is listed
as not-to-be-relitigated-without-new-information in the "Scope boundaries" section). Get an
explicit go-ahead on that first — either accepting the exception or deciding to look for a
non-transcoding way to hit the same goal. This prompt assumes the former (transcoding is approved)
and was written before that conversation happened.

---

```
Context: I'm building a browser video trimmer for 20GB+ local files. Track selection,
trim, and stream-copy export already ship (M1 task 5, src/media/export/). Per-track
preview volume sliders also ship (M2 follow-up): TrackList.tsx renders a slider per
audio track, 1x (unity) at the midpoint, up to MAX_TRACK_VOLUME (2x/200%) at the right
edge; AppState.trackVol holds the values; AudioMixEngine.setTrackVolume/
LiveAudioMixer.setVolume apply them live via a per-track Web Audio GainNode. This is
explicitly preview-only today -- app-state.ts's TrackVolume doc comment and
use-audio-mix.ts both say so, and export never touches it.

This task changes that: bake each track's chosen volume into the actual exported file,
so the adjustment survives outside this app (VLC, QuickTime, re-uploading elsewhere).

THE CORE DIFFICULTY: src/media/export/ is currently pure stream-copy. Its own README
says outright "No decode/encode anywhere in this module" -- raw sample bytes are copied
byte-for-byte from source to output (RemuxStrategy.ts, moov-builder.ts, schedule.ts,
copy-loop.ts), with only duration fields byte-patched. No AudioEncoder exists ANYWHERE
in this codebase yet. AudioDecoder exists only in the live-preview path
(LiveAudioMixer.ts, via src/media/waveform/RealWaveformDecoder.ts), decoding into a
real-time Web Audio playback graph -- not into offline PCM meant for re-encoding. Treat
RealWaveformDecoder.ts as a reference for the decode side (it already carries the
hard-won defensive patterns: timeout-raced flush(), error() rejecting every pending
output, leak-safe AudioData closing via src/media/frames/frame-lifecycle.ts's
withFrame), not as something to import into the export path as-is -- it's tuned for
windowed real-time decode, not a single full-track offline pass.

Same production rules as every other module here: strict TypeScript, real module
boundaries (a testability seam mirroring ByteSource/VideoElementLike/
LiveAudioMixerLike for whatever this task's own encoder/decoder wrapper turns out to
be), tests that run in Node, errors as values, no raw VideoFrame/AudioData escaping the
function that creates it (frame-lifecycle.ts's rule applies here too -- audio decode
leaks are the same silent-linear-growth failure mode as video). Do not modify
src/spikes/.

=== PART 0: resolve the scope-boundary conflict first ===

roadmap.md's "Scope boundaries" section lists "transcoding as a product feature" as
firmly out, not to be relitigated without new information. M3.5's own section names
this conflict explicitly. Confirm with the project owner that this exception is
approved BEFORE writing implementation code -- this prompt existing is not itself that
approval.

=== PART 1: decide the re-encode strategy ===

Two options, and this task should pick one deliberately rather than default into it:

  (a) Re-encode to the SAME codec/profile as the source track (e.g. AAC-LC stays
      AAC-LC). Preserves output track properties, but requires matching the source's
      exact encoder parameters closely enough that AudioEncoder.configure() accepts
      them and playback compatibility isn't degraded.
  (b) Transcode every gain-adjusted track to one fixed target codec/bitrate regardless
      of source. Simpler to implement and reason about, but changes the output track's
      properties from the original even when the source was already that codec.

Only tracks with a non-unity volume need this path at all -- video and any audio track
left at exactly 1x should stay on the existing fast remux path untouched. This means
RemuxStrategy.ts needs to run two parallel per-track pipelines (byte-copy vs.
decode-scale-encode), not replace its one uniform pipeline.

=== PART 2: the decode -> scale -> encode pipeline ===

Per gain-adjusted track, for the full selected export range (not a live-playback
window like LiveAudioMixer's WINDOW_SECONDS):

  - Decode via AudioDecoder to PCM (AudioData -> Float32Array per channel), reusing
    RealWaveformDecoder.ts's defensive patterns as a reference, not its windowed
    scheduling.
  - Scale every sample by the track's stored gain (AppState.trackVol, already
    validated/clamped to [0, MAX_TRACK_VOLUME] by the 'track-volume/set' reducer
    case in app-state.ts). Watch for clipping at the upper end of that range (2x can
    push a sample past [-1, 1]) -- decide whether to hard-clip, soft-limit, or leave
    it to the encoder, and say which and why.
  - Re-encode via AudioEncoder per Part 1's chosen strategy.
  - Frame-lifecycle discipline throughout: every AudioData closed in the function that
    created it, no exceptions, including on the error and cancellation paths -- the
    video frame-leak lesson (src/media/frames/frame-lifecycle.ts's header comment)
    applies identically here and is just as silent if violated.

=== PART 3: the new muxer path ===

The existing moov-builder.ts/schedule.ts/copy-loop.ts all assume sample bytes are
copied untouched -- same size, same byte offset, only duration fields patched.
Re-encoded audio will have different sample sizes and counts than the source (a
different codec, or even the same codec re-encoded, rarely produces byte-identical
framing). This needs genuinely new stbl/mdat construction for the re-encoded track(s),
built and merged alongside the existing byte-copy path's output for every untouched
track -- not a patch to the existing box-rewriting logic.

=== PART 4: AV sync ===

Export currently guarantees sync by construction: it never touches timing, only copies
bytes. Once audio is decoded and re-encoded, encoder latency/padding and frame
timestamp alignment become real risks for the first time in this pipeline. Verify sync
is preserved end to end, not just that the file is structurally valid.

=== PART 5: testing and real-file verification ===

  - Differential test: export a synthetic multi-track fixture with one track at 1x and
    one at a non-unity gain, reparse the result through the production parser
    (mirroring Task 5's own real differential round-trip test), and confirm: untouched
    track's samples are byte-identical to the source; adjusted track's samples decode
    to the expected scaled amplitude (within reasonable re-encode tolerance).
  - Real-browser, real-file verification is not optional here, per this project's own
    established pattern (feedback_real_browser_verification_loop in project memory):
    export a real multi-track file with a real volume adjustment, play the result in
    VLC/QuickTime/Chrome, and confirm the adjusted track is audibly different and
    still in sync. Automated tests alone have not been sufficient for AV-sync work
    on this project before (waveform pipeline, live audio-mix, and the HW-decode
    flush fix all needed real-browser sessions to catch what Node tests couldn't).

=== DO NOT BUILD ===

  - Anything to do with the live preview's own volume sliders/gain graph -- that
    already ships and is out of scope here.
  - Video re-encoding of any kind -- that's M3 (smart render)'s job, entirely
    separate, and this task must not touch src/media/export/'s video path beyond
    what's needed to run it alongside the new audio path.
  - Mute/solo, or any UI beyond what's needed to reflect "this export will re-encode
    N adjusted tracks" (if anything) -- not asked for.
  - A general-purpose audio transcoding utility -- this serves exactly one purpose
    (bake a stored gain into an exported track), don't build past that.

=== DELIVERABLE ===

Export produces a file whose gain-adjusted tracks are actually altered in the output
bytes, verified two ways: a Node differential test against a synthetic fixture, and a
real multi-track file's real playback in at least one real player showing the
adjustment audibly present and in sync. A short README section (mirroring
src/media/export/README.md's existing style) documenting the re-encode strategy
chosen in Part 1 and why, and the clipping decision from Part 2.
```
