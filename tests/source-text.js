'use strict';
// Source-text assertions are written in the compact style the frontend originally used
// (for example 'const data=await fileToDataURL(f)'). Normalizing both the source and the
// expected fragment keeps every fragment exact while making the assertions independent of
// code formatting: whitespace is removed except one space between two word characters.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function normalizeSource(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .replace(/ (?![\w$])|(?<![\w$]) /g, '');
}

class SourceText {
  constructor(text) {
    this.text = normalizeSource(text);
  }
  includes(fragment) {
    return this.text.includes(normalizeSource(fragment));
  }
  indexOf(fragment) {
    return this.text.indexOf(normalizeSource(fragment));
  }
  match(pattern) {
    return this.text.match(pattern);
  }
  toString() {
    return this.text;
  }
}

function readSource(...files) {
  return new SourceText(
    files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n'),
  );
}

module.exports = { normalizeSource, readSource, SourceText };
