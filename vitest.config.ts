import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, which wires up the spikes' browser HTML entry
// points -- irrelevant to (and not loadable by) the Node-side test run.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/media/index/**/*.test.ts', 'src/media/playback/**/*.test.ts', 'src/media/frames/**/*.test.ts'],
    globals: false,
  },
});
