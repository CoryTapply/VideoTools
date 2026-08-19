// Pure reconciliation: given the currently-live mixers and the newly-desired set of enabled real
// track ids, decides which mixers to dispose, which to create, and which to leave untouched --
// mirroring src/media/waveform/job-builder.ts's "pure descriptor-building, no side effects beyond
// what's explicitly returned/invoked" style. Never rebuilds a mixer that's already enabled just
// because a DIFFERENT track's checkbox changed -- current.get(id) is reused as-is whenever
// enabled.has(id), so toggling track B doesn't touch track A's already-decoding mixer.

import type { LiveAudioMixerLike } from './LiveAudioMixerLike';

export interface PlaybackSnapshot {
  readonly playing: boolean;
  readonly atSeconds: number;
}

export function reconcileEnabledTracks(
  current: ReadonlyMap<number, LiveAudioMixerLike>,
  enabled: ReadonlySet<number>,
  createMixer: (trackId: number) => LiveAudioMixerLike,
  playback: PlaybackSnapshot,
): Map<number, LiveAudioMixerLike> {
  const next = new Map<number, LiveAudioMixerLike>();

  for (const [trackId, mixer] of current) {
    if (enabled.has(trackId)) {
      next.set(trackId, mixer);
    } else {
      mixer.dispose();
    }
  }

  for (const trackId of enabled) {
    if (next.has(trackId)) continue;
    const mixer = createMixer(trackId);
    next.set(trackId, mixer);
    if (playback.playing) void mixer.start(playback.atSeconds);
  }

  return next;
}
