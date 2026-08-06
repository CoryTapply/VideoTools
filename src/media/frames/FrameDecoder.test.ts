import { describe, expect, it } from 'vitest';
import { formatFrameDecodeError, groupIntoFlushBatches, stripBoxHeader } from './FrameDecoder';

interface TypedJob {
  id: number;
  type: 'key' | 'delta';
}

function job(id: number, type: 'key' | 'delta'): TypedJob {
  return { id, type };
}

function ids(batches: TypedJob[][]): number[][] {
  return batches.map((batch) => batch.map((j) => j.id));
}

describe('stripBoxHeader', () => {
  it('drops the first 8 bytes (4-byte size + 4-byte fourcc), leaving only the box content', () => {
    // A synthetic avcC box: size=16 (0x00000010), fourcc='avcC', then 8 bytes of "content".
    const box = new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x61, 0x76, 0x63, 0x43, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from(stripBoxHeader(box))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('does not mutate the input', () => {
    const box = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 42]);
    const copy = box.slice();
    stripBoxHeader(box);
    expect(box).toEqual(copy);
  });
});

describe('groupIntoFlushBatches', () => {
  it('returns nothing for an empty job list', () => {
    expect(groupIntoFlushBatches([], 16)).toEqual([]);
  });

  it('batches independent keyframes (coarse tier) up to batchSize per group', () => {
    const jobs = Array.from({ length: 40 }, (_, i) => job(i, 'key'));
    const batches = groupIntoFlushBatches(jobs, 16);
    expect(ids(batches)).toEqual([
      Array.from({ length: 16 }, (_, i) => i),
      Array.from({ length: 16 }, (_, i) => i + 16),
      Array.from({ length: 8 }, (_, i) => i + 32),
    ]);
  });

  it('never splits a decode chain (a key job followed by delta jobs), regardless of length or batchSize', () => {
    const jobs = [job(0, 'key'), ...Array.from({ length: 50 }, (_, i) => job(i + 1, 'delta'))];
    const batches = groupIntoFlushBatches(jobs, 16);
    expect(batches).toHaveLength(1);
    expect(ids(batches)[0]).toEqual(jobs.map((j) => j.id));
  });

  it('treats each key-frame-starting chain within a multi-GOP window as its own flush unit, in order', () => {
    // Two GOPs back to back: key,delta,delta,delta, key,delta,delta -- each chain must stay whole,
    // and a flush boundary must land exactly between the two chains, not mid-chain.
    const jobs = [job(0, 'key'), job(1, 'delta'), job(2, 'delta'), job(3, 'delta'), job(4, 'key'), job(5, 'delta'), job(6, 'delta')];
    const batches = groupIntoFlushBatches(jobs, 16);
    expect(ids(batches)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it('a lone keyframe with no following delta is its own batch (independent-keyframe mode, batch of 1)', () => {
    const jobs = [job(0, 'key')];
    expect(ids(groupIntoFlushBatches(jobs, 16))).toEqual([[0]]);
  });

  it('reproduces the exact bug scenario: a chain longer than batchSize must never be split at the batchSize boundary', () => {
    // Regression for the real failure: "A key frame is required after configure() or flush()" --
    // caused by slicing a chain at a fixed batchSize boundary and flushing mid-chain, which resets
    // the decoder's key-frame-required flag right before a 'delta' job.
    const jobs = [job(0, 'key'), ...Array.from({ length: 20 }, (_, i) => job(i + 1, 'delta'))]; // 21 jobs, batchSize 16
    const batches = groupIntoFlushBatches(jobs, 16);
    expect(batches).toHaveLength(1); // NOT split into a 16-job batch + a 5-job batch starting on a delta
    expect(batches[0]?.[0]?.type).toBe('key'); // every batch's first job is safe to follow a flush
  });
});

describe('formatFrameDecodeError', () => {
  it('formats an unsupported-config error with the codec string', () => {
    expect(formatFrameDecodeError({ kind: 'unsupported-config', codec: 'avc1.640034' })).toContain('avc1.640034');
  });

  it('formats a decode-error as its own message', () => {
    expect(formatFrameDecodeError({ kind: 'decode-error', message: 'boom', jobId: 5 })).toBe('boom');
  });
});
