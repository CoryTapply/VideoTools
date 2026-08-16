import { describe, expect, it } from 'vitest';
import { buildIndex } from './build-index';
import { BufferByteSource } from './sources/buffer-byte-source';
import { box, concatBytes, fourcc, u16, u32, u8 } from './test-helpers/build-box';
import { buildSyntheticFile, buildSyntheticMoov, buildSyntheticTrak, type SyntheticTrackSpec } from './test-helpers/synthetic-mp4';

function avc1SampleEntry(width: number, height: number): Uint8Array {
  const avcC = box('avcC', concatBytes([u8(1), u8(0x64), u8(0x00), u8(0x1f), new Uint8Array(2)]));
  return box('avc1', [new Uint8Array(24), u16(width), u16(height), new Uint8Array(78 - 28), avcC]);
}

function mp4aSampleEntry(): Uint8Array {
  return box('mp4a', new Uint8Array(28));
}

function encvSampleEntry(): Uint8Array {
  return box('encv', new Uint8Array(78));
}

const baseVideoSpec = (overrides: Partial<SyntheticTrackSpec> = {}): SyntheticTrackSpec => ({
  trackId: 1,
  handlerType: 'vide',
  timescale: 30000,
  mediaDuration: 3000,
  tkhdDuration: 100,
  sampleDurations: [1000, 1000, 1000],
  sampleSizes: [500, 200, 300],
  chunkOffset: 5000,
  sampleEntryBoxes: [avc1SampleEntry(1920, 1080)],
  ...overrides,
});

function buildFile(tracks: SyntheticTrackSpec[], extraMoovChildren: Uint8Array[] = []): Uint8Array {
  const traks = tracks.map(buildSyntheticTrak);
  const moov = buildSyntheticMoov(traks, 1000, 3000, extraMoovChildren);
  return buildSyntheticFile(moov);
}

