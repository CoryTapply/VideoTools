import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // src/spikes/ is explicitly out of scope for this task's lint rules: it
    // uses non-null assertions throughout and must not be modified.
    ignores: ['dist/**', 'src/spikes/**'],
  },
  js.configs.recommended,
  // Type-aware rules need parserOptions.project, which only resolves for files under
  // tsconfig.json's own `include` (src/**) -- root-level tooling configs (vite.config.ts,
  // eslint.config.js, ...) are intentionally left to js.configs.recommended only.
  ...tseslint.configs.strictTypeChecked.map((config) => ({ ...config, files: config.files ?? ['src/**/*.ts'] })),
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/media/index/**/*.ts', 'src/media/playback/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
    },
  },
);
