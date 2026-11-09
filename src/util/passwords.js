'use strict';

const { scrypt, randomBytes, timingSafeEqual, createHash } = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(scrypt);

const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * Hash a password with a fresh random salt.
 * @returns {Promise<{salt: string, hash: string}>} hex-encoded values
 */
async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return { salt, hash: derived.toString('hex') };
}

/**
 * Constant-time password verification.
 */
async function verifyPassword(password, salt, expectedHex) {
  if (typeof password !== 'string' || typeof salt !== 'string' || typeof expectedHex !== 'string') {
    return false;
  }
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== KEY_LENGTH) return false;

  const derived = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return timingSafeEqual(expected, derived);
}

/** Opaque, URL-safe session token. */
function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/** Tokens are stored hashed so a DB leak cannot be replayed. */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

module.exports = { hashPassword, verifyPassword, randomToken, sha256 };
