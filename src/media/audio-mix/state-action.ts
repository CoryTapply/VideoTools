// What AudioMixEngine should do to every currently-enabled mixer when NativeVideoEngine's
// PlaybackState changes. Extracted as its own tiny pure function -- not inlined into
// AudioMixEngine.onEngineStateChange -- specifically so 'seeking' -> 'none' has a standing
// regression test: NativeVideoEngine's state machine goes playing -> seeking -> playing for ANY
// accurate seek issued while already playing (seek-to-timecode, jump-to-keyframe, drag-scrub
// release -- see src/ui/timeline/TimelineController.ts's commitHandleDrag), and naively mapping
// "leaving playing" to mixer.pause() would stop audio immediately on every one of those, defeating
// LiveAudioMixer's pendingCutover no-audible-gap mechanism (see that file's own header comment).
// Only reportMasterPosition()'s existing drift correction -- which already fires on every onFrame
// tick, including the synchronous one at seek-settle -- needs to react to a seek; the state
// transition itself must be a no-op.

import type { PlaybackState } from '../playback/PlaybackEngine';

export type MixerAction = 'start' | 'pause' | 'none';

export function mixerActionForStateChange(state: PlaybackState): MixerAction {
  switch (state) {
    case 'playing':
      return 'start';
    case 'ready':
    case 'ended':
    case 'error':
      return 'pause';
    case 'seeking':
    case 'loading':
    case 'idle':
      return 'none';
  }
}
