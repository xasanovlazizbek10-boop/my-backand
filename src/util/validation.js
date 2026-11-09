'use strict';

const { errors } = require('./http');

const NICKNAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;
const GMAIL_RE = /^[^\s@]+@gmail\.com$/i;

/**
 * Mirrors the original game's password rules:
 * at least 6 letters, 3 digits and 1 non-letter/digit/whitespace symbol.
 */
function passwordChecks(password) {
  return {
    letters: (password.match(/\p{L}/gu) || []).length >= 6,
    digits: (password.match(/\d/g) || []).length >= 3,
    symbols: /[^\p{L}\d\s]/u.test(password),
  };
}

function isStrongPassword(password) {
  if (typeof password !== 'string' || password.length > 200) return false;
  const checks = passwordChecks(password);
  return checks.letters && checks.digits && checks.symbols;
}

function cleanString(value, { min = 1, max = 120 } = {}) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) return null;
  return trimmed;
}

function validateRegistration(body) {
  const fields = {};
  const firstName = cleanString(body.firstName, { min: 1, max: 40 });
  const lastName = cleanString(body.lastName, { min: 1, max: 40 });
  const nickname = cleanString(body.nickname, { min: 3, max: 20 });
  const email = cleanString(body.email, { min: 6, max: 120 });
  const age = Number(body.age);
  const password = typeof body.password === 'string' ? body.password : '';

  if (!firstName) fields.firstName = 'Ism 1–40 belgidan iborat bo‘lishi kerak.';
  if (!lastName) fields.lastName = 'Familiya 1–40 belgidan iborat bo‘lishi kerak.';
  if (!nickname || !NICKNAME_RE.test(nickname)) {
    fields.nickname = 'Nickname 3–20 belgi: harflar, raqamlar, _ . - bo‘lishi mumkin.';
  }
  if (!Number.isInteger(age) || age < 5 || age > 99) {
    fields.age = 'Yosh 5 dan 99 gacha bo‘lishi kerak.';
  }
  if (!email || !GMAIL_RE.test(email)) {
    fields.email = 'Gmail manzilini to‘g‘ri kiriting (masalan: ism@gmail.com).';
  }
  if (!isStrongPassword(password)) {
    fields.password = 'Parolda kamida 6 harf, 3 raqam va 1 belgi bo‘lishi kerak.';
  }

  if (Object.keys(fields).length) {
    throw errors.unprocessable('VALIDATION_FAILED', 'Kiritilgan ma’lumotlarni tekshiring.', fields);
  }

  return { firstName, lastName, nickname, age, email: email.toLowerCase(), password };
}

function validateLogin(body) {
  const login = cleanString(body.login ?? body.nickname ?? body.email, { min: 3, max: 120 });
  const password = typeof body.password === 'string' ? body.password : '';

  if (!login || !password) {
    throw errors.unprocessable('VALIDATION_FAILED', 'Login va parolni kiriting.', {
      ...(login ? {} : { login: 'Nickname yoki Gmail kiriting.' }),
      ...(password ? {} : { password: 'Parolni kiriting.' }),
    });
  }
  return { login, password };
}

function requireString(value, field, { min = 1, max = 200 } = {}) {
  const clean = cleanString(value, { min, max });
  if (!clean) {
    throw errors.unprocessable('VALIDATION_FAILED', `${field} noto‘g‘ri.`, { [field]: 'Majburiy maydon.' });
  }
  return clean;
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw errors.unprocessable('VALIDATION_FAILED', `${field} true yoki false bo‘lishi kerak.`, {
      [field]: 'boolean kutilgan.',
    });
  }
  return value;
}

function optionalInt(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw errors.unprocessable('VALIDATION_FAILED', `${field} ${min}–${max} oralig‘ida butun son bo‘lishi kerak.`, {
      [field]: 'Butun son kutilgan.',
    });
  }
  return number;
}

module.exports = {
  passwordChecks,
  isStrongPassword,
  validateRegistration,
  validateLogin,
  requireString,
  requireBoolean,
  optionalInt,
};
