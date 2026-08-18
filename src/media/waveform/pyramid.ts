// The pure reduction math behind the peak pyramid -- zero WebCodecs dependency, the highest-value
// test target in this module (see pyramid.test.ts). Min/max envelope per channel, quantized to
// Int16, at multiple resolutions ("levels") -- level 0 is samplesPerBucket=L0 (raw samples per
// bucket), each level above it covers `ratio` times as many raw samples as the one below, folded
// FROM the level below's own (already-quantized) bucket outputs, never by re-scanning raw samples.
//
// Level 0 is the only level built incrementally, during push() -- it's the one that has to be, to
// keep memory O(1) per raw sample regardless of file length (never buffering the AudioData/raw
// float32 stream itself, which is the whole point of this class existing -- see this module's
// README for why that's the ~5.5GB mistake the roadmap warns against). Level 0's OWN output,
// though, is already ~L0x smaller than raw audio (128x by default) and comfortably fits in memory
// for any real file (see README's size math) -- so every level ABOVE level 0 is built once, in
// finish(), as a plain non-incremental fold over level 0's completed array. This was originally
// attempted as a fully incremental cascade (every level folding into the next live, during push())
// but that design has a genuine bug: a level whose data all fits in exactly one bucket has no way
// to know, AT PUSH TIME, whether more data folding into it is still coming later -- eagerly
// creating a parent for it can end up wrapping a lonely single bucket in another lonely single
// bucket forever, an unbounded level chain with no terminating condition (caught by a real OOM
// crash in testing, not a hypothetical). Building levels 1+ only after finish() -- when the total
// is finally known for certain -- has no such ambiguity: buildLevelSpecs()'s ceil(bucketCount /
// ratio) recurrence, applied directly to the already-known level-below array, terminates exactly
// when a level's own bucketCount reaches 1, by construction.
//
// buildLevelSpecs() below is the same math as a STANDALONE pure function, used for size-estimation
// (see README.md) and to cross-check PyramidBuilder's real output against the closed-form ceiling
// arithmetic in tests.

/** Default per this module's pyramid design: ~2.7ms/bucket @48kHz at level 0, matched to the timeline's max zoom (a video frame is already the smallest addressable unit at that zoom, so sub-frame audio precision has no consumer). */
export const DEFAULT_L0_SAMPLES_PER_BUCKET = 128;
/** Default fold ratio between adjacent levels. */
export const DEFAULT_RATIO = 8;

/** Quantization scale: a stored bucket value v represents a normalized float sample of v / PEAK_INT16_MAX. Exported so WaveformCache.getRange() can de-quantize back to [-1, 1] without duplicating the constant. */
export const PEAK_INT16_MAX = 32767;
const INT16_MIN = -PEAK_INT16_MAX;

export interface PyramidLevelSpec {
  readonly samplesPerBucket: number;
  readonly bucketCount: number;
}

/**
 * Closed-form level table for a known total sample count: level 0 has `ceil(sampleCount / l0)`
 * buckets of `l0` raw samples each; each level above multiplies samplesPerBucket by `ratio` and
 * recomputes bucketCount directly from `sampleCount`, terminating once a level's own bucketCount
 * reaches 1 (nothing left to fold further). Returns an empty array for `sampleCount <= 0`.
 */
export function buildLevelSpecs(sampleCount: number, l0 = DEFAULT_L0_SAMPLES_PER_BUCKET, ratio = DEFAULT_RATIO): PyramidLevelSpec[] {
  if (sampleCount <= 0) return [];
  const specs: PyramidLevelSpec[] = [];
  let samplesPerBucket = l0;
  for (;;) {
    const bucketCount = Math.ceil(sampleCount / samplesPerBucket);
    specs.push({ samplesPerBucket, bucketCount });
    if (bucketCount <= 1) break;
    samplesPerBucket *= ratio;
  }
  return specs;
}

/** Total pyramid bytes (all levels, all channels): 2 bytes (Int16) x 2 (min+max) x bucketCount x channelCount, summed over levels. Used by README.md's size math and by tests cross-checking real PyramidBuilder output against this closed form. */
export function estimatePyramidBytes(sampleCount: number, channelCount: number, l0 = DEFAULT_L0_SAMPLES_PER_BUCKET, ratio = DEFAULT_RATIO): number {
  const specs = buildLevelSpecs(sampleCount, l0, ratio);
  let total = 0;
  for (const spec of specs) total += spec.bucketCount * channelCount * 2 * 2;
  return total;
}

/** One quantized level's output: per channel, in channel order, arrays the same length (`bucketCount`). */
export interface PyramidLevel {
  readonly samplesPerBucket: number;
  readonly bucketCount: number;
  readonly min: readonly Int16Array[];
  readonly max: readonly Int16Array[];
}

function quantize(sample: number): number {
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return Math.round(clamped * PEAK_INT16_MAX);
}

