import { FlatCompat } from '@eslint/eslintrc'
import js from '@eslint/js'
import globals from 'globals'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
})

export default [
  {
    ignores: [
      '**/.eslintrc.js',
      '**/node_modules',
      '**/dist',
      '**/build',
      '**/coverage',
      '**/generated/types.d.ts',
      '**/generated/types.ts',
      '**/.idea',
      '**/.vscode',
      '**/gql',
    ],
  },
  ...compat.extends('@makerx/eslint-config'),
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
]
