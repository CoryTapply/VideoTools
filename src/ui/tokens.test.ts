import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { color, motion, radius, rowHeight, shadow, spacing, type } from './tokens.ts';

const UI_ROOT = new URL('.', import.meta.url).pathname;
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.css']);
// tokens.ts/tokens.css.ts are the sole permitted hex-literal source; this file is excluded
// because its own hygiene-rule test below asserts against literal hex values on purpose.
const EXCLUDED_FILES = new Set(['tokens.ts', 'tokens.css.ts', 'tokens.test.ts']);
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/g;

function collectScannedFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectScannedFiles(full));
    } else if (SCANNED_EXTENSIONS.has(extname(entry)) && !EXCLUDED_FILES.has(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe('tokens', () => {
  it('every token group is populated', () => {
    expect(Object.keys(color).length).toBeGreaterThan(0);
    expect(type.size.length).toBeGreaterThan(0);
    expect(spacing.length).toBeGreaterThan(0);
    expect(radius.length).toBeGreaterThan(0);
    expect(Object.keys(rowHeight).length).toBeGreaterThan(0);
    expect(Object.keys(shadow).length).toBeGreaterThan(0);
    expect(Object.keys(motion).length).toBeGreaterThan(0);
  });

  it('every color value is a hex literal or an rgba() built from one', () => {
    for (const value of Object.values(color)) {
      expect(value).toMatch(/^(#[0-9a-fA-F]{3,8}|rgba\(\d+,\d+,\d+,[\d.]+\))$/);
    }
  });

  it('no hex color literal appears anywhere in src/ui/ outside tokens.ts/tokens.css.ts', () => {
    const offenders: string[] = [];
    for (const file of collectScannedFiles(UI_ROOT)) {
      const matches = readFileSync(file, 'utf8').match(HEX_LITERAL);
      if (matches) {
        offenders.push(`${file}: ${matches.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