interface RawAccumulator {
  min: number;
  max: number;
  count: number;
}

function freshAccumulator(): RawAccumulator {
  return { min: Infinity, max: -Infinity, count: 0 };
}

/**
 * Incremental min/max reducer over raw audio samples: push() one channel's Float32 samples at a
 * time (channels must each receive the same total sample count, in the same order -- true
 * whenever every push for one span comes from the same decoded AudioData's per-channel planes,
 * which is this module's only real caller, see RealWaveformDecoder.ts), finish() flushes level
 * 0's final partial bucket, derives every level above it, and returns the completed pyramid.
 */
export class PyramidBuilder {
  private readonly channelCount: number;
  private readonly l0: number;
  private readonly ratio: number;
  private readonly acc: RawAccumulator[]; // per channel, level-0 in-progress bucket
  private readonly l0Min: number[][]; // per channel, growable
  private readonly l0Max: number[][];
  private finished = false;

  constructor(channelCount: number, l0 = DEFAULT_L0_SAMPLES_PER_BUCKET, ratio = DEFAULT_RATIO) {
    if (channelCount <= 0) throw new Error('PyramidBuilder: channelCount must be >= 1');
    if (l0 <= 0 || ratio <= 1) throw new Error('PyramidBuilder: l0 must be >= 1 and ratio must be > 1');
    this.channelCount = channelCount;
    this.l0 = l0;
    this.ratio = ratio;
    this.acc = Array.from({ length: channelCount }, freshAccumulator);
    this.l0Min = Array.from({ length: channelCount }, () => []);
    this.l0Max = Array.from({ length: channelCount }, () => []);
  }

  push(channelIndex: number, samples: Float32Array | readonly number[]): void {
    if (this.finished) throw new Error('PyramidBuilder: push() after finish()');
    if (channelIndex < 0 || channelIndex >= this.channelCount) throw new Error(`PyramidBuilder: channelIndex ${String(channelIndex)} out of range [0, ${String(this.channelCount)})`);
    const acc = this.acc[channelIndex];
    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i];
      if (sample < acc.min) acc.min = sample;
      if (sample > acc.max) acc.max = sample;
      acc.count += 1;
      if (acc.count === this.l0) this.flushLevel0Bucket(channelIndex);
    }
  }

  private flushLevel0Bucket(channelIndex: number): void {
    const acc = this.acc[channelIndex];
    if (acc.count === 0) return;
    this.l0Min[channelIndex].push(quantize(acc.min));
    this.l0Max[channelIndex].push(quantize(acc.max));
    acc.min = Infinity;
    acc.max = -Infinity;
    acc.count = 0;
  }

  /** Flushes level 0's remaining partial bucket (the file's tail is rarely an exact multiple of `l0`), then folds level 0's completed array upward, one level at a time, until a level's own bucketCount reaches 1. Idempotent to call at most once -- push() throws after this. */
  finish(): PyramidLevel[] {
    if (this.finished) throw new Error('PyramidBuilder: finish() called twice');
    this.finished = true;
    for (let ch = 0; ch < this.channelCount; ch += 1) this.flushLevel0Bucket(ch);

    const level0BucketCount = this.l0Min[0].length;
    if (level0BucketCount === 0) return [];

    const levels: PyramidLevel[] = [
      {
        samplesPerBucket: this.l0,
        bucketCount: level0BucketCount,
        min: this.l0Min.map((arr) => Int16Array.from(arr)),
        max: this.l0Max.map((arr) => Int16Array.from(arr)),
      },
    ];

    while (levels[levels.length - 1].bucketCount > 1) {
      levels.push(this.foldLevel(levels[levels.length - 1]));
    }
    return levels;
  }

  private foldLevel(prev: PyramidLevel): PyramidLevel {
    const bucketCount = Math.ceil(prev.bucketCount / this.ratio);
    const min: Int16Array[] = [];
    const max: Int16Array[] = [];
    for (let ch = 0; ch < this.channelCount; ch += 1) {
      const chMin = new Int16Array(bucketCount);
      const chMax = new Int16Array(bucketCount);
      for (let b = 0; b < bucketCount; b += 1) {
        const start = b * this.ratio;
        const end = Math.min(start + this.ratio, prev.bucketCount);
        let lo = PEAK_INT16_MAX;
        let hi = INT16_MIN;
        for (let i = start; i < end; i += 1) {
          const prevMin = prev.min[ch][i];
          const prevMax = prev.max[ch][i];
          if (prevMin < lo) lo = prevMin;
          if (prevMax > hi) hi = prevMax;
        }
        chMin[b] = lo;
        chMax[b] = hi;
      }
      min.push(chMin);
      max.push(chMax);
    }
    return { samplesPerBucket: prev.samplesPerBucket * this.ratio, bucketCount, min, max };
  }
}
