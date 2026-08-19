// Pure derivation from a real parsed file (src/media/index/'s TrackIndex[]) to the UI's display
// shapes (PanelRowFixture[], TrackSummary[]). Every number here was previously faked in
// ../fixtures.ts -- this module is where they become real formulas instead. No DOM, no File, no
// Worker -- fully Node-testable against hand-built TrackIndex-shaped fixtures.

// Direct submodule imports, not the barrel -- see app-state.ts's comment on why.
import { ticksToSeconds } from '../../media/index/time.ts';
import { formatDurationHMS } from '../state/snap-notice.ts';
import type { TrackIndex } from '../../media/index/track-index.ts';
import type { TrackId, TrackSelection } from '../state/app-state.ts';
import type { PanelRowFixture } from './panel-row.ts';
import type { TrackSummary } from './track-summary.ts';

/** Codec-family short name, by RFC 6381 prefix. Profile decoding (e.g. "High") is not attempted. */
export function friendlyCodecName(codec: string): string {
  if (codec.startsWith('avc1') || codec.startsWith('avc3')) return 'h264';
  if (codec.startsWith('hev1') || codec.startsWith('hvc1')) return 'hevc';
  if (codec.startsWith('av01')) return 'av1';
  if (codec.startsWith('mp4a')) return 'aac';
  return codec || 'unknown';
}

/** Uppercase form used only by the title-bar format chip, e.g. "H.264", "HEVC". */
function chipCodecName(codec: string): string {
  const friendly = friendlyCodecName(codec);
  if (friendly === 'h264') return 'H.264';
  return friendly.toUpperCase();
}

