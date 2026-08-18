/**
 * Presentation ticks in the audio track's OWN timescale (not the video track's) -- this module
 * has no notion of a video track at all. A caller bridging this to the timeline's video-track-tick
 * `Time` (src/media/frames/types.ts's own local redefinition of the same alias) is that caller's
 * job, not this module's -- exactly the boundary src/media/frames/README.md's "What's out of
 * scope here" draws around canvas integration.
 */
export type Time = number;

/** One output column for a waveform repaint: per-channel min/max envelope at a specific time. */
export interface PeakColumn {
  readonly time: Time;
  readonly channels: readonly { readonly min: number; readonly max: number }[];
}
