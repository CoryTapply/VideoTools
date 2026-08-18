import { describe, expect, it } from 'vitest';
import { FakeWaveformDecoder } from './FakeWaveformDecoder';
import type { DecodeAudioJob, DecodedAudioChunk, WaveformDecoderConfig } from './WaveformDecoder';

const config: WaveformDecoderConfig = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x12, 0x08]) };

function job(id: number, overrides: Partial<DecodeAudioJob> = {}): DecodeAudioJob {
  return { id, presentationTime: id * 1024, data: new Uint8Array([id]), ...overrides };
}

describe('FakeWaveformDecoder', () => {
  it('isConfigSupported defaults to true and reflects a boolean override', async () => {
    const supported = new FakeWaveformDecoder();
    expect(await supported.isConfigSupported(config)).toBe(true);
    const unsupported = new FakeWaveformDecoder({ supported: false });
    expect(await unsupported.isConfigSupported(config)).toBe(false);
  });

  it('isConfigSupported can be a function of the config', async () => {
    const decoder = new FakeWaveformDecoder({ supported: (c) => c.codec.startsWith('mp4a') });
    expect(await decoder.isConfigSupported(config)).toBe(true);
    expect(await decoder.isConfigSupported({ ...config, codec: 'opus' })).toBe(false);
  });

  it('throws if decodeBatch is called before configure', async () => {
    const decoder = new FakeWaveformDecoder();
    await expect(decoder.decodeBatch([job(0)], () => undefined)).rejects.toThrow(/before configure/);
  });

  it('invokes onChunk once per job, in submission order, with the configured channel/sample-rate shape', async () => {
    const decoder = new FakeWaveformDecoder({ framesPerJob: 8 });
    decoder.configure(config);
    const jobs = [job(0), job(1), job(2)];
    const seen: DecodedAudioChunk[] = [];
    const result = await decoder.decodeBatch(jobs, (chunk) => {
      seen.push(chunk);
    });
    expect(result.errors).toEqual([]);
    expect(seen).toHaveLength(3);
    expect(seen.every((c) => c.numberOfChannels === 2 && c.numberOfFrames === 8 && c.sampleRate === 48000)).toBe(true);
    expect(decoder.decodeCount).toBe(3);
  });

  it('closes every chunk immediately after onChunk returns, so nothing survives the call', async () => {
    const decoder = new FakeWaveformDecoder();
    decoder.configure(config);
    let capturedChunk: DecodedAudioChunk | undefined;
    await decoder.decodeBatch([job(0)], (chunk) => {
      const dest = new Float32Array(4);
      chunk.copyTo(dest, 0); // must not throw -- chunk is still open during the callback
      capturedChunk = chunk;
    });
    expect(() => capturedChunk?.copyTo(new Float32Array(4), 0)).toThrow(/after close/);
    expect(decoder.producedChunks.every((c) => c.closed)).toBe(true);
  });

  it('generateSample controls the exact copied-out sample values', async () => {
    const decoder = new FakeWaveformDecoder({ framesPerJob: 2, generateSample: (j, ch) => (ch === 0 ? j.id : -j.id) });
    decoder.configure(config);
    const captured: number[][] = [];
    await decoder.decodeBatch([job(3)], (chunk) => {
      const ch0 = new Float32Array(chunk.numberOfFrames);
      const ch1 = new Float32Array(chunk.numberOfFrames);
      chunk.copyTo(ch0, 0);
      chunk.copyTo(ch1, 1);
      captured.push([...ch0], [...ch1]);
    });
    expect(captured).toEqual([
      [3, 3],
      [-3, -3],
    ]);
  });

  it('a decode error stops the batch, reports the failing job, and does not call onChunk for it or anything after', async () => {
    const decoder = new FakeWaveformDecoder({ failOnJobId: 1 });
    decoder.configure(config);
    const seenIds: number[] = [];
    const result = await decoder.decodeBatch([job(0), job(1), job(2)], () => {
      seenIds.push(1);
    });
    expect(seenIds).toEqual([1]); // only job 0's callback fired
    expect(result.errors).toEqual([{ kind: 'decode-error', message: expect.any(String) as string, jobId: 1 }]);
    expect(decoder.closed).toBe(true);
  });

  it('is unusable after a decode error, matching real WebCodecs semantics', async () => {
    const decoder = new FakeWaveformDecoder({ failOnJobId: 0 });
    decoder.configure(config);
    await decoder.decodeBatch([job(0)], () => undefined);
    await expect(decoder.decodeBatch([job(1)], () => undefined)).rejects.toThrow(/after close/);
  });

  it('configure throws after close', () => {
    const decoder = new FakeWaveformDecoder();
    decoder.configure(config);
    decoder.close();
    expect(() => {
      decoder.configure(config);
    }).toThrow(/after close/);
  });

  it('respects latencyMs before resolving', async () => {
    const decoder = new FakeWaveformDecoder({ latencyMs: 20 });
    decoder.configure(config);
    const start = Date.now();
    await decoder.decodeBatch([job(0)], () => undefined);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it('closeCount tallies every close() call', () => {
    const decoder = new FakeWaveformDecoder();
    decoder.close();
    decoder.close();
    expect(decoder.closeCount).toBe(2);
  });
});
