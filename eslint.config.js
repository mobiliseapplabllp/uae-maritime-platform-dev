// ESLint 9 flat configuration for the whole workspace: TypeScript everywhere, React
// and hook rules for the web application, Node rules for the services and packages.
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');

const TS = ['**/*.ts', '**/*.tsx'];

module.exports = tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/.turbo/**',
      '**/*.d.ts',
      '**/*.mjs',
      'apps/web/public/**',
      'apps/mobile/**',
      'infra/**',
    ],
  },

  // Baseline: correctness rules on every TypeScript and TSX file in the workspace.
  {
    files: TS,
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // TypeScript resolves identifiers itself; the core rule only produces false positives here.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // Style preferences that carry no correctness signal in this codebase.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description' }],
    },
  },

  // Web application: React components and hooks.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // The browser console is a genuine escape hatch in the shell error boundaries.
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // Services, shared packages and build tools run on Node.
  {
    files: ['services/**/*.ts', 'packages/**/*.ts', 'tools/**/*.ts'],
    rules: {
      'no-process-exit': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Tests and local scripts: fixtures need latitude the production code does not.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.{ts,tsx}', '**/e2e/**/*.ts', '**/scripts/**/*.ts', '**/seed.ts', '**/migrate.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
