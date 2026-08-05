import { describe, expect, it } from 'vitest';
import { computeEditOffset, findEditList, parseEditList, type EditListEntry } from './edit-list';
import { readBoxHeaderInView } from '../box-cursor';
import { box, fullBoxHeader, i16, i32, i64, u32, u64 } from '../test-helpers/build-box';

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe('parseEditList', () => {
  it('parses version 0 (32-bit) entries', () => {
    const bytes = box('elst', [fullBoxHeader(0), u32(1), u32(90000), i32(1440), i16(1), i16(0)]);
    const view = viewOf(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    expect(parseEditList(view, header)).toEqual([{ segmentDuration: 90000, mediaTime: 1440, mediaRateInteger: 1, mediaRateFraction: 0 }]);
  });

  it('parses version 1 (64-bit) entries, including an empty edit (media_time -1)', () => {
    const bytes = box('elst', [fullBoxHeader(1), u32(2), u64(1000), i64(-1), i16(1), i16(0), u64(90000), i64(1440), i16(1), i16(0)]);
    const view = viewOf(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    expect(parseEditList(view, header)).toEqual([
      { segmentDuration: 1000, mediaTime: -1, mediaRateInteger: 1, mediaRateFraction: 0 },
      { segmentDuration: 90000, mediaTime: 1440, mediaRateInteger: 1, mediaRateFraction: 0 },
    ]);
  });
});

describe('findEditList', () => {
  it('returns undefined when there is no edts/elst at all', () => {
    const bytes = box('trak', [box('tkhd', new Uint8Array(4))]);
    const view = viewOf(bytes);
    expect(findEditList(view, 8, bytes.byteLength)).toBeUndefined();
  });
});

describe('computeEditOffset', () => {
  const movieTimescale = 1000;
  const trackTimescale = 48000;
  const movieDuration = 60_000;

  it('is trivial (no warning) for a single entry spanning the full duration at rate 1.0 from media_time 0', () => {
    const entries: EditListEntry[] = [{ segmentDuration: movieDuration, mediaTime: 0, mediaRateInteger: 1, mediaRateFraction: 0 }];
    const result = computeEditOffset(entries, movieTimescale, trackTimescale, movieDuration);
    expect(result.editOffsetTicks).toBe(0);
    expect(result.isNonTrivial).toBe(false);
  });

  it('is non-trivial for a single real edit with a non-zero media_time (priming delay)', () => {
    const entries: EditListEntry[] = [{ segmentDuration: movieDuration, mediaTime: 1440, mediaRateInteger: 1, mediaRateFraction: 0 }];
    const result = computeEditOffset(entries, movieTimescale, trackTimescale, movieDuration);
    expect(result.editOffsetTicks).toBe(1440);
    expect(result.isNonTrivial).toBe(true);
  });

  it('folds a leading empty edit (converted into the track timescale) into the offset', () => {
    // A 24ms empty edit (in the movie's 1000-unit timescale) converts to 24 * 48 = 1152 track ticks.
    const entries: EditListEntry[] = [
      { segmentDuration: 24, mediaTime: -1, mediaRateInteger: 1, mediaRateFraction: 0 },
      { segmentDuration: movieDuration - 24, mediaTime: 1440, mediaRateInteger: 1, mediaRateFraction: 0 },
    ];
    const result = computeEditOffset(entries, movieTimescale, trackTimescale, movieDuration);
    expect(result.editOffsetTicks).toBe(1440 - 1152);
    expect(result.isNonTrivial).toBe(true);
  });

  it('is non-trivial (but still gives a best-effort offset from the FIRST real edit) with multiple real edits', () => {
    const entries: EditListEntry[] = [
      { segmentDuration: 30_000, mediaTime: 1440, mediaRateInteger: 1, mediaRateFraction: 0 },
      { segmentDuration: 30_000, mediaTime: 500_000, mediaRateInteger: 1, mediaRateFraction: 0 },
    ];
    const result = computeEditOffset(entries, movieTimescale, trackTimescale, movieDuration);
    expect(result.editOffsetTicks).toBe(1440);
    expect(result.isNonTrivial).toBe(true);
  });
});
