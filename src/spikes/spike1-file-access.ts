import { mountSpikeHarness } from './harness';

const CHUNK_SIZE = 64 * 1024 * 1024; // 64MB

mountSpikeHarness(
  document.getElementById('app')!,
  'spike1-file-access',
  'Stream a large local file in fixed-size chunks via File.slice()/arrayBuffer() without ever holding the whole file in memory. Question: does memory stay flat as file size grows past a few GB?',
  async (file, log) => {
    let offset = 0;
    let chunkCount = 0;
    while (offset < file.size) {
      const chunk = file.slice(offset, offset + CHUNK_SIZE);
      const buf = await chunk.arrayBuffer();
      offset += buf.byteLength;
      chunkCount += 1;
      if (chunkCount % 20 === 0) {
        log(`read ${(offset / 1e9).toFixed(2)} GB / ${(file.size / 1e9).toFixed(2)} GB`);
      }
    }
    return {
      metrics: { chunkCount, chunkSizeBytes: CHUNK_SIZE },
      notes: 'Sequential chunked read, no random access.',
    };
  },
);