describe('buildIndex -- happy path', () => {
  it('parses a minimal single-video-track file', async () => {
    const bytes = buildFile([baseVideoSpec()]);
    const result = await buildIndex(new BufferByteSource(bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tracks).toHaveLength(1);
    const track = result.tracks[0];
    expect(track.kind).toBe('video');
    expect(track.sampleCount).toBe(3);
    expect(Array.from(track.dts)).toEqual([0, 1000, 2000]);
    expect(Array.from(track.size)).toEqual([500, 200, 300]);
    expect(Array.from(track.offset)).toEqual([5000, 5500, 5700]);
    expect(track.codec).toBe('avc1.64001f');
    expect(track.video?.codedWidth).toBe(1920);
    expect(track.video?.codedHeight).toBe(1080);
    expect(track.video?.constantDuration).toBe(true);
  });

  it('reports bytesRead close to moovSize, not the whole (27GB-scale) file', async () => {
    const bytes = buildFile([baseVideoSpec()], []);
    const result = await buildIndex(new BufferByteSource(bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // moov is a small fraction of this synthetic file; bytesRead must stay close to moov's own
    // size (a handful of small top-level-scan header reads, plus exactly one moov read) --
    // never proportional to the whole file, which is the read-amplification regression class.
    expect(result.bytesRead).toBeLessThan(bytes.byteLength);
    expect(result.bytesRead).toBeLessThan(2000);
  });

  it('parses multiple tracks, including audio with language/handlerName', async () => {
    const video = baseVideoSpec();
    const audio: SyntheticTrackSpec = {
      trackId: 2,
      handlerType: 'soun',
      name: 'Desktop Audio',
      timescale: 48000,
      mediaDuration: 4800,
      tkhdDuration: 100,
      sampleDurations: [1024, 1024],
      sampleSizes: [100, 100],
      chunkOffset: 9000,
      sampleEntryBoxes: [mp4aSampleEntry()],
    };
    const bytes = buildFile([video, audio]);
    const result = await buildIndex(new BufferByteSource(bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tracks).toHaveLength(2);
    const audioTrack = result.tracks.find((t) => t.trackId === 2);
    expect(audioTrack?.kind).toBe('audio');
    expect(audioTrack?.audio?.handlerName).toBe('Desktop Audio');
  });

  it('handles a zero-sample track without error', async () => {
    const bytes = buildFile([baseVideoSpec({ sampleDurations: [], sampleSizes: [] })]);
    const result = await buildIndex(new BufferByteSource(bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tracks[0].sampleCount).toBe(0);
  });

  it('classifies a non-media (tmcd) track as "other" without building a sample index', async () => {
    const bytes = buildFile([
      baseVideoSpec(),
      { ...baseVideoSpec({ trackId: 3, handlerType: 'tmcd', sampleDurations: [1], sampleSizes: [4] }) },
    ]);
    const result = await buildIndex(new BufferByteSource(bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tmcd = result.tracks.find((t) => t.trackId === 3);
    expect(tmcd?.kind).toBe('other');
    expect(tmcd?.sampleCount).toBe(0);
  });

  it('detects a variable-frame-rate track (constantDuration: false)', async () => {
    const bytes = buildFile([baseVideoSpec({ sampleDurations: [900, 1100, 1000], sampleSizes: [1, 1, 1] })]);
    const result = await buildIndex(new BufferByteSource(bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tracks[0].video?.constantDuration).toBe(false);
  });
});

describe('buildIndex -- warnings (not errors)', () => {
  it('surfaces a non-trivial edit list as a warning, not a failure', async () => {
    const bytes = buildFile([baseVideoSpec({ editList: [{ segmentDuration: 30, mediaTime: 1440, mediaRateInteger: 1, mediaRateFraction: 0 }] })]);
    const result = await buildIndex(new BufferByteSource(bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tracks[0].editOffsetTicks).toBe(1440);
    expect(result.warnings).toContainEqual(expect.objectContaining({ kind: 'non-trivial-edit-list', trackId: 1 }));
  });

  it('surfaces multiple non-empty edits as a warning while still returning a best-effort offset', async () => {
    const bytes = buildFile([
      baseVideoSpec({
        editList: [
          { segmentDuration: 30, mediaTime: 1440, mediaRateInteger: 1, mediaRateFraction: 0 },
          { segmentDuration: 30, mediaTime: 500_000, mediaRateInteger: 1, mediaRateFraction: 0 },
        ],
      }),
    ]);
    const result = await buildIndex(new BufferByteSource(bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tracks[0].editOffsetTicks).toBe(1440);
    expect(result.warnings.some((w) => w.kind === 'non-trivial-edit-list')).toBe(true);
  });

  it('surfaces multiple stsd entries as a warning', async () => {
    const entry = avc1SampleEntry(1920, 1080);
    const bytes = buildFile([baseVideoSpec({ sampleEntryBoxes: [entry, entry] })]);
    const result = await buildIndex(new BufferByteSource(bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toContainEqual(expect.objectContaining({ kind: 'multiple-stsd-entries', trackId: 1, entryCount: 2 }));
  });
});

describe('buildIndex -- error conditions', () => {
  it('returns not-isobmff for a non-MP4 file', async () => {
    const result = await buildIndex(new BufferByteSource(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-isobmff');
  });

  it('returns no-moov when moov is absent', async () => {
    const ftyp = box('ftyp', concatBytes([fourcc('isom'), u32(0)]));
    const result = await buildIndex(new BufferByteSource(concatBytes([ftyp, box('free', new Uint8Array(4))])));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no-moov');
  });

  it('returns fragmented-mp4 for a top-level moof', async () => {
    const ftyp = box('ftyp', concatBytes([fourcc('isom'), u32(0)]));
    const result = await buildIndex(new BufferByteSource(concatBytes([ftyp, box('moof', new Uint8Array(4))])));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('fragmented-mp4');
  });

  it('returns fragmented-mp4 when moov contains an mvex box', async () => {
    const bytes = buildFile([baseVideoSpec()], [box('mvex', box('trex', [u32(0), u32(0), u32(1), u32(0), u32(0), u32(0)]))]);
    const result = await buildIndex(new BufferByteSource(bytes));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('fragmented-mp4');
  });

  it('returns encrypted when moov contains a top-level pssh box', async () => {
    const bytes = buildFile([baseVideoSpec()], [box('pssh', new Uint8Array(20))]);
    const result = await buildIndex(new BufferByteSource(bytes));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('encrypted');
  });

  it('returns encrypted for an encv sample entry', async () => {
    const bytes = buildFile([baseVideoSpec({ sampleEntryBoxes: [encvSampleEntry()] })]);
    const result = await buildIndex(new BufferByteSource(bytes));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('encrypted');
  });

  it('returns truncated when moov claims more bytes than the source actually has', async () => {
    const traks = [buildSyntheticTrak(baseVideoSpec())];
    const moov = buildSyntheticMoov(traks, 1000, 3000);
    const ftyp = box('ftyp', concatBytes([fourcc('isom'), u32(0)]));
    const full = concatBytes([ftyp, moov]);
    const truncated = full.subarray(0, full.byteLength - 20); // chop off the tail of moov
    const result = await buildIndex(new BufferByteSource(truncated));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('truncated');
  });

  it('returns malformed-box for a structurally corrupt stbl child, without throwing', async () => {
    const bytes = buildFile([baseVideoSpec()]);
    // Corrupt the size field of some box inside moov by zeroing 4 bytes at a fixed offset that
    // lands inside the trak's stbl -- any specific corruption is fine; the point is that
    // buildIndex must convert the resulting parse failure into a value, not throw.
    const corrupted = bytes.slice();
    const view = new DataView(corrupted.buffer);
    // Find 'stsc' fourcc and corrupt the box AFTER it (co64/stco) by writing a too-large size.
    const needle = Uint8Array.from('stco', (c) => c.charCodeAt(0));
    outer: for (let i = 0; i < corrupted.byteLength - 4; i += 1) {
      for (let k = 0; k < 4; k += 1) if (corrupted[i + k] !== needle[k]) continue outer;
      view.setUint32(i - 4, 100_000, false); // box size field precedes the 4-byte type
      break;
    }
    const result = await buildIndex(new BufferByteSource(corrupted));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('malformed-box');
  });
});
