// Manual browser harness for src/media/audio-mix/, following src/media/waveform/harness.ts's
// convention -- not wired into CI, since it needs a real AudioDecoder and a real AudioContext, and
// the whole point of this pass is validating real Chrome behavior no Node test can see.
//
// Drives a plain, muted <video> element (NOT NativeVideoEngine -- that wiring is a later phase) as
// the visual reference / "master clock", and a LiveAudioMixer as the audible sound source, so a
// human can confirm by eye+ear whether picture and sound actually stay in sync. Every ~250ms tick
// feeds the video's currentTime into mixer.reportMasterPosition() so the drift-correction path
// gets exercised for real, not just written and left untested.
//
// Top-priority manual check (see the plan doc): does decode-and-play starting from an ARBITRARY
// mid-file position work cleanly? Nothing in this codebase has verified AAC decode-start off t=0
// before this harness. Seek repeatedly, including backward, while "playing."

import { buildIndex } from '../index/build-index';
import { SampleIndex } from '../index/query';
import { FileByteSource } from '../index/sources/file-byte-source';
import { assertNoStaleFrames, StaleFrameError } from '../frames/frame-lifecycle';
import { LiveAudioMixer } from './LiveAudioMixer';
import type { TrackIndex } from '../index/track-index';

const MASTER_POLL_MS = 250;
const STALE_CHECK_MS = 1000;
const STALE_MAX_AGE_MS = 5000;

// LiveAudioMixer no longer owns its own AudioContext (Phase 2's multi-track case requires every
// track's mixer to share one, since independent AudioContexts can't be mixed together) -- this
// harness only ever runs one track at a time, but still needs to supply one.
const audioCtx = new AudioContext();
const masterGain = audioCtx.createGain();
masterGain.gain.value = 1;
masterGain.connect(audioCtx.destination);

function audioTracksOf(tracks: readonly TrackIndex[]): TrackIndex[] {
  return tracks.filter((t) => t.kind === 'audio' && t.audio);
}

function formatTrackOption(track: TrackIndex): string {
  const a = track.audio;
  return `track ${String(track.trackId)}: ${track.codec}, ${String(a?.channelCount ?? '?')}ch @ ${String(a?.sampleRate ?? '?')}Hz${a?.handlerName ? ` (${a.handlerName})` : ''}`;
}

const root = document.getElementById('app');
if (!root) throw new Error('#app element missing from audio-mix.html');

root.innerHTML = `
  <p><a href="/">&larr; all spikes</a></p>
  <h1>live audio-mix harness</h1>
  <p>Phase 1: decode one audio track via AudioDecoder, play it through a real Web Audio graph,
  synced against a plain muted &lt;video&gt; element (the visual/master-clock reference -- not
  NativeVideoEngine, that wiring is a later phase).</p>
  <input type="file" id="file" accept="video/*,.mkv,.mp4" /><br /><br />
  <button id="load" disabled>1. Load file, list audio tracks</button>
  <pre id="load-log"></pre>
  <div id="track-section" style="display:none">
    <label>Audio track: <select id="track-select"></select></label><br /><br />
    <video id="video" muted controls width="480"></video><br /><br />
    <button id="play">Play</button>
    <button id="pause">Pause</button>
    <label>Seek to (s): <input type="number" id="seek-seconds" value="0" step="0.5" /></label>
    <button id="seek">Seek</button>
    <pre id="status"></pre>
  </div>
`;

const fileInput = root.querySelector<HTMLInputElement>('#file');
const loadBtn = root.querySelector<HTMLButtonElement>('#load');
const loadLog = root.querySelector<HTMLPreElement>('#load-log');
const trackSection = root.querySelector<HTMLDivElement>('#track-section');
const trackSelect = root.querySelector<HTMLSelectElement>('#track-select');
const video = root.querySelector<HTMLVideoElement>('#video');
const playBtn = root.querySelector<HTMLButtonElement>('#play');
const pauseBtn = root.querySelector<HTMLButtonElement>('#pause');
const seekInput = root.querySelector<HTMLInputElement>('#seek-seconds');
const seekBtn = root.querySelector<HTMLButtonElement>('#seek');
const status = root.querySelector<HTMLPreElement>('#status');
if (!fileInput || !loadBtn || !loadLog || !trackSection || !trackSelect || !video || !playBtn || !pauseBtn || !seekInput || !seekBtn || !status) {
  throw new Error('audio-mix harness failed to build its DOM');
}

