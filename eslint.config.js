// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // `.remember/` is scratch state written by a local tooling plugin, not project source.
    // `web/` is a standalone Next.js package with its own eslint.config.mjs and tsconfig — a
    // separate project, not source this config's TS project service knows about (ADR-0042).
    // `local-data/` is the gitignored working directory this system writes evidence, a dev
    // database and local scratch into (`security-model.md`). Nothing there is project source,
    // and linting it would mean the TS project service reaching into a directory that exists
    // precisely so real financial data never enters the repository.
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.remember/**',
      'drizzle/**',
      'local-data/**',
      'web/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Financial arithmetic must never rely on implicit numeric coercion.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  eslintConfigPrettier,
);
