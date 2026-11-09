import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const infrastructureImports = {
  group: [
    'fastify',
    'fastify/**',
    'socket.io',
    'socket.io/**',
    'pg',
    'pg/**',
    '**/transport/**',
    '**/persistence/**',
  ],
  message: 'Keep framework and persistence adapters outside application/domain code.',
};

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', '.agents/**', '.codex/**', '.aws/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'error' },
  },
  {
    files: ['src/application/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [infrastructureImports] }] },
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            infrastructureImports,
            {
              group: ['**/application/**', 'node:*', '**/config.js'],
              message:
                'The Match Engine must remain independent of runtime configuration and orchestration.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },
);
