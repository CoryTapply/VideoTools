import { describe, expect, it } from 'vitest';
import {
  computeBitrate,
  computeGop,
  defaultExportFileName,
  defaultTrackSelection,
  deriveExportRows,
  deriveFormatChip,
  deriveJobsRows,
  deriveSourceRows,
  deriveTrackSummaries,
  firstSelectedAudioTrackId,
  formatFileSize,
  friendlyCodecName,
  selectedAudioRealTrackIds,
  selectedRealTrackIds,
} from './derive-source-info.ts';
import type { TrackIndex } from '../../media/index/track-index.ts';

function makeIsSync(sampleCount: number, keyframeEvery: number): Uint8Array {
  const arr = new Uint8Array(sampleCount);
  for (let i = 0; i < sampleCount; i += keyframeEvery) arr[i] = 1;
  return arr;
}

function makeVideoTrack(overrides: Partial<TrackIndex> = {}): TrackIndex {
  const sampleCount = overrides.sampleCount ?? 600;
  return {
    trackId: 1,
    kind: 'video',
    handlerType: 'vide',
    codec: 'avc1.640034',
    timescale: 60,
    duration: sampleCount,
    sampleCount,
    pts: new Float64Array(sampleCount),
    dts: new Float64Array(sampleCount),
    offset: new Float64Array(sampleCount),
    size: new Uint32Array(sampleCount),
    isSync: makeIsSync(sampleCount, 60),
    description: new Uint8Array(0),
    video: { codedWidth: 1920, codedHeight: 1080, displayWidth: 1920, displayHeight: 1080, rotationDegrees: 0, nominalFrameRate: 60, constantDuration: true },
    editOffsetTicks: 0,
    ...overrides,
  };
}

function makeAudioTrack(overrides: Partial<TrackIndex> = {}): TrackIndex {
  const sampleCount = overrides.sampleCount ?? 100;
  return {
    trackId: 2,
    kind: 'audio',
    handlerType: 'soun',
    codec: 'mp4a.40.2',
    timescale: 48000,
    duration: sampleCount * 480,
    sampleCount,
    pts: new Float64Array(sampleCount),
    dts: new Float64Array(sampleCount),
    offset: new Float64Array(sampleCount),
    size: new Uint32Array(sampleCount),
    isSync: makeIsSync(sampleCount, 1),
    description: new Uint8Array(0),
    audio: { channelCount: 2, sampleRate: 48000, language: 'eng', handlerName: 'Mic — NT-USB' },
    editOffsetTicks: 0,
    ...overrides,
  };
}

describe('friendlyCodecName', () => {
  it('maps common RFC 6381 prefixes', () => {
    expect(friendlyCodecName('avc1.640034')).toBe('h264');
    expect(friendlyCodecName('avc3.640034')).toBe('h264');
    expect(friendlyCodecName('hev1.1.6.L93.B0')).toBe('hevc');
    expect(friendlyCodecName('hvc1.1.6.L93.B0')).toBe('hevc');
    expect(friendlyCodecName('av01.0.01M.08')).toBe('av1');
    expect(friendlyCodecName('mp4a.40.2')).toBe('aac');
  });

  it('falls back to the raw string for unknown codecs', () => {
    expect(friendlyCodecName('vp09.00.10.08')).toBe('vp09.00.10.08');
  });
});

describe('formatFileSize', () => {
  it('picks the largest sensible decimal unit', () => {
    expect(formatFileSize(19_400_000_000)).toBe('19.4 GB');
    expect(formatFileSize(512_000_000)).toBe('512.0 MB');
    expect(formatFileSize(2_500)).toBe('2.5 KB');
    expect(formatFileSize(500)).toBe('500 B');
  });
});

describe('computeGop', () => {
  it('averages frames-per-keyframe and converts to seconds', () => {
    expect(computeGop(600, 10, 60)).toEqual({ frames: 60, seconds: 1 });
  });

  it('does not divide by zero when there are no keyframes', () => {
    expect(computeGop(600, 0, 60)).toEqual({ frames: 600, seconds: 0 });
  });
});

