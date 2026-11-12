/**
 * Shared ESLint flat config for the Fibrex monorepo.
 *
 * Purpose: one lint policy for every package: typescript-eslint strict type-checked rules,
 * the local `fibrex/module-boundaries` rule (SPEC 2.13), and a ban on `eval`-like constructs
 * (CLAUDE.md: formulas never use eval).
 * Depends on: typescript-eslint, @eslint/js, globals, ./rules/module-boundaries.js.
 * Used by: the root eslint.config.js.
 */
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { moduleBoundaries } from './rules/module-boundaries.js';

const fibrexPlugin = { rules: { 'module-boundaries': moduleBoundaries } };

/**
 * Builds the flat config.
 * @param {{ tsconfigRootDir: string }} options  absolute path of the repository root
 */
export function fibrex({ tsconfigRootDir }) {
  return defineConfig(
    globalIgnores([
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/generated/**',
      'reference/**',
      'docs/**',
    ]),
    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        globals: { ...globals.node },
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      plugins: { fibrex: fibrexPlugin },
      rules: {
        'fibrex/module-boundaries': 'error',
        'no-eval': 'error',
        'no-implied-eval': 'off',
        '@typescript-eslint/no-implied-eval': 'error',
        'no-new-func': 'error',
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
        '@typescript-eslint/consistent-type-imports': 'error',
      },
    },
    {
      // Plain JS config files are not part of any tsconfig project.
      files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
      extends: [tseslint.configs.disableTypeChecked],
    },
  );
}
