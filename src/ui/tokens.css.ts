import { color } from './tokens.ts';

function toKebabCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// Mirrors tokens.ts's `color` object onto :root as CSS custom properties, so plain CSS files can
// reference `var(--color-bg-base)` etc. without ever writing a hex literal themselves. Called
// once, before the first render.
export function applyTokenCssVariables(root: HTMLElement = document.documentElement): void {
  for (const [key, value] of Object.entries(color)) {
    root.style.setProperty(`--color-${toKebabCase(key)}`, value);
  }
}
