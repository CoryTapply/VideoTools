import { mountSpikeHarness } from './harness';

const SEEK_COUNT = 10;

mountSpikeHarness(
  document.getElementById('app')!,
  'spike3-seek-preview',
  'Load the file into an HTMLVideoElement via a blob URL and perform random seeks, capturing a frame at each via createImageBitmap. Tests scrub-preview feasibility and per-seek latency/memory without a WebCodecs demuxer -- especially against the long-GOP and VFR fixtures.',
  async (file, log) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;

    await new Promise<void>((resolve, reject) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(video.error), { once: true });
    });
    log(`duration=${video.duration.toFixed(1)}s`);

    const seekTimesMs: number[] = [];
    for (let i = 0; i < SEEK_COUNT; i += 1) {
      const target = Math.random() * video.duration;
      const t0 = performance.now();
      await new Promise<void>((resolve) => {
        video.addEventListener('seeked', () => resolve(), { once: true });
        video.currentTime = target;
      });
      const bitmap = await createImageBitmap(video);
      bitmap.close();
      seekTimesMs.push(performance.now() - t0);
      log(`seek ${i + 1}/${SEEK_COUNT} to ${target.toFixed(1)}s took ${seekTimesMs[i]!.toFixed(0)}ms`);
    }

    URL.revokeObjectURL(url);
    const avgSeekMs = seekTimesMs.reduce((a, b) => a + b, 0) / seekTimesMs.length;
    return { metrics: { seekCount: SEEK_COUNT, avgSeekMs, seekTimesMs, durationSec: video.duration } };
  },
);
