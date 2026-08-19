// Phase 1 of the live per-track audio preview feature (see the plan doc for the full context):
// plays ONE audio track through a real Web Audio graph, decoded independently via AudioDecoder,
// kept in sync with an external "master clock" the caller drives (a real <video> element in the
// harness; NativeVideoEngine in a later phase -- this class has no dependency on either).
//
// Reuses src/media/waveform/RealWaveformDecoder.ts verbatim rather than writing a near-duplicate
// AudioDecoder wrapper: it already carries the hard-won defensive pattern (timeout-raced flush(),
// error() rejecting every pending output, leak-safe AudioData closing via frame-lifecycle.ts's
// withFrame) this module would otherwise have to re-derive. Its DecodedAudioChunk.timestamp isn't
// exposed at all -- this class doesn't need it, since it already knows each window's file position
// from its own bookkeeping (buildWindowJobs), not from decoded-chunk metadata.
//
// PCM delivery is scheduled AudioBufferSourceNode chunks, not an AudioWorklet: decode a short
// window ahead of the current position into one AudioBuffer, .start() it at a precise
// audioContext.currentTime, and keep topping up while playing. Simpler than a worklet (no ring
// buffer, no SharedArrayBuffer/crossOriginIsolated requirement -- this project's COOP/COEP headers
// are opt-in via `npm run dev:coi`, not on by default), and enough to validate the mechanism.
//
// Every start()/seek() reconfigures the decoder from scratch -- the conservative choice given
// "does AudioDecoder handle a non-contiguous decode restart cleanly" is exactly the unverified risk
// this phase exists to test; the natural forward-refill loop between seeks reuses the same
// configured decoder instance, since those windows genuinely are contiguous.

import { createFrameLifecycleRegistry, type FrameLifecycleRegistry } from '../frames/frame-lifecycle';
import { extractAudioSpecificConfig } from '../index/moov/stbl/stsd';
import { RealWaveformDecoder } from '../waveform/RealWaveformDecoder';
import { formatWaveformDecodeError, type DecodeAudioJob, type DecodedAudioChunk, type WaveformDecoder, type WaveformDecoderConfig } from '../waveform/WaveformDecoder';
import type { LiveAudioMixerLike } from './LiveAudioMixerLike';
import { buildWindowJobs } from './window-jobs';
import type { SampleIndex } from '../index/query';
import type { TrackIndex } from '../index/track-index';

/** Length of each decode-and-schedule window, in seconds. A starting point, not tuned yet -- see
 * the plan's real-browser verification section. */
const WINDOW_SECONDS = 1.5;

/** Stop decoding further ahead once this many seconds of audio are already scheduled -- the
 * "decode near the playhead" bound that keeps memory from growing unboundedly (the VideoFrame-leak
 * lesson in src/media/frames/frame-lifecycle.ts's header comment applies just as much to
 * AudioData/AudioBuffers held here). */
const LOOKAHEAD_SECONDS = 4.5;

/** How often the fill loop re-checks the lookahead bound while it's already full. */
const FILL_POLL_MS = 200;

/** Resync threshold for reportMasterPosition() -- a starting point to tune from real testing. */
const DRIFT_THRESHOLD_SECONDS = 0.08;

interface ScheduledChunk {
  readonly node: AudioBufferSourceNode;
  readonly fileStart: number;
  readonly ctxStart: number;
  readonly duration: number;
}

