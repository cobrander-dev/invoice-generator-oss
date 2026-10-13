'use strict';
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'output/', 'tmp/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // Reported, not fixed: several unused results are deliberate guard calls in business code.
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Browser bundle: plain scripts sharing globals through window (FTCore, FTDB, FTPDF, ...).
    files: [
      'js/**/*.js',
      'server/public-app/**/*.js',
      'server/public-login/**/*.js',
      'tests/browser-pdf-smoke.js',
    ],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.node, jspdf: 'readonly', JSZip: 'readonly' },
    },
  },
  {
    files: ['tests/**/*.js'],
    rules: { 'no-dupe-keys': 'warn', 'no-regex-spaces': 'warn' },
  },
];