/** Decimal (1000-based) units, matching the design fixture's own "19.4 GB" style. */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes.toString()} B`;
}

export interface Gop {
  frames: number;
  seconds: number;
}

/** Average GOP length. Real footage isn't assumed to have a constant GOP -- this is a mean. */
export function computeGop(sampleCount: number, keyframeCount: number, fps: number): Gop {
  if (keyframeCount <= 0 || fps <= 0) {
    return { frames: sampleCount, seconds: 0 };
  }
  const frames = Math.round(sampleCount / keyframeCount);
  return { frames, seconds: frames / fps };
}

/** Mb/s, from total file size and overall duration -- a whole-file average, not a per-track figure. */
export function computeBitrate(fileSizeBytes: number, durationSeconds: number): string {
  if (durationSeconds <= 0) {
    return '0.0 Mb/s';
  }
  const megabitsPerSecond = (fileSizeBytes * 8) / durationSeconds / 1_000_000;
  return `${megabitsPerSecond.toFixed(1)} Mb/s`;
}

function primaryVideoTrack(tracks: readonly TrackIndex[]): TrackIndex | undefined {
  return tracks.find((t) => t.kind === 'video');
}

function keyframeCount(track: TrackIndex): number {
  let count = 0;
  for (let i = 0; i < track.isSync.length; i++) {
    if (track.isSync[i] === 1) count++;
  }
  return count;
}

/** The title bar's "MP4 · H.264 · 19.4 GB" chip. Container is always "MP4" -- the parser only understands ISOBMFF. */
export function deriveFormatChip(tracks: readonly TrackIndex[], fileSizeBytes: number): string {
  const video = primaryVideoTrack(tracks);
  const codecPart = video !== undefined ? ` · ${chipCodecName(video.codec)}` : '';
  return `MP4${codecPart} · ${formatFileSize(fileSizeBytes)}`;
}

/**
 * The Source panel's key/value rows. Deliberately has no "heap" row -- no reliable cross-browser
 * in-page memory API exists; this project's own convention is OS-level measurement, not a
 * fabricated number (see PROJECT-CONTEXT.md).
 */
export function deriveSourceRows(tracks: readonly TrackIndex[], fileSizeBytes: number): PanelRowFixture[] {
  const video = primaryVideoTrack(tracks);
  const rows: PanelRowFixture[] = [{ label: 'container', value: 'mp4', tone: 'neutral' }];
  if (video?.video !== undefined) {
    const meta = video.video;
    const keyframes = keyframeCount(video);
    const gop = computeGop(video.sampleCount, keyframes, meta.nominalFrameRate);
    const durationSeconds = ticksToSeconds(video.duration, video.timescale);
    rows.push(
      { label: 'codec', value: friendlyCodecName(video.codec), tone: 'muted' },
      { label: 'resolution', value: `${meta.displayWidth.toString()} × ${meta.displayHeight.toString()}`, tone: 'muted' },
      { label: 'frame rate', value: `${meta.nominalFrameRate.toFixed(2)} fps`, tone: 'muted' },
      { label: 'frames', value: video.sampleCount.toLocaleString('en-US'), tone: 'muted' },
      { label: 'keyframes', value: keyframes.toLocaleString('en-US'), tone: 'muted' },
      { label: 'GOP', value: `${gop.frames.toString()} frames · ${gop.seconds.toFixed(1)} s`, tone: 'muted' },
      { label: 'bitrate', value: computeBitrate(fileSizeBytes, durationSeconds), tone: 'muted' },
    );
  }
  rows.push({ label: 'size', value: formatFileSize(fileSizeBytes), tone: 'muted' });
  return rows;
}

/** Synthesizes display ids (V1, V2, ..., A1, A2, ...) -- real MP4 track ids aren't meaningful to show. */
export function deriveTrackSummaries(tracks: readonly TrackIndex[]): TrackSummary[] {
  let videoIndex = 0;
  let audioIndex = 0;
  const summaries: TrackSummary[] = [];
  for (const track of tracks) {
    if (track.kind === 'video' && track.video !== undefined) {
      videoIndex++;
      const id: TrackId = `V${videoIndex.toString()}`;
      const durationSeconds = ticksToSeconds(track.duration, track.timescale);
      summaries.push({
        id,
        trackId: track.trackId,
        name: 'Video',
        meta: `${friendlyCodecName(track.codec)} · ${track.video.displayWidth.toString()}×${track.video.displayHeight.toString()} · ${track.video.nominalFrameRate.toFixed(2)} fps · ${formatDurationHMS(durationSeconds)}`,
        kind: 'video',
      });
    } else if (track.kind === 'audio' && track.audio !== undefined) {
      audioIndex++;
      const id: TrackId = `A${audioIndex.toString()}`;
      const durationSeconds = ticksToSeconds(track.duration, track.timescale);
      const channels = track.audio.channelCount === 1 ? 'mono' : track.audio.channelCount === 2 ? 'stereo' : `${track.audio.channelCount.toString()} ch`;
      const khz = track.audio.sampleRate % 1000 === 0 ? (track.audio.sampleRate / 1000).toFixed(0) : (track.audio.sampleRate / 1000).toFixed(1);
      summaries.push({
        id,
        trackId: track.trackId,
        name: track.audio.handlerName !== '' ? track.audio.handlerName : `Audio ${audioIndex.toString()}`,
        meta: `${friendlyCodecName(track.codec)} · ${track.audio.language !== '' ? track.audio.language : 'und'} · ${channels} · ${khz} kHz · ${formatDurationHMS(durationSeconds)}`,
        kind: 'audio',
      });
    }
  }
  return summaries;
}

/** Default selection once a file has just been parsed: primary video + first audio track. */
export function defaultTrackSelection(tracks: readonly TrackSummary[]): TrackSelection {
  const sel: TrackSelection = {};
  let sawAudio = false;
  for (const track of tracks) {
    if (track.kind === 'video') {
      sel[track.id] = true;
    } else {
      sel[track.id] = !sawAudio;
      sawAudio = true;
    }
  }
  return sel;
}

/** Maps selected display ids (TrackList/ExportPanel's `TrackSelection`) back to real MP4 track
 * ids -- what export needs to call `SampleIndex.sampleRange`/`resolveExportSelection` with. */
export function selectedRealTrackIds(tracks: readonly TrackSummary[], sel: TrackSelection): Set<number> {
  return new Set(tracks.filter((t) => sel[t.id]).map((t) => t.trackId));
}

/** Same as selectedRealTrackIds, but audio-kind tracks only -- what the live audio-mix engine
 * (src/media/audio-mix/AudioMixEngine.ts) needs to know which tracks should currently be
 * decoding+playing, unlike export's own selection which also includes the video track. */
export function selectedAudioRealTrackIds(tracks: readonly TrackSummary[], sel: TrackSelection): Set<number> {
  return new Set(tracks.filter((t) => t.kind === 'audio' && sel[t.id]).map((t) => t.trackId));
}

/** The real MP4 track id of the first selected audio track, in file order (deriveTrackSummaries's
 * own iteration order over the source TrackIndex[] -- video first, then audio in track order).
 * Drives which track's pyramid the single waveform lane shows -- media-session.ts's
 * activateWaveformTrack effect re-derives this whenever `sel` changes, so the lane tracks live
 * export-selection changes rather than staying fixed to whatever was selected at file-open. */
export function firstSelectedAudioTrackId(tracks: readonly TrackSummary[], sel: TrackSelection): number | undefined {
  return tracks.find((t) => t.kind === 'audio' && sel[t.id])?.trackId;
}

/**
 * The Export panel's rows. `folder` stays an illustrative approximation (unknowable before a save
 * destination is actually chosen) -- flagged, not silently presented as measured. `est. size` is a
 * real sum of selected sample sizes over the trimmed range when `estimatedBytes` is available
 * (i.e. a real file is open); otherwise (ui-harness.html's fixture-only variants) it falls back to
 * the same illustrative formula design/README.md's own mock uses.
 */
/** The auto-generated export name for a given source file -- shown as a preview in the Export
 * panel, and used to pre-fill the native Save dialog's suggested name (see
 * state/export-session.ts's `startExport`). The actual saved name is whatever the user confirms in
 * that dialog, which may differ from this. */
export function defaultExportFileName(sourceFileName: string): string {
  const baseName = sourceFileName.replace(/\.[^.]+$/, '');
  return `${baseName}_clip.mp4`;
}

/** Real job/export state for the Jobs panel -- see ../panels/JobsPanel.tsx. Deliberately has no
 * "keyframe map" row: keyframes are a free query over the already-built SampleIndex, never a
 * separate timed job -- same convention as deriveSourceRows's deliberately-omitted "heap" row
 * above: no fabricated rows for work that isn't actually happening. (Waveform generation *does*
 * exist now, M2 -- see WaveformJobStatus below.) */
export type IndexJobStatus = { status: 'running' } | { status: 'done'; ms: number };

export type ThumbsJobStatus = { status: 'running'; percent: number } | { status: 'done'; ms: number };

/** Real timing for the Jobs panel's "waveform" row. Binary, not percent-based like ThumbsJobStatus
 * -- WaveformCache.build() has no progress callback (unlike FrameCache.warmCoarse()'s real
 * per-frame one), so there's no percentage to show, only running/done. Driven by
 * media-session.ts's activateWaveformTrack -- reflects whichever audio track is CURRENTLY active
 * for the waveform lane, not every track's build status. */
export type WaveformJobStatus = { status: 'running' } | { status: 'done'; ms: number };

export type ExportJobStatus =
  | { status: 'running'; fileName: string; percent: number }
  | { status: 'done'; fileName: string; durationLabel: string }
  | { status: 'canceled'; fileName: string }
  | { status: 'failed'; fileName: string };

export function deriveJobsRows(
  indexJob: IndexJobStatus | null,
  thumbsJob: ThumbsJobStatus | null,
  waveformJob: WaveformJobStatus | null,
  exportJob: ExportJobStatus | null,
): PanelRowFixture[] {
  const rows: PanelRowFixture[] = [];
  if (indexJob !== null) {
    rows.push(
      indexJob.status === 'done'
        ? { label: 'Indexing Video', value: `done · ${indexJob.ms.toString()} ms`, tone: 'good' }
        : { label: 'Indexing Video', value: 'running', tone: 'informational' },
    );
  }
  if (thumbsJob !== null) {
    rows.push(
      thumbsJob.status === 'done'
        ? { label: 'Thumbnails', value: `done · ${thumbsJob.ms.toString()} ms`, tone: 'good' }
        : { label: 'Thumbnails', value: `${thumbsJob.percent.toString()}% · running`, tone: 'informational' },
    );
  }
  if (waveformJob !== null) {
    rows.push(
      waveformJob.status === 'done'
        ? { label: 'Waveform', value: `done · ${waveformJob.ms.toString()} ms`, tone: 'good' }
        : { label: 'Waveform', value: 'running', tone: 'informational' },
    );
  }
  if (exportJob !== null) {
    switch (exportJob.status) {
      case 'running':
        rows.push({ label: exportJob.fileName, value: `${exportJob.percent.toString()}% · running`, tone: 'informational' });
        break;
      case 'done':
        rows.push({ label: exportJob.fileName, value: `done · ${exportJob.durationLabel}`, tone: 'good' });
        break;
      case 'canceled':
        rows.push({ label: exportJob.fileName, value: 'canceled', tone: 'warning' });
        break;
      case 'failed':
        rows.push({ label: exportJob.fileName, value: 'failed', tone: 'warning' });
        break;
    }
  }
  return rows;
}

export function deriveExportRows(
  tracks: readonly TrackSummary[],
  sel: TrackSelection,
  tstart: number,
  tend: number,
  sourceFileName: string,
  estimatedBytes: number | null,
): PanelRowFixture[] {
  const videoSelected = tracks.some((t) => t.kind === 'video' && sel[t.id]);
  const audioSelected = tracks.filter((t) => t.kind === 'audio' && sel[t.id]).length;
  const estSize = estimatedBytes !== null ? formatFileSize(estimatedBytes) : `${(178 + audioSelected * 29).toString()} MB`;
  return [
    { label: 'container', value: 'mp4', tone: 'neutral' },
    { label: 'video', value: videoSelected ? 'stream copy' : 'none selected', tone: videoSelected ? 'informational' : 'warning' },
    {
      label: 'audio',
      value: audioSelected === 0 ? 'none selected' : `stream copy × ${audioSelected.toString()}`,
      tone: audioSelected === 0 ? 'warning' : 'informational',
    },
    { label: 'range', value: formatDurationHMS(tend - tstart), tone: 'neutral' },
    { label: 'est. size', value: estSize, tone: 'muted' },
    { label: 'writer', value: 'file system access', tone: 'good' },
    { label: 'name', value: defaultExportFileName(sourceFileName), tone: 'muted' },
  ];
}
