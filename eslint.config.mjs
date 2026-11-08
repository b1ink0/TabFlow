import js from '@eslint/js';
import ts from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import prettier from 'eslint-config-prettier';

export default ts.config(
  {
    ignores: [
      'node_modules/**',
      '.output/**',
      '.wxt/**',
      'extension/**',
      'artifacts/**',
      'local-docs/**',
      'ready-to-load/**',
      'tests/browser-profile/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...vue.configs['flat/recommended'],
  { files: ['**/*.vue'], languageOptions: { parserOptions: { parser: ts.parser } } },
  {
    files: ['**/*.{ts,vue}'],
    rules: {
      'no-undef': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    files: ['scripts/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        chrome: 'readonly',
        window: 'readonly',
        document: 'readonly',
        innerWidth: 'readonly',
        structuredClone: 'readonly',
      },
    },
  },
  prettier,
);
