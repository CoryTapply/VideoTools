import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    // src/spikes/ is explicitly out of scope for this task's lint rules: it
    // uses non-null assertions throughout and must not be modified.
    // design/reference/ is generated output (dc-runtime build artifacts), not app source --
    // see the "GENERATED ... do not edit" header in design/reference/support.js.
    ignores: ['dist/**', 'src/spikes/**', 'design/reference/**'],
  },
  js.configs.recommended,
  // Type-aware rules need parserOptions.project, which only resolves for files under
  // tsconfig.json's own `include` (src/**) -- root-level tooling configs (vite.config.ts,
  // eslint.config.js, ...) are intentionally left to js.configs.recommended only.
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: config.files ?? ['src/**/*.ts', 'src/**/*.tsx'],
  })),
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
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
  {
    files: ['src/ui/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
);
