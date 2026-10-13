'use strict';
// Static regression guard: record ids and image data are user-controlled (Employees can edit
// shared Products and choose record ids), so they must be HTML-escaped wherever they reach
// innerHTML attribute values that an ADMIN later renders.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../../js/core.js');

const app = fs.readFileSync(path.join(__dirname, '../../js/app.js'), 'utf8');

test('image src attributes never interpolate unescaped values', () => {
  assert.deepEqual(app.match(/src="\$\{(?!esc\()[^}]*\}"/g) || [], []);
});

test('record id attributes never interpolate unescaped values', () => {
  const unescaped = app.match(/(?:value|data-[a-z-]+)="\$\{(?:[a-z]+\.)?id\}"/g) || [];
  assert.deepEqual(unescaped, []);
});

test('field labels never interpolate the unvalidated order currency unescaped', () => {
  assert.deepEqual(app.match(/field\(`[^`]*\$\{o\.currency\}/g) || [], []);
});

test('escaping is an identity for valid data URLs and ordinary ids', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';
  assert.equal(C.escapeHtml(dataUrl), dataUrl);
  assert.equal(C.escapeHtml('product-1723456789-abc'), 'product-1723456789-abc');
  assert.equal(C.escapeHtml(12), '12');
});

test('escaping neutralizes attribute breakout payloads', () => {
  const payload = 'x"><meta http-equiv="refresh" content="0;url=https://attacker.example.invalid">';
  const escaped = C.escapeHtml(payload);
  assert.doesNotMatch(escaped, /["<>]/);
});