function log(el: HTMLPreElement, msg: string): void {
  el.textContent += `${msg}\n`;
}

let file: File | undefined;
let sampleIndex: SampleIndex | undefined;
let audioTracks: TrackIndex[] = [];
let mixer: LiveAudioMixer | undefined;

fileInput.addEventListener('change', () => {
  loadBtn.disabled = !fileInput.files?.length;
});

loadBtn.addEventListener('click', () => {
  void (async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    file = f;
    const source = new FileByteSource(f);
    const t0 = performance.now();
    const indexResult = await buildIndex(source);
    if (!indexResult.ok) {
      log(loadLog, `index build failed: ${indexResult.error.kind}`);
      return;
    }
    log(loadLog, `index built in ${(performance.now() - t0).toFixed(1)}ms, ${String(indexResult.tracks.length)} track(s)`);
    sampleIndex = new SampleIndex(indexResult.tracks);
    audioTracks = audioTracksOf(indexResult.tracks);
    if (audioTracks.length === 0) {
      log(loadLog, 'no audio tracks with decodable metadata in this file');
      return;
    }
    trackSelect.innerHTML = audioTracks.map((t, i) => `<option value="${String(i)}">${formatTrackOption(t)}</option>`).join('');
    for (const t of audioTracks) log(loadLog, `  ${formatTrackOption(t)}`);
    video.src = URL.createObjectURL(f);
    trackSection.style.display = '';
  })();
});

// Arrow function expression, not a `function` declaration -- deliberately, so the null-checked DOM
// consts above (trackSelect, status) stay narrowed inside it, matching
// src/media/waveform/harness.ts's own documented convention for this exact issue.
let mixerTrackId: number | undefined;

const ensureMixer = (): LiveAudioMixer | undefined => {
  if (!file || !sampleIndex) return undefined;
  const track = audioTracks.at(Number(trackSelect.value));
  if (!track) return undefined;
  if (mixer && mixerTrackId === track.trackId) return mixer;
  // Selected track changed (or no mixer yet) -- rebuild, not reuse. Without this check the
  // dropdown only ever took effect on the very first Play click: every later click kept reusing
  // whichever track the harness first built a mixer for, which is why switching tracks made no
  // audible difference.
  mixer?.dispose();
  mixer = new LiveAudioMixer({
    file,
    index: sampleIndex,
    track,
    ctx: audioCtx,
    destination: masterGain,
    onError: (message) => {
      log(status, `ERROR: ${message}`);
    },
  });
  mixerTrackId = track.trackId;
  return mixer;
};

playBtn.addEventListener('click', () => {
  void (async () => {
    const m = ensureMixer();
    if (!m) return;
    await video.play();
    await m.start(video.currentTime);
    log(status, `play from ${video.currentTime.toFixed(2)}s`);
  })();
});

pauseBtn.addEventListener('click', () => {
  video.pause();
  mixer?.pause();
  log(status, 'paused');
});

seekBtn.addEventListener('click', () => {
  const seconds = Number(seekInput.value);
  video.currentTime = seconds;
  mixer?.seek(seconds);
  log(status, `seek to ${seconds.toFixed(2)}s`);
});

const masterPollHandle = setInterval(() => {
  if (!mixer || video.paused) return;
  mixer.reportMasterPosition(video.currentTime);
  const estimated = mixer.estimatedPositionSeconds();
  if (estimated !== undefined) {
    const drift = (estimated - video.currentTime) * 1000;
    log(status, `video=${video.currentTime.toFixed(2)}s audio~=${estimated.toFixed(2)}s drift=${drift.toFixed(0)}ms`);
  }
}, MASTER_POLL_MS);

const staleCheckHandle = setInterval(() => {
  if (!mixer) return;
  try {
    assertNoStaleFrames(mixer.registry, STALE_MAX_AGE_MS);
  } catch (err) {
    if (err instanceof StaleFrameError) log(status, `LEAK CHECK FAILED: ${err.message}`);
  }
}, STALE_CHECK_MS);

window.addEventListener('beforeunload', () => {
  clearInterval(masterPollHandle);
  clearInterval(staleCheckHandle);
  mixer?.dispose();
});
