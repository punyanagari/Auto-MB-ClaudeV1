import eslint from '@eslint/js';
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import security from 'eslint-plugin-security';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'local-data/**',
      'docs/reference/**',
      'packages/loa-parser/fixtures/**',
      // Harness-managed agent worktrees live inside the repo checkout;
      // linting them double-lints foreign checkouts and fails on files
      // outside the project service.
      '.claude/**',
      // Local render/test artefacts and the Windows runtime shim are
      // intentionally outside the product TypeScript projects.
      'tmp/**',
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
    /* Accessibility rules that read the JSX, so they answer for every
     * screen — including the thirty-odd the browser gate never opens.
     *
     * `strict` rather than `recommended`, because the difference between
     * them is exactly this product's failure mode: `recommended` downgrades
     * or drops the rules about interactive elements that are not really
     * interactive, and this tree grew a modal out of two swapped buttons
     * and a tablist that listened for no key. The strict set is clean here,
     * so there is no baseline to freeze and no warning to learn to ignore
     * — `pnpm lint` runs with `--max-warnings 0` and every rule below is an
     * error.
     *
     * Scoped to the web app: it is the only package with JSX, and pointing
     * the plugin at the server would only invite someone to satisfy it
     * there. */
    files: ['apps/web/**/*.tsx'],
    extends: [jsxA11y.flatConfigs.strict],
  },
  {
    /* The one exemption, and the whole baseline.
     *
     * `no-autofocus` is right about the general case — an autofocused
     * control moves a screen-reader user somewhere they did not ask to go
     * and skips whatever was above it. Three fields in the sign-in flow
     * are the case the rule's own documentation calls out as legitimate:
     * each is the SOLE field of a step the operator has just deliberately
     * advanced into — the 2FA code after a correct password, the address on
     * the reset form, the new password after following the emailed link.
     * There is nothing above them to skip and nowhere else on the step to
     * be, and the alternative (an effect that calls focus()) is the same
     * behaviour written less honestly.
     *
     * Scoped to the file rather than switched off, so a fourth autofocus
     * anywhere else in the product still fails the build. */
    files: ['apps/web/src/views/SignIn.tsx'],
    rules: { 'jsx-a11y/no-autofocus': 'off' },
  },
  {
    /* The second and last exemption.
     *
     * `no-noninteractive-element-interactions` classes `role="dialog"` as
     * non-interactive and therefore refuses it a key handler. For a modal
     * that is backwards: owning the keyboard is what makes it modal — the
     * surface is where Escape closes and where Tab is cycled, and there is
     * nowhere else to put either, because focus never leaves it while it
     * is open. The eventual answer is `<dialog showModal()>`, which the
     * browser wires up itself; jsdom 30 does not implement it, so adopting
     * it now would mean the component suites test a polyfill. Scoped to the
     * one primitive, so every other file still answers to the rule. */
    files: ['apps/web/src/ui/dialog.tsx'],
    rules: { 'jsx-a11y/no-noninteractive-element-interactions': 'off' },
  },
  {
    /* The third and last exemption, and the one where two checkers
     * disagree outright.
     *
     * `no-noninteractive-tabindex` says a region must not be focusable.
     * axe's `scrollable-region-focusable` — which the browser gate runs and
     * WCAG technique SCR34 backs — says a box that scrolls MUST be, because
     * a keyboard has no other way to move it. axe is right for a ledger
     * whose widest columns are off-screen, so the register keeps its tab
     * stop. It is granted only while the box actually overflows, which is
     * the half the lint rule is right about: a stop that scrolls nothing is
     * noise, and this component renders up to a dozen per screen. */
    files: ['apps/web/src/ui/table.tsx'],
    rules: { 'jsx-a11y/no-noninteractive-tabindex': 'off' },
  },
  {
    // The parser's corpus-tested extraction regexes trip the static ReDoS
    // heuristic, and its value comparisons trip the timing-attack heuristic;
    // neither guards secrets. Text from uploaded LOA PDFs DOES reach these
    // regexes (routes/loa.ts runs reviewLoaLetter on extracted upload text
    // after magic-byte, size, and malware validation), so this exemption
    // rests on review of the regexes and the corpus tests, not on input
    // provenance. Disclosed in docs/SECURITY.md ("Narrowed lint ruleset");
    // re-audit the regexes if the extraction grammar grows.
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
    // keeps full type-aware linting. scripts/*.ts entry points stay thin
    // shells over package code that IS type-checked (e.g. import-v1.ts
    // delegates to apps/server/src/import/cli.ts).
    files: [
      '**/*.config.{js,ts,mjs}',
      'eslint.config.js',
      // Both the repository-wide scripts and a package's own build-output
      // checks (apps/web/scripts/check-bundle-size.mjs): none of them are
      // in any package tsconfig, because none of them are shipped code.
      '**/scripts/**/*.mjs',
      'scripts/**/*.ts',
    ],
    ignores: ['apps/web/vite.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