export interface LiveAudioMixerOptions {
  readonly file: File;
  readonly index: SampleIndex;
  readonly track: TrackIndex;
  /** Shared across every LiveAudioMixer mixing into the same output -- multiple independent
   * AudioContexts can't be mixed together, so Phase 2's multi-track case requires the owner
   * (AudioMixEngine) to construct one AudioContext and hand it to every track's mixer. This
   * instance never constructs or closes its own -- see dispose()'s doc comment. */
  readonly ctx: AudioContext;
  /** Where this track's own GainNode connects to -- typically a shared master GainNode the owner
   * also controls (for the global preview volume/mute), not ctx.destination directly. */
  readonly destination: AudioNode;
  readonly onError?: (message: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LiveAudioMixer implements LiveAudioMixerLike {
  private readonly file: File;
  private readonly index: SampleIndex;
  private readonly track: TrackIndex;
  private readonly decoderConfig: WaveformDecoderConfig;
  private readonly onError: (message: string) => void;

  readonly ctx: AudioContext;
  readonly gain: GainNode;
  readonly registry: FrameLifecycleRegistry;
  private readonly decoder: WaveformDecoder;

  private scheduled: ScheduledChunk[] = [];
  private nextScheduleAt = 0;
  private nextWindowStart = 0;
  /** True from start()/seek() until the first freshly-decoded window for that call actually gets
   * scheduled -- see fillNextWindow()'s doc comment for why the old audio isn't stopped until
   * then, and reportMasterPosition()'s for why drift-checking is suppressed while this is true. */
  private pendingCutover = false;
  private playing = false;
  private generation = 0;
  private disposed = false;

  constructor(opts: LiveAudioMixerOptions) {
    if (!opts.track.audio) throw new Error(`LiveAudioMixer: track ${String(opts.track.trackId)} has no audio metadata`);
    this.file = opts.file;
    this.index = opts.index;
    this.track = opts.track;
    this.onError = opts.onError ?? (() => undefined);
    this.decoderConfig = {
      codec: opts.track.codec,
      sampleRate: opts.track.audio.sampleRate,
      numberOfChannels: opts.track.audio.channelCount,
      description: extractAudioSpecificConfig(opts.track.description),
    };

    this.ctx = opts.ctx;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1;
    this.gain.connect(opts.destination);
    this.registry = createFrameLifecycleRegistry();
    this.decoder = new RealWaveformDecoder(this.registry);

    // Started exactly ONCE, for this instance's whole lifetime -- not re-spawned per start()/
    // seek() call. An earlier version spawned a new loop invocation per call, guarded by a shared
    // "already running" flag; if a seek arrived before the OLD loop had a turn on the event loop to
    // notice its generation was stale, the new loop's launch attempt saw the flag still held and
    // silently no-op'd, permanently orphaning that seek (observed: audio kept playing the pre-seek
    // position for a few seconds -- whatever was already buffered -- then went silent forever, with
    // nothing left to drive it). A single persistent loop that re-reads playing/pendingCutover/
    // generation fresh every iteration has nothing to race against.
    void this.runLoop();
  }

  /** Estimated current playback position in file-presentation seconds, from the Web Audio graph's
   * own clock -- undefined if nothing is scheduled yet.
   *
   * Picks whichever scheduled chunk has the LARGEST ctxStart that's still <= now -- the one
   * actually audible right now (or, once `now` runs past everything, the most recently finished
   * one) -- rather than assuming `now` always falls cleanly inside exactly one chunk's
   * [ctxStart, ctxStart+duration) range. After many windows of `nextScheduleAt += buffer.duration`
   * accumulating, floating-point rounding can leave a sub-millisecond gap between one chunk's end
   * and the next one's start; if `now` ever lands in that gap, every containment check fails. A
   * previous version fell back to `this.scheduled.at(-1)` in that case, which is normally the
   * FURTHEST-ahead lookahead chunk (up to LOOKAHEAD_SECONDS/WINDOW_SECONDS - 1 windows in the
   * future), not the one actually playing -- observed as a single-tick phantom "audio is exactly
   * 2 windows ahead of video" spike that vanished the instant the next chunk's own tiny gap didn't
   * line up with a poll. This scan is immune to that: array order and which entry happens to be
   * "last" don't matter, only each entry's own ctxStart relative to `now`. */
  estimatedPositionSeconds(): number | undefined {
    if (this.scheduled.length === 0) return undefined;
    const now = this.ctx.currentTime;
    let started: ScheduledChunk | undefined;
    let earliest = this.scheduled[0];
    for (const s of this.scheduled) {
      if (s.ctxStart < earliest.ctxStart) earliest = s;
      if (s.ctxStart <= now && (!started || s.ctxStart > started.ctxStart)) started = s;
    }
    const chunk = started ?? earliest; // nothing has started yet -- report the earliest chunk's own beginning
    return chunk.fileStart + Math.min(Math.max(now - chunk.ctxStart, 0), chunk.duration);
  }

  /** Call periodically with the external master clock's current position (e.g. a driving <video>
   * element's currentTime) -- resyncs (an internal reseek) if drift exceeds DRIFT_THRESHOLD_SECONDS.
   * Suppressed while a cutover is already pending (see start()'s doc comment): the stale-position
   * gap that exists *during* an in-flight reseek would otherwise read as drift and re-trigger
   * seek() over and over before the first one ever finishes decoding. */
  reportMasterPosition(masterSeconds: number): void {
    if (!this.playing || this.disposed || this.pendingCutover) return;
    const estimated = this.estimatedPositionSeconds();
    if (estimated === undefined) return;
    if (Math.abs(estimated - masterSeconds) > DRIFT_THRESHOLD_SECONDS) {
      this.seek(masterSeconds);
    }
  }

  /** Deliberately does NOT stop currently-scheduled nodes here -- whatever's already playing keeps
   * playing until fillNextWindow() has the new position's first window actually decoded and ready,
   * so a seek mid-playback doesn't go silent for the length of a decode+file-read round trip (see
   * pendingCutover's doc comment). */
  async start(atSeconds: number): Promise<void> {
    if (this.disposed) return;
    const gen = ++this.generation;
    await this.ctx.resume();
    if (this.generation !== gen || this.isDisposed()) return;

    this.decoder.configure(this.decoderConfig);
    this.nextWindowStart = atSeconds;
    this.pendingCutover = true;
    this.playing = true;
    // No loop to (re-)spawn here -- runLoop() is already running (started once, in the
    // constructor) and will pick up playing/pendingCutover/nextWindowStart on its own next
    // iteration, within FILL_POLL_MS if it's currently idling.
  }

  /** Reseek while playing -- stops everything scheduled and restarts the fill loop from
   * `atSeconds`. A no-op while paused/never started: repositioning a paused <video>'s currentTime
   * doesn't make it play, and this shouldn't make silence into sound either -- the next start()
   * call already reads the caller's current position fresh (see the harness: Play always passes
   * video.currentTime), so there's nothing for a paused seek() to do here. */
  seek(atSeconds: number): void {
    if (!this.playing) return;
    void this.start(atSeconds);
  }

  pause(): void {
    if (this.disposed) return;
    this.generation += 1; // invalidates any in-flight fill loop iteration
    this.playing = false;
    this.stopScheduled();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.playing = false;
    this.stopScheduled();
    this.decoder.close();
    // Deliberately does NOT close this.ctx -- it's externally owned (shared across every track's
    // mixer, per LiveAudioMixerOptions.ctx's doc comment) and closing it here would kill every
    // OTHER track's clock too. Only disconnect this instance's own node from the graph.
    this.gain.disconnect();
  }

  /** Non-narrowable read of `disposed`, mirroring NativeVideoEngine.ts's identical helper: a plain
   * `this.disposed` re-check after an `await` (dispose() can run during it) gets incorrectly
   * flagged as an always-false condition by TS's flow analysis. */
  private isDisposed(): boolean {
    return this.disposed;
  }

  private stopScheduled(): void {
    for (const s of this.scheduled) {
      try {
        s.node.stop();
      } catch {
        // already stopped/ended -- fine, this is just a "make sure it's silent now" sweep
      }
      s.node.disconnect();
    }
    this.scheduled = [];
  }

  /** Runs for this instance's entire lifetime (started once, from the constructor) -- see that
   * call site's comment for why this replaced a per-call spawned loop. Idles (polling every
   * FILL_POLL_MS) whenever not playing or already comfortably buffered ahead; otherwise decodes
   * and schedules the next window for whatever the CURRENT generation/position is, read fresh each
   * iteration -- never a snapshot captured back when playback started. */
  private async runLoop(): Promise<void> {
    while (!this.disposed) {
      if (!this.playing) {
        await sleep(FILL_POLL_MS);
        continue;
      }

      const gen = this.generation;
      // The lookahead gate only makes sense once nextScheduleAt reflects the CURRENT target --
      // right after a start()/seek() it's still whatever the previous (now-stale) window left it
      // at, which could look like "already plenty buffered" and wrongly stall the very decode this
      // cutover is waiting on. pendingCutover forces straight through to fillNextWindow().
      const bufferedAhead = this.nextScheduleAt - this.ctx.currentTime;
      if (!this.pendingCutover && bufferedAhead >= LOOKAHEAD_SECONDS) {
        await sleep(FILL_POLL_MS);
        continue;
      }

      const more = await this.fillNextWindow(gen);
      if (!more && this.generation === gen) {
        // Genuinely nothing left for the CURRENT generation (end of track, or a decode error --
        // the latter already set playing=false itself). If a newer start()/seek() superseded this
        // window mid-flight instead (this.generation !== gen), it's not our call to touch playing/
        // pendingCutover -- just loop again and let the new generation's own iteration handle it.
        if (this.pendingCutover) {
          this.stopScheduled();
          this.pendingCutover = false;
        }
        this.playing = false;
      }
    }
  }

  /** Returns false when there's nothing left to decode (end of track) or the window was superseded
   * by a newer start()/seek()/pause()/dispose() -- either way the fill loop should stop. */
  private async fillNextWindow(gen: number): Promise<boolean> {
    const windowStart = this.nextWindowStart;
    const windowEnd = windowStart + WINDOW_SECONDS;
    const descriptors = buildWindowJobs(this.index, this.track, windowStart, windowEnd);
    if (descriptors.length === 0) return false; // reached end of track

    // One contiguous read for the whole window, not one file.slice().arrayBuffer() PER SAMPLE
    // (~65-70 of them for a 1.5s window of ~21ms AAC frames) -- that many small parallel reads
    // against a large file was the real cause of a couple of ~3s audio dropouts observed during a
    // real multi-minute 27GB-fixture session (see the plan's results doc): individually cheap, but
    // enough of them fired at once could stall well past LOOKAHEAD_SECONDS's buffer. min/max
    // computed explicitly rather than assuming descriptors[0]/descriptors.at(-1) are the extremes --
    // presentation order isn't guaranteed to match byte-offset order (see window-jobs.ts's own
    // "never assume decode order == presentation order" doctrine).
    let minOffset = descriptors[0].offset;
    let maxEnd = descriptors[0].offset + descriptors[0].size;
    for (const d of descriptors) {
      if (d.offset < minOffset) minOffset = d.offset;
      if (d.offset + d.size > maxEnd) maxEnd = d.offset + d.size;
    }
    const combined = await this.file.slice(minOffset, maxEnd).arrayBuffer();
    if (this.generation !== gen) return false;

    const jobs: DecodeAudioJob[] = descriptors.map((d, i) => ({
      id: i,
      offset: d.offset,
      size: d.size,
      presentationTime: d.presentationTime,
      data: new Uint8Array(combined, d.offset - minOffset, d.size),
    }));

    const channelChunks: Float32Array[][] = [];
    let numberOfChannels = 0;
    let sampleRate = 0;
    const onChunk = (chunk: DecodedAudioChunk): void => {
      numberOfChannels = chunk.numberOfChannels;
      sampleRate = chunk.sampleRate;
      for (let ch = 0; ch < chunk.numberOfChannels; ch += 1) {
        const dest = new Float32Array(chunk.numberOfFrames);
        chunk.copyTo(dest, ch);
        (channelChunks[ch] ??= []).push(dest);
      }
    };

    const result = await this.decoder.decodeBatch(jobs, onChunk);
    if (this.generation !== gen) return false;
    if (result.errors.length > 0) {
      this.onError(`audio-mix window decode had ${String(result.errors.length)} error(s): ${result.errors.map(formatWaveformDecodeError).join('; ')}`);
      this.playing = false;
      return false;
    }
    if (numberOfChannels === 0) return false; // window produced no samples -- treat like end of track

    const totalFrames = channelChunks[0].reduce((sum, seg) => sum + seg.length, 0);
    const buffer = this.ctx.createBuffer(numberOfChannels, totalFrames, sampleRate);
    for (let ch = 0; ch < numberOfChannels; ch += 1) {
      const dest = buffer.getChannelData(ch);
      let offset = 0;
      for (const seg of channelChunks[ch]) {
        dest.set(seg, offset);
        offset += seg.length;
      }
    }

    if (this.pendingCutover) {
      // The new window is decoded and ready -- NOW is the moment to silence whatever was playing
      // before (the old position's stale audio, if this was a seek) and hand off to it, scheduled
      // to start immediately rather than at some earlier `nextScheduleAt` snapshot that decode
      // latency has since made stale.
      this.stopScheduled();
      this.nextScheduleAt = this.ctx.currentTime;
      this.pendingCutover = false;
    }

    // Clamped to "now" if a slow decode/read let nextScheduleAt fall behind real time -- Web Audio
    // itself silently clamps node.start(when) the same way when `when` is already in the past, but
    // it doesn't tell us it did so. Recording the STALE, pre-clamp value here would make
    // estimatedPositionSeconds() overestimate elapsed-into-buffer time by exactly how far behind
    // schedule this window was (observed: a single-tick ~3s phantom "audio ahead of video" spike
    // during otherwise-clean playback, self-correcting the moment the next window's timing was
    // computed from a since-caught-up nextScheduleAt -- no real dropout, just this bookkeeping
    // disagreeing with what the browser actually did).
    const ctxStart = Math.max(this.nextScheduleAt, this.ctx.currentTime);
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain);
    node.start(ctxStart);
    const scheduledChunk: ScheduledChunk = { node, fileStart: windowStart, ctxStart, duration: buffer.duration };
    this.scheduled.push(scheduledChunk);
    node.addEventListener('ended', () => {
      this.scheduled = this.scheduled.filter((s) => s !== scheduledChunk);
    });

    this.nextScheduleAt = ctxStart + buffer.duration;
    this.nextWindowStart = windowEnd;
    return true;
  }
}
