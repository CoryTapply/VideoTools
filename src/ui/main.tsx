import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { applyTokenCssVariables } from './tokens.css.ts';
import './reset.css';

applyTokenCssVariables();

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
