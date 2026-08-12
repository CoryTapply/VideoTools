import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { shuttleTuning } from './state/shuttle.ts';
import { kineticPanTuning } from './timeline/kinetic-pan.ts';
import { applyTokenCssVariables } from './tokens.css.ts';
import './reset.css';

applyTokenCssVariables();

// Task 4c: dev-only feel-check hook -- lets a real-hardware session retune kinetic-pan friction
// and shuttle acceleration live in devtools console (e.g.
// `window.__tuning.kineticPan.coastFrictionPerFrame = 0.9`) without a rebuild per value tried.
// Dead-code-eliminated from production builds by Vite.
if (import.meta.env.DEV) {
  (window as unknown as { __tuning: { kineticPan: typeof kineticPanTuning; shuttle: typeof shuttleTuning } }).__tuning = {
    kineticPan: kineticPanTuning,
    shuttle: shuttleTuning,
  };
}

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
