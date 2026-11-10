import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';

export default tseslint.config(
  { ignores: ['dist/**', '.angular/**', 'node_modules/**', '.certs/**', 'test-results/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [eslint.configs.recommended],
    languageOptions: {
      globals: Object.fromEntries(
        [
          'process',
          'console',
          'setTimeout',
          'clearTimeout',
          'window',
          'document',
          'innerWidth',
          'getComputedStyle',
          'fetch',
          'URL',
        ].map((name) => [name, 'readonly']),
      ),
    },
  },
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      ...angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
  },
  {
    files: ['**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
  },
);
