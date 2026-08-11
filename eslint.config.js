// @ts-check
const eslint = require('@eslint/js');
const { defineConfig } = require('eslint/config');
const tseslint = require('typescript-eslint');
const angular = require('angular-eslint');

const frameworkImports = ['@angular/*', '@ngrx/*'];

module.exports = defineConfig([
  {
    ignores: ['.angular/**', 'coverage/**', 'dist/**', 'node_modules/**', 'out-tsc/**'],
  },
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'ngx-offline', style: 'kebab-case' },
      ],
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'ngxOffline', style: 'camelCase' },
      ],
    },
  },
  {
    files: ['projects/ngrx-offline/{core,indexeddb,worker,testing}/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: frameworkImports }],
    },
  },
  {
    files: ['projects/ngrx-offline/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...frameworkImports,
            '@poodlelab/ngrx-offline',
            '@poodlelab/ngrx-offline/indexeddb',
            '@poodlelab/ngrx-offline/testing',
            '@poodlelab/ngrx-offline/worker',
          ],
        },
      ],
    },
  },
  {
    files: ['projects/ngrx-offline/indexeddb/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['@poodlelab/ngrx-offline'],
          patterns: [
            ...frameworkImports,
            '@poodlelab/ngrx-offline/testing',
            '@poodlelab/ngrx-offline/worker',
          ],
        },
      ],
    },
  },
  {
    files: ['projects/ngrx-offline/indexeddb/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['@poodlelab/ngrx-offline'],
          patterns: [...frameworkImports, '@poodlelab/ngrx-offline/worker'],
        },
      ],
    },
  },
  {
    files: ['projects/ngrx-offline/worker/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['@poodlelab/ngrx-offline'],
          patterns: [...frameworkImports, '@poodlelab/ngrx-offline/testing'],
        },
      ],
    },
  },
  {
    files: ['projects/ngrx-offline/worker/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: ['@poodlelab/ngrx-offline'], patterns: frameworkImports },
      ],
    },
  },
  {
    files: ['projects/ngrx-offline/testing/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['@poodlelab/ngrx-offline'],
          patterns: [
            ...frameworkImports,
            '@poodlelab/ngrx-offline/indexeddb',
            '@poodlelab/ngrx-offline/worker',
          ],
        },
      ],
    },
  },
  {
    files: ['projects/ngrx-offline/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['@poodlelab/ngrx-offline/worker'] }],
    },
  },
  {
    files: ['**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
  },
]);
