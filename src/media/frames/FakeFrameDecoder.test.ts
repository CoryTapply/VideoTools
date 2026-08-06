import { describe, expect, it } from 'vitest';
import { FakeFrameDecoder } from './FakeFrameDecoder';
import type { DecodeJob, FrameDecoderConfig } from './FrameDecoder';

const config: FrameDecoderConfig = { codec: 'avc1.640034', codedWidth: 3840, codedHeight: 2160, description: new Uint8Array([1, 2, 3]) };
const size = { width: 160, height: 90 };

function job(id: number, overrides: Partial<DecodeJob> = {}): DecodeJob {
  return { id, presentationTime: id * 1000, data: new Uint8Array([id]), type: id === 0 ? 'key' : 'delta', keep: true, ...overrides };
}

describe('FakeFrameDecoder', () => {
  it('isConfigSupported defaults to true and reflects a boolean override', async () => {
    const supported = new FakeFrameDecoder();
    expect(await supported.isConfigSupported(config)).toBe(true);
    const unsupported = new FakeFrameDecoder({ supported: false });
    expect(await unsupported.isConfigSupported(config)).toBe(false);
  });

  it('isConfigSupported can be a function of the config', async () => {
    const decoder = new FakeFrameDecoder({ supported: (c) => c.codec.startsWith('avc1') });
    expect(await decoder.isConfigSupported(config)).toBe(true);
    expect(await decoder.isConfigSupported({ ...config, codec: 'hvc1.1.6.L93.B0' })).toBe(false);
  });

  it('throws if decodeBatch is called before configure', async () => {
    const decoder = new FakeFrameDecoder();
    await expect(decoder.decodeBatch([job(0)], size)).rejects.toThrow(/before configure/);
  });

  it('produces one bitmap per kept job, none for unkept jobs, in submission order', async () => {
    const decoder = new FakeFrameDecoder();
    decoder.configure(config);
    const jobs = [job(0, { keep: true }), job(1, { keep: false }), job(2, { keep: true })];
    const result = await decoder.decodeBatch(jobs, size);
    expect(result.errors).toEqual([]);
    expect(result.thumbnails.map((t) => t.id)).toEqual([0, 2]);
    expect(result.thumbnails.every((t) => t.bitmap.width === 160 && t.bitmap.height === 90)).toBe(true);
    expect(decoder.decodeCount).toBe(3);
  });

  it('a decode error stops the batch, reports the failing job, and leaves earlier kept jobs intact', async () => {
    const decoder = new FakeFrameDecoder({ failOnJobId: 1 });
    decoder.configure(config);
    const jobs = [job(0, { keep: true }), job(1, { keep: true }), job(2, { keep: true })];
    const result = await decoder.decodeBatch(jobs, size);
    expect(result.thumbnails.map((t) => t.id)).toEqual([0]);
    expect(result.errors).toEqual([{ kind: 'decode-error', message: expect.any(String) as string, jobId: 1 }]);
    expect(decoder.closed).toBe(true);
  });

  it('is unusable after a decode error, matching real WebCodecs semantics', async () => {
    const decoder = new FakeFrameDecoder({ failOnJobId: 0 });
    decoder.configure(config);
    await decoder.decodeBatch([job(0)], size);
    await expect(decoder.decodeBatch([job(1)], size)).rejects.toThrow(/after close/);
  });

  it('configure throws after close', () => {
    const decoder = new FakeFrameDecoder();
    decoder.configure(config);
    decoder.close();
    expect(() => {
      decoder.configure(config);
    }).toThrow(/after close/);
  });

  it('respects latencyMs before resolving', async () => {
    const decoder = new FakeFrameDecoder({ latencyMs: 20 });
    decoder.configure(config);
    const start = Date.now();
    await decoder.decodeBatch([job(0)], size);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it('closeCount tallies every close() call', () => {
    const decoder = new FakeFrameDecoder();
    decoder.close();
    decoder.close();
    expect(decoder.closeCount).toBe(2);
  });
});
