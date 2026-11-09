'use strict';

const encoder = new TextEncoder();
const PBKDF2_ITERATIONS = 30_000;
const COOKIE_NAME = 'aa_session';

export function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex) {
  const clean = String(hex || '');
  const out = new Uint8Array(clean.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

export function randomToken(bytes = 32) {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return toHex(digest);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(password).normalize('NFKC')),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return { salt: toHex(salt), hash: toHex(bits) };
}

function constantTimeEqual(left, right) {
  const a = left instanceof Uint8Array ? left : encoder.encode(String(left));
  const b = right instanceof Uint8Array ? right : encoder.encode(String(right));
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

export async function verifyPassword(password, saltHex, expectedHex) {
  try {
    const salt = fromHex(saltHex);
    const expected = fromHex(expectedHex);
    if (!salt.length || !expected.length) return false;
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(String(password).normalize('NFKC')),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );
    const bits = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        key,
        256
      )
    );
    return constantTimeEqual(bits, expected);
  } catch {
    return false;
  }
}

export function sameSecret(left, right) {
  return constantTimeEqual(String(left ?? ''), String(right ?? ''));
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

export function sessionCookie(token, maxAgeMs, secure) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(secure) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export { COOKIE_NAME, PBKDF2_ITERATIONS };
