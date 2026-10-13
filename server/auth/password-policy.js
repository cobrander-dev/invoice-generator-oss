'use strict';

const DEFAULT_MIN_LENGTH = 8;
const MAX_LENGTH = 1024;
const WEAK_PASSWORDS = new Set(['12345678', 'password', 'abcdefgh', 'qwerty123', 'admin123']);

function passwordMinimum(value = process.env.PASSWORD_MIN_LENGTH) {
  if (value === undefined || value === '') return DEFAULT_MIN_LENGTH;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < DEFAULT_MIN_LENGTH || parsed > 128) {
    throw new Error(`PASSWORD_MIN_LENGTH must be ${DEFAULT_MIN_LENGTH}-128`);
  }
  return parsed;
}

function validatePassword(password, minimum = passwordMinimum()) {
  if (typeof password !== 'string' || password.length < minimum || password.length > MAX_LENGTH) {
    return { valid: false, message: `Password must be ${minimum}-${MAX_LENGTH} characters` };
  }
  if (WEAK_PASSWORDS.has(password.trim().toLowerCase()) || /change-me|replace-me/i.test(password)) {
    return { valid: false, message: 'Password is too weak or is a placeholder' };
  }
  return { valid: true, message: '' };
}

function requireValidPassword(password, minimum = passwordMinimum()) {
  const result = validatePassword(password, minimum);
  if (!result.valid) throw new Error(result.message);
  return password;
}

module.exports = { DEFAULT_MIN_LENGTH, MAX_LENGTH, WEAK_PASSWORDS, passwordMinimum, validatePassword, requireValidPassword };
