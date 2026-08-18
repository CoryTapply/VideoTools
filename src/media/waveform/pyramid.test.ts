import { describe, expect, it } from 'vitest';
import { buildLevelSpecs, estimatePyramidBytes, PyramidBuilder } from './pyramid';

describe('buildLevelSpecs', () => {
  it('returns [] for sampleCount <= 0', () => {
    expect(buildLevelSpecs(0)).toEqual([]);
    expect(buildLevelSpecs(-5)).toEqual([]);
  });

  it('computes the ceiling-based level table, terminating once a level reaches 1 bucket', () => {
    expect(buildLevelSpecs(10, 4, 2)).toEqual([
      { samplesPerBucket: 4, bucketCount: 3 }, // ceil(10/4)
      { samplesPerBucket: 8, bucketCount: 2 }, // ceil(10/8)
      { samplesPerBucket: 16, bucketCount: 1 }, // ceil(10/16) -- terminal
    ]);
  });

  it('handles sampleCount smaller than l0: a single terminal level', () => {
    expect(buildLevelSpecs(3, 128, 8)).toEqual([{ samplesPerBucket: 128, bucketCount: 1 }]);
  });

  it('matches the roadmap-cited worst case: 4hr/48kHz total sample count', () => {
    const sampleCount = 4 * 3600 * 48000;
    const specs = buildLevelSpecs(sampleCount, 128, 8);
    expect(specs[0]).toEqual({ samplesPerBucket: 128, bucketCount: 5_400_000 });
    expect(specs.at(-1)?.bucketCount).toBe(1);
    expect(specs).toHaveLength(9);
  });
});

describe('estimatePyramidBytes', () => {
  it('sums 4 bytes/bucket/channel (Int16 min + Int16 max) across every level', () => {
    // buildLevelSpecs(10, 4, 2) -> bucketCounts [3, 2, 1], total 6 buckets.
    expect(estimatePyramidBytes(10, 2, 4, 2)).toBe(6 * 2 * 4);
  });

  it('confirms the plan/roadmap-cited ~49.4MB figure for the 4hr/48kHz stereo worst case', () => {
    const bytes = estimatePyramidBytes(4 * 3600 * 48000, 2);
    expect(bytes).toBe(49_371_448);
    // ~112x smaller than the ~5.5GB raw-float32 figure the roadmap warns decodeAudioData produces.
    expect(bytes).toBeLessThan(50_000_000);
  });
});

function quantize(x: number): number {
  const clamped = x < -1 ? -1 : x > 1 ? 1 : x;
  return Math.round(clamped * 32767);
}

