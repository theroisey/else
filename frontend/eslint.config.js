import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage', '.vitest'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
    },
  },
  { files: ['eslint.config.js'], languageOptions: { globals: globals.node } },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/lib/validation.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['zod', 'zod/*'], message: 'Use lib/validation so every schema follows the runtime CSP configuration.' }] }],
    },
  },
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
)