describe('computeBitrate', () => {
  it('computes whole-file average Mb/s', () => {
    // 10s at exactly 10 Mb/s -> 12.5 MB.
    expect(computeBitrate(12_500_000, 10)).toBe('10.0 Mb/s');
  });

  it('does not divide by zero', () => {
    expect(computeBitrate(1000, 0)).toBe('0.0 Mb/s');
  });
});

describe('deriveFormatChip', () => {
  it('reads "MP4 · H.264 · size" for an h264 file', () => {
    expect(deriveFormatChip([makeVideoTrack()], 19_400_000_000)).toBe('MP4 · H.264 · 19.4 GB');
  });

  it('falls back to just "MP4 · size" with no video track', () => {
    expect(deriveFormatChip([makeAudioTrack()], 1000)).toBe('MP4 · 1.0 KB');
  });
});

describe('deriveSourceRows', () => {
  it('derives every row from real track data, with no heap row', () => {
    const rows = deriveSourceRows([makeVideoTrack({ sampleCount: 600 })], 19_400_000_000);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel.container).toBe('mp4');
    expect(byLabel.codec).toBe('h264');
    expect(byLabel.resolution).toBe('1920 × 1080');
    expect(byLabel['frame rate']).toBe('60.00 fps');
    expect(byLabel.frames).toBe('600');
    expect(byLabel.keyframes).toBe('10');
    expect(byLabel.GOP).toBe('60 frames · 1.0 s');
    expect(byLabel.size).toBe('19.4 GB');
    expect(rows.find((r) => r.label === 'heap')).toBeUndefined();
  });
});

describe('deriveTrackSummaries', () => {
  it('synthesizes V1/A1 ids', () => {
    const summaries = deriveTrackSummaries([makeVideoTrack(), makeAudioTrack()]);
    expect(summaries.map((s) => s.id)).toEqual(['V1', 'A1']);
    expect(summaries[1].name).toBe('Mic — NT-USB');
  });

  it('falls back to a generic name when an audio track has no handler name', () => {
    const summaries = deriveTrackSummaries([makeAudioTrack({ audio: { channelCount: 1, sampleRate: 44100, language: '', handlerName: '' } })]);
    expect(summaries[0].name).toBe('Audio 1');
    expect(summaries[0].meta).toContain('und');
    expect(summaries[0].meta).toContain('mono');
  });
});

describe('defaultTrackSelection', () => {
  it('selects the video track and only the first audio track', () => {
    const summaries = deriveTrackSummaries([makeVideoTrack(), makeAudioTrack(), makeAudioTrack({ trackId: 3 })]);
    expect(defaultTrackSelection(summaries)).toEqual({ V1: true, A1: true, A2: false });
  });
});

describe('defaultExportFileName', () => {
  it('appends _clip to the source basename, swapping in .mp4', () => {
    expect(defaultExportFileName('session-4.mp4')).toBe('session-4_clip.mp4');
    expect(defaultExportFileName('session-4.mov')).toBe('session-4_clip.mp4');
  });
});

