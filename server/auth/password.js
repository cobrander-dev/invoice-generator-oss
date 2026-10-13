'use strict';
const argon2 = require('argon2');
const options = Object.freeze({ type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
function hashPassword(password) { return argon2.hash(password, options); }
async function verifyPassword(hash, password) {
  try { return await argon2.verify(hash, password); } catch { return false; }
}
module.exports = { hashPassword, verifyPassword };
