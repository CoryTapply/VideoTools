import { describe, expect, it } from 'vitest';
import { buildIndex } from '../index/build-index';
import { SampleIndex } from '../index/query';
import { BufferByteSource } from '../index/sources/buffer-byte-source';
import { box } from '../index/test-helpers/build-box';
import { runRemuxExport, type ExportSink } from './RemuxStrategy';
import { buildSyntheticSource } from './test-helpers/synthetic-source';
import type { CancelSignal } from './copy-loop';
import type { TrackIndex } from '../index/track-index';

class FakeSink implements ExportSink {
  private chunks: Uint8Array[] = [];
  closed = false;
  aborted: string | undefined;
  onWrite?: (bytes: Uint8Array) => void;

  write(bytes: Uint8Array): Promise<void> {
    this.chunks.push(bytes.slice());
    this.onWrite?.(bytes);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  abort(reason?: string): Promise<void> {
    this.aborted = reason ?? 'aborted';
    return Promise.resolve();
  }

  buffer(): Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  }
}

const videoSampleEntry = box('avc1', new Uint8Array(78));
const audioSampleEntry = box('mp4a', new Uint8Array(28));

function buildTwoTrackSourceBytes(): Uint8Array {
  return buildSyntheticSource(
    [
      {
        trackId: 1,
        handlerType: 'vide',
        timescale: 600,
        sampleDurations: [100, 100, 100, 100, 100, 100],
        syncFlags: [1, 0, 1, 0, 1, 0],
        sampleEntryBoxes: [videoSampleEntry],
      },
      {
        trackId: 2,
        handlerType: 'soun',
        name: 'Mic/Aux',
        timescale: 48000,
        sampleDurations: [8000, 8000, 8000, 8000, 8000, 8000],
        sampleEntryBoxes: [audioSampleEntry],
      },
    ],
    600,
  ).bytes;
}

async function parseTracks(bytes: Uint8Array): Promise<TrackIndex[]> {
  const result = await buildIndex(new BufferByteSource(bytes));
  if (!result.ok) throw new Error(`expected a valid source, got ${JSON.stringify(result.error)}`);
  return result.tracks;
}

describe('runRemuxExport -- differential round trip', () => {
  it('exports both tracks, and the output reparses via the production parser with matching structure and byte content', async () => {
    const sourceBytes = buildTwoTrackSourceBytes();
    const tracks = await parseTracks(sourceBytes);
    const sampleIndex = new SampleIndex(tracks);
    const sink = new FakeSink();
    const signal: CancelSignal = { cancelled: false };

    const result = await runRemuxExport({
      source: new BufferByteSource(sourceBytes),
      sink,
      tracks,
      sampleIndex,
      selectedTrackIds: new Set([1, 2]),
      requestedInSec: 0,
      requestedOutSec: 1,
      signal,
    });

    if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
    expect(sink.closed).toBe(true);
    expect(sink.aborted).toBeUndefined();

    const output = sink.buffer();
    const reparsed = await buildIndex(new BufferByteSource(output));
    if (!reparsed.ok) throw new Error(`expected the exported file to reparse, got ${JSON.stringify(reparsed.error)}`);

    expect(reparsed.tracks).toHaveLength(2);
    const outVideo = reparsed.tracks.find((t) => t.kind === 'video');
    const outAudio = reparsed.tracks.find((t) => t.kind === 'audio');
    if (!outVideo || !outAudio) throw new Error('expected one video and one audio track in the reparsed output');

    expect(outVideo.sampleCount).toBe(6);
    expect(outAudio.sampleCount).toBe(6);
    expect(outVideo.codec).toBe(tracks.find((t) => t.trackId === 1)?.codec);
    expect(outAudio.codec).toBe(tracks.find((t) => t.trackId === 2)?.codec);

    // Every reparsed sample offset/size must land inside the output's own byte range.
    for (const t of reparsed.tracks) {
      for (let i = 0; i < t.sampleCount; i += 1) {
        expect(t.offset[i]).toBeGreaterThanOrEqual(0);
        expect(t.offset[i] + t.size[i]).toBeLessThanOrEqual(output.byteLength);
      }
    }

    // Byte content round-tripped exactly -- not just that the tables parse.
    const sourceContent = buildSyntheticSource(
      [
        { trackId: 1, handlerType: 'vide', timescale: 600, sampleDurations: [100, 100, 100, 100, 100, 100], syncFlags: [1, 0, 1, 0, 1, 0], sampleEntryBoxes: [videoSampleEntry] },
        { trackId: 2, handlerType: 'soun', timescale: 48000, sampleDurations: [8000, 8000, 8000, 8000, 8000, 8000], sampleEntryBoxes: [audioSampleEntry] },
      ],
      600,
    ).sampleContent;
    const videoContent = sourceContent.get(1);
    const audioContent = sourceContent.get(2);
    if (!videoContent || !audioContent) throw new Error('expected sample content for both tracks');
    for (let i = 0; i < outVideo.sampleCount; i += 1) {
      const actual = output.subarray(outVideo.offset[i], outVideo.offset[i] + outVideo.size[i]);
      expect(actual).toEqual(videoContent[i]);
    }
    for (let i = 0; i < outAudio.sampleCount; i += 1) {
      const actual = output.subarray(outAudio.offset[i], outAudio.offset[i] + outAudio.size[i]);
      expect(actual).toEqual(audioContent[i]);
    }
  });

  it('mic-only export: video is excluded from selection but still supplies the cut grid, producing a valid single-track file', async () => {
    const sourceBytes = buildTwoTrackSourceBytes();
    const tracks = await parseTracks(sourceBytes);
    const sampleIndex = new SampleIndex(tracks);
    const sink = new FakeSink();

    const result = await runRemuxExport({
      source: new BufferByteSource(sourceBytes),
      sink,
      tracks,
      sampleIndex,
      selectedTrackIds: new Set([2]), // audio only -- video (trackId 1) omitted
      requestedInSec: 0,
      requestedOutSec: 1,
      signal: { cancelled: false },
    });

    if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
    const reparsed = await buildIndex(new BufferByteSource(sink.buffer()));
    if (!reparsed.ok) throw new Error(`expected the exported file to reparse, got ${JSON.stringify(reparsed.error)}`);

    expect(reparsed.tracks).toHaveLength(1);
    expect(reparsed.tracks[0].kind).toBe('audio');
    expect(reparsed.tracks[0].sampleCount).toBe(6);
  });
});

describe('runRemuxExport -- cancellation', () => {
  it('never calls close() when cancelled, and reports the cancelled error', async () => {
    const sourceBytes = buildTwoTrackSourceBytes();
    const tracks = await parseTracks(sourceBytes);
    const sampleIndex = new SampleIndex(tracks);
    const sink = new FakeSink();
    const signal: CancelSignal = { cancelled: false };
    // Cancel partway through -- the fake sink flips the signal on its own write() calls, which is
    // also how a real UI's cancel button would set it (asynchronously, mid-copy).
    let writeCount = 0;
    sink.onWrite = () => {
      writeCount += 1;
      if (writeCount === 3) signal.cancelled = true;
    };

    const result = await runRemuxExport({
      source: new BufferByteSource(sourceBytes),
      sink,
      tracks,
      sampleIndex,
      selectedTrackIds: new Set([1, 2]),
      requestedInSec: 0,
      requestedOutSec: 1,
      signal,
    });

    expect(result).toEqual({ ok: false, error: { kind: 'cancelled' } });
    expect(sink.closed).toBe(false);
    expect(sink.aborted).toBe('cancelled');
  });
});
