// Differential test against the spike parser (src/spikes/A-remux/mp4-index.ts), per task spec §8.
// Cheap and in-process (no mediabunny needed) -- this is what catches a regression in the rewrite
// itself, since both implementations parse the exact same bytes independently.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMp4Index } from '../../spikes/A-remux/mp4-index';
import { buildIndex } from './build-index';
import { BufferByteSource } from './sources/buffer-byte-source';

const FIXTURE_PATH = path.join(__dirname, '__fixtures__', 'tiny.mp4');

describe('differential: rewrite vs spike parser (tiny.mp4)', () => {
  const bytes = readFileSync(FIXTURE_PATH);
  const uint8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  it('agrees on track presence, sample counts, and every sample field', async () => {
    const ours = await buildIndex(new BufferByteSource(uint8));
    expect(ours.ok).toBe(true);
    if (!ours.ok) return;

    // Node has a spec-compliant global File/Blob (stable since Node 20), so the spike parser --
    // written against the browser File API -- can be driven directly here with no shim.
    const file = new File([uint8], 'tiny.mp4');
    const spike = await buildMp4Index(file);

    expect(ours.tracks).toHaveLength(spike.tracks.length);

    for (const ourTrack of ours.tracks) {
      const spikeTrack = spike.tracks.find((t) => t.trackId === ourTrack.trackId);
      expect(spikeTrack, `track ${String(ourTrack.trackId)} missing from spike parser`).toBeDefined();
      if (!spikeTrack) continue;

      if (ourTrack.kind === 'other') continue; // spike has no concept of 'other'; nothing to compare

      const disagreements: string[] = [];
      if (ourTrack.sampleCount !== spikeTrack.sampleCount) {
        disagreements.push(`sampleCount: ours=${String(ourTrack.sampleCount)} spike=${String(spikeTrack.sampleCount)}`);
      }
      const n = Math.min(ourTrack.sampleCount, spikeTrack.sampleCount);
      for (let i = 0; i < n; i += 1) {
        if (ourTrack.pts[i] !== spikeTrack.cts[i]) disagreements.push(`pts[${String(i)}]: ours=${String(ourTrack.pts[i])} spike=${String(spikeTrack.cts[i])}`);
        if (ourTrack.dts[i] !== spikeTrack.dts[i]) disagreements.push(`dts[${String(i)}]: ours=${String(ourTrack.dts[i])} spike=${String(spikeTrack.dts[i])}`);
        if (ourTrack.offset[i] !== spikeTrack.offset[i]) disagreements.push(`offset[${String(i)}]: ours=${String(ourTrack.offset[i])} spike=${String(spikeTrack.offset[i])}`);
        if (ourTrack.size[i] !== spikeTrack.size[i]) disagreements.push(`size[${String(i)}]: ours=${String(ourTrack.size[i])} spike=${String(spikeTrack.size[i])}`);
        if (ourTrack.isSync[i] !== spikeTrack.sync[i]) disagreements.push(`isSync[${String(i)}]: ours=${String(ourTrack.isSync[i])} spike=${String(spikeTrack.sync[i])}`);
      }

      if (disagreements.length > 0) {
        console.warn(`track ${String(ourTrack.trackId)} disagreements:\n${disagreements.join('\n')}`);
      }
      expect(disagreements).toEqual([]);
    }
  });
});
