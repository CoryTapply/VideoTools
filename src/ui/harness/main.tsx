import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTokenCssVariables } from '../tokens.css.ts';
import '../reset.css';
import { Harness } from './Harness.tsx';

applyTokenCssVariables();

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root not found');
}

createRoot(container).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
