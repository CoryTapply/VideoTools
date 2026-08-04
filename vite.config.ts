import { defineConfig } from 'vite';

// Toggle via `npm run dev:coi`. Needed for performance.measureUserAgentSpecificMemory();
// `credentialless` (not `require-corp`) avoids needing CORP headers on local fixture files.
const coiEnabled = process.env.COI === '1';

export default defineConfig({
  server: {
    headers: coiEnabled
      ? {
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'credentialless',
        }
      : {},
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        spike1: 'spike1-file-access.html',
        spike2: 'spike2-mp4-parse.html',
        spike3: 'spike3-seek-preview.html',
        spike4: 'spike4-remux-trim.html',
        spikeA: 'A-remux.html',
        spikeB: 'B-index.html',
        spikeC: 'C-decode.html',
        t0: 'T0-exportcost.html',
        mediaIndex: 'media-index.html',
      },
    },
  },
});
