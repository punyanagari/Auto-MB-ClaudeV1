import eslint from '@eslint/js';
import globals from 'globals';
import security from 'eslint-plugin-security';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'docs/reference/**',
      'packages/loa-parser/fixtures/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  security.configs.recommended,
  {
    rules: {
      // Fires on every computed member access; with strict TypeScript and
      // noUncheckedIndexedAccess the signal is almost entirely noise.
      'security/detect-object-injection': 'off',
      // The migration runner and tests legitimately read paths built at
      // runtime from repository-controlled directories.
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The parser's corpus-tested extraction regexes trip the static ReDoS
    // heuristic, and its value comparisons trip the timing-attack heuristic;
    // neither guards secrets. Re-evaluate this exemption before untrusted
    // LOA text (uploads) reaches the parser — today only pinned fixtures do.
    files: ['packages/loa-parser/**'],
    rules: {
      'security/detect-unsafe-regex': 'off',
      'security/detect-possible-timing-attacks': 'off',
      // Parser regexes are composed from module-internal constants, never
      // from parsed input.
      'security/detect-non-literal-regexp': 'off',
    },
  },
  {
    // Standalone config and script files that sit outside every package
    // tsconfig, so the type-aware project service cannot parse them.
    // apps/web/vite.config.ts is excluded: its tsconfig includes it, so it
    // keeps full type-aware linting.
    files: ['**/*.config.{js,ts,mjs}', 'eslint.config.js', 'scripts/**/*.mjs'],
    ignores: ['apps/web/vite.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