describe('PyramidBuilder', () => {
  it('reduces a single channel to hand-verifiable min/max buckets at every level, including a forced partial tail', () => {
    // l0=4, ratio=2 -> L0 buckets of 4 samples, L1 folds 2 L0 buckets, L2 folds 2 L1 buckets.
    // 10 samples: L0 has buckets of [4, 4, 2] samples (last one partial, only flushed by finish()).
    const samples = [0.5, -0.25, 1.0, -1.0, 0.1, 0.2, 0.3, 0.4, -0.6, 0.9];
    const builder = new PyramidBuilder(1, 4, 2);
    builder.push(0, Float32Array.from(samples));
    const levels = builder.finish();

    expect(levels).toHaveLength(3);

    // L0: bucket0=[0.5,-0.25,1.0,-1.0] min=-1.0 max=1.0; bucket1=[0.1,0.2,0.3,0.4] min=0.1 max=0.4;
    // bucket2(partial)=[-0.6,0.9] min=-0.6 max=0.9.
    expect(levels[0].samplesPerBucket).toBe(4);
    expect(levels[0].bucketCount).toBe(3);
    expect(Array.from(levels[0].min[0])).toEqual([quantize(-1.0), quantize(0.1), quantize(-0.6)]);
    expect(Array.from(levels[0].max[0])).toEqual([quantize(1.0), quantize(0.4), quantize(0.9)]);

    // L1: bucket0 folds L0[0,1] -> min=-1.0 max=1.0; bucket1(partial) folds L0[2] alone -> min=-0.6 max=0.9.
    expect(levels[1].samplesPerBucket).toBe(8);
    expect(levels[1].bucketCount).toBe(2);
    expect(Array.from(levels[1].min[0])).toEqual([quantize(-1.0), quantize(-0.6)]);
    expect(Array.from(levels[1].max[0])).toEqual([quantize(1.0), quantize(0.9)]);

    // L2: bucket0 folds L1[0,1] -> min=min(-1.0,-0.6)=-1.0, max=max(1.0,0.9)=1.0.
    expect(levels[2].samplesPerBucket).toBe(16);
    expect(levels[2].bucketCount).toBe(1);
    expect(Array.from(levels[2].min[0])).toEqual([quantize(-1.0)]);
    expect(Array.from(levels[2].max[0])).toEqual([quantize(1.0)]);
  });

  it('matches buildLevelSpecs() for the same total sample count', () => {
    const samples = Array.from({ length: 37 }, (_, i) => Math.sin(i));
    const builder = new PyramidBuilder(1, 4, 2);
    builder.push(0, samples);
    const levels = builder.finish();
    const expected = buildLevelSpecs(samples.length, 4, 2);
    expect(levels.map((l) => ({ samplesPerBucket: l.samplesPerBucket, bucketCount: l.bucketCount }))).toEqual(expected);
  });

  it('tracks channels independently', () => {
    const builder = new PyramidBuilder(2, 4, 2);
    builder.push(0, Float32Array.from([1, 1, 1, 1]));
    builder.push(1, Float32Array.from([-1, -1, -1, -1]));
    const levels = builder.finish();
    expect(Array.from(levels[0].min[0])).toEqual([quantize(1)]);
    expect(Array.from(levels[0].max[0])).toEqual([quantize(1)]);
    expect(Array.from(levels[0].min[1])).toEqual([quantize(-1)]);
    expect(Array.from(levels[0].max[1])).toEqual([quantize(-1)]);
  });

  it('clamps samples outside [-1, 1] rather than overflowing the Int16 range', () => {
    const builder = new PyramidBuilder(1, 4, 2);
    builder.push(0, Float32Array.from([2.5, -3.0]));
    const levels = builder.finish();
    expect(levels[0].min[0][0]).toBe(-32767);
    expect(levels[0].max[0][0]).toBe(32767);
  });

  it('handles exactly one L0-sized push with no partial tail', () => {
    const builder = new PyramidBuilder(1, 4, 2);
    builder.push(0, Float32Array.from([0.1, 0.2, 0.3, 0.4]));
    const levels = builder.finish();
    expect(levels).toHaveLength(1);
    expect(levels[0].bucketCount).toBe(1);
  });

  it('accepts push() calls split across multiple chunks, folding correctly across the boundary', () => {
    const a = new PyramidBuilder(1, 4, 2);
    a.push(0, Float32Array.from([0.5, -0.25, 1.0, -1.0, 0.1, 0.2, 0.3, 0.4, -0.6, 0.9]));
    const wholePush = a.finish();

    const b = new PyramidBuilder(1, 4, 2);
    b.push(0, Float32Array.from([0.5, -0.25]));
    b.push(0, Float32Array.from([1.0, -1.0, 0.1]));
    b.push(0, Float32Array.from([0.2, 0.3, 0.4, -0.6, 0.9]));
    const splitPush = b.finish();

    expect(splitPush.map((l) => ({ min: Array.from(l.min[0]), max: Array.from(l.max[0]) }))).toEqual(
      wholePush.map((l) => ({ min: Array.from(l.min[0]), max: Array.from(l.max[0]) })),
    );
  });

  it('throws on push() after finish(), finish() called twice, or an out-of-range channel index', () => {
    const builder = new PyramidBuilder(1, 4, 2);
    builder.push(0, Float32Array.from([0.1]));
    builder.finish();
    expect(() => {
      builder.push(0, Float32Array.from([0.1]));
    }).toThrow();
    expect(() => builder.finish()).toThrow();

    const other = new PyramidBuilder(1, 4, 2);
    expect(() => {
      other.push(1, Float32Array.from([0.1]));
    }).toThrow();
    expect(() => {
      other.push(-1, Float32Array.from([0.1]));
    }).toThrow();
  });
});
