import { mountSpikeHarness } from './harness';

const SLICE_BYTES = 500 * 1024 * 1024; // ~500MB, big enough to be representative of a real cut

mountSpikeHarness(
  document.getElementById('app')!,
  'spike4-remux-trim',
  "Byte-range 'cut': slice a chunk out of the middle of the file and assemble it into a downloadable Blob, without touching MP4 metadata. Measures whether stream-copy-style trimming is cheap at the Blob layer. The output is NOT a valid playable file -- a real trim must also rewrite moov's sample tables (stco/co64, stsz, stts) to match, which is the open question this spike is meant to surface.",
  async (file, log) => {
    const start = Math.floor(file.size * 0.3);
    const end = Math.min(file.size, start + SLICE_BYTES);
    log(`slicing bytes ${start}..${end} (${((end - start) / 1e6).toFixed(0)} MB)`);

    const slice = file.slice(start, end);
    const blob = new Blob([slice], { type: file.type || 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trim-sample-${file.name}`;
    a.click();
    URL.revokeObjectURL(url);

    return {
      metrics: { sliceBytes: end - start },
      notes: 'Output is a raw byte slice, not a valid container -- timing/memory only.',
    };
  },
);
