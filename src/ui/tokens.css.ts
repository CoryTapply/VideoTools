import { color, shadow } from './tokens.ts';

function toKebabCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// Mirrors tokens.ts's `color` and `shadow` objects onto :root as CSS custom properties, so plain
// CSS files can reference `var(--color-bg-base)` / `var(--shadow-panel)` etc. without ever writing
// a color literal themselves. Called once, before the first render.
export function applyTokenCssVariables(root: HTMLElement = document.documentElement): void {
  for (const [key, value] of Object.entries(color)) {
    root.style.setProperty(`--color-${toKebabCase(key)}`, value);
  }
  for (const [key, value] of Object.entries(shadow)) {
    root.style.setProperty(`--shadow-${toKebabCase(key)}`, value);
  }
}