describe('deriveExportRows', () => {
  it('reflects selection count and derives the output name from the source filename', () => {
    const summaries = deriveTrackSummaries([makeVideoTrack(), makeAudioTrack()]);
    const sel = defaultTrackSelection(summaries);
    const rows = deriveExportRows(summaries, sel, 0, 10, 'session-4.mp4', null);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel.audio).toBe('stream copy × 1');
    expect(byLabel.name).toBe('session-4_clip.mp4');
    expect(byLabel.range).toBe('00:00:10');
  });

  it('flags "none selected" in warning tone when no audio track is picked', () => {
    const summaries = deriveTrackSummaries([makeVideoTrack(), makeAudioTrack()]);
    const rows = deriveExportRows(summaries, { V1: true, A1: false }, 0, 10, 'x.mp4', null);
    const audioRow = rows.find((r) => r.label === 'audio');
    expect(audioRow).toEqual({ label: 'audio', value: 'none selected', tone: 'warning' });
  });

  it('flags "none selected" in warning tone when the video track is deselected (audio-only export)', () => {
    const summaries = deriveTrackSummaries([makeVideoTrack(), makeAudioTrack()]);
    const rows = deriveExportRows(summaries, { V1: false, A1: true }, 0, 10, 'x.mp4', null);
    const videoRow = rows.find((r) => r.label === 'video');
    expect(videoRow).toEqual({ label: 'video', value: 'none selected', tone: 'warning' });
  });

  it('falls back to the illustrative formula when no real estimate is available', () => {
    const summaries = deriveTrackSummaries([makeVideoTrack(), makeAudioTrack()]);
    const rows = deriveExportRows(summaries, { V1: true, A1: true }, 0, 10, 'x.mp4', null);
    expect(rows.find((r) => r.label === 'est. size')?.value).toBe('207 MB');
  });

  it('uses a real, formatted byte count when an estimate is provided', () => {
    const summaries = deriveTrackSummaries([makeVideoTrack(), makeAudioTrack()]);
    const rows = deriveExportRows(summaries, { V1: true, A1: true }, 0, 10, 'x.mp4', 512_000_000);
    expect(rows.find((r) => r.label === 'est. size')?.value).toBe('512.0 MB');
  });
});

describe('deriveJobsRows', () => {
  it('returns no rows when nothing has run yet', () => {
    expect(deriveJobsRows(null, null, null, null)).toEqual([]);
  });

  it('shows a running index job before it finishes', () => {
    const rows = deriveJobsRows({ status: 'running' }, null, null, null);
    expect(rows).toEqual([{ label: 'Indexing Video', value: 'running', tone: 'informational' }]);
  });

  it('shows a real elapsed-ms duration once indexing finishes', () => {
    const rows = deriveJobsRows({ status: 'done', ms: 138 }, null, null, null);
    expect(rows).toEqual([{ label: 'Indexing Video', value: 'done · 138 ms', tone: 'good' }]);
  });

  it('shows real thumbnail progress while warming and "done" once complete, with no keyframe map row (keyframes are a free query, never a timed job)', () => {
    const running = deriveJobsRows(null, { status: 'running', percent: 68 }, null, null);
    expect(running).toEqual([{ label: 'Thumbnails', value: '68% · running', tone: 'informational' }]);

    const done = deriveJobsRows(null, { status: 'done', ms: 41 }, null, null);
    expect(done).toEqual([{ label: 'Thumbnails', value: 'done · 41 ms', tone: 'good' }]);

    expect(running.find((r) => r.label === 'keyframe map')).toBeUndefined();
  });

  it('shows a running waveform job before it finishes, and a real elapsed-ms duration once done', () => {
    const running = deriveJobsRows(null, null, { status: 'running' }, null);
    expect(running).toEqual([{ label: 'Waveform', value: 'running', tone: 'informational' }]);

    const done = deriveJobsRows(null, null, { status: 'done', ms: 43700 }, null);
    expect(done).toEqual([{ label: 'Waveform', value: 'done · 43700 ms', tone: 'good' }]);
  });

  it('omits the waveform row entirely when no audio track is active for it (waveformJob null)', () => {
    const rows = deriveJobsRows({ status: 'done', ms: 10 }, null, null, null);
    expect(rows.find((r) => r.label === 'Waveform')).toBeUndefined();
  });

  it('reflects the current export job by real filename and status', () => {
    expect(deriveJobsRows(null, null, null, { status: 'running', fileName: 'clip_03.mp4', percent: 42 })).toEqual([
      { label: 'clip_03.mp4', value: '42% · running', tone: 'informational' },
    ]);
    expect(deriveJobsRows(null, null, null, { status: 'done', fileName: 'clip_03.mp4', durationLabel: '2m 02s' })).toEqual([
      { label: 'clip_03.mp4', value: 'done · 2m 02s', tone: 'good' },
    ]);
    expect(deriveJobsRows(null, null, null, { status: 'canceled', fileName: 'clip_02.mp4' })).toEqual([
      { label: 'clip_02.mp4', value: 'canceled', tone: 'warning' },
    ]);
    expect(deriveJobsRows(null, null, null, { status: 'failed', fileName: 'clip_02.mp4' })).toEqual([
      { label: 'clip_02.mp4', value: 'failed', tone: 'warning' },
    ]);
  });

  it('composes all four jobs together, in order', () => {
    const rows = deriveJobsRows(
      { status: 'done', ms: 138 },
      { status: 'running', percent: 68 },
      { status: 'running' },
      { status: 'running', fileName: 'clip_03.mp4', percent: 10 },
    );
    expect(rows.map((r) => r.label)).toEqual(['Indexing Video', 'Thumbnails', 'Waveform', 'clip_03.mp4']);
  });
});

describe('firstSelectedAudioTrackId', () => {
  it('returns the real trackId of the first selected audio track, in file order', () => {
    const summaries = deriveTrackSummaries([makeVideoTrack(), makeAudioTrack({ trackId: 3 }), makeAudioTrack({ trackId: 7 })]);
    expect(firstSelectedAudioTrackId(summaries, { V1: true, A1: false, A2: true })).toBe(7);
    expect(firstSelectedAudioTrackId(summaries, { V1: true, A1: true, A2: true })).toBe(3);
  });

  it('returns undefined when no audio track is selected', () => {
    const summaries = deriveTrackSummaries([makeVideoTrack(), makeAudioTrack({ trackId: 3 })]);
    expect(firstSelectedAudioTrackId(summaries, { V1: true, A1: false })).toBeUndefined();
  });

  it('returns undefined for a file with no audio tracks', () => {
    const summaries = deriveTrackSummaries([makeVideoTrack()]);
    expect(firstSelectedAudioTrackId(summaries, { V1: true })).toBeUndefined();
  });
});

describe('selectedRealTrackIds', () => {
  it('maps selected display ids back to real MP4 track ids', () => {
    const summaries = deriveTrackSummaries([makeVideoTrack(), makeAudioTrack({ trackId: 3 }), makeAudioTrack({ trackId: 7 })]);
    // V1 -> trackId 1, A1 -> trackId 3, A2 -> trackId 7 (construction order, see deriveTrackSummaries)
    expect(selectedRealTrackIds(summaries, { V1: true, A1: false, A2: true })).toEqual(new Set([1, 7]));
  });
});

describe('selectedAudioRealTrackIds', () => {
  it('maps selected display ids back to real MP4 track ids, audio-kind only', () => {
    const summaries = deriveTrackSummaries([makeVideoTrack(), makeAudioTrack({ trackId: 3 }), makeAudioTrack({ trackId: 7 })]);
    expect(selectedAudioRealTrackIds(summaries, { V1: true, A1: true, A2: true })).toEqual(new Set([3, 7]));
  });

  it('excludes the video track even when its checkbox is selected', () => {
    const summaries = deriveTrackSummaries([makeVideoTrack(), makeAudioTrack({ trackId: 3 })]);
    expect(selectedAudioRealTrackIds(summaries, { V1: true, A1: false })).toEqual(new Set());
  });

  it('returns an empty set when no audio track is selected', () => {
    const summaries = deriveTrackSummaries([makeVideoTrack(), makeAudioTrack({ trackId: 3 })]);
    expect(selectedAudioRealTrackIds(summaries, { V1: true, A1: false })).toEqual(new Set());
  });

  it('returns an empty set for a file with no audio tracks', () => {
    const summaries = deriveTrackSummaries([makeVideoTrack()]);
    expect(selectedAudioRealTrackIds(summaries, { V1: true })).toEqual(new Set());
  });
});
