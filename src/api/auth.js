'use strict';

const { randomUUID, timingSafeEqual } = require('node:crypto');
const { transaction } = require('../db');
const { errors, sendJson } = require('../util/http');
const { hashPassword, verifyPassword } = require('../util/passwords');
const { validateRegistration, validateLogin } = require('../util/validation');
const { createPlayer, playerSnapshot, serializeUser } = require('../services/player');
const { createSession, sessionCookie, destroySession, clearSessionCookie } = require('../services/session');

function isUniqueViolation(error, column) {
  return /UNIQUE constraint failed/i.test(String(error?.message || '')) && String(error.message).includes(column);
}

function sameSecret(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function register(ctx) {
  const { db, body, config, catalog, res, ip, req } = ctx;
  const data = validateRegistration(body);
  const { salt, hash } = await hashPassword(data.password);

  // The admin email is reserved: it can only be registered with the configured
  // admin password, so nobody can squat it before the owner.
  let role = 'player';
  if (data.email === config.admin.email) {
    if (!sameSecret(data.password, config.admin.password)) {
      throw errors.conflict(
        'ADMIN_EMAIL_RESERVED',
        'Bu Gmail band. Administrator paroli noto‘g‘ri.'
      );
    }
    role = 'admin';
  }

  const testHeroIds = catalog.heroes.filter((hero) => hero.test).map((hero) => hero.id);
  const userId = randomUUID();
  const now = Date.now();

  try {
    transaction(db, () => {
      db.prepare(
        `INSERT INTO users
           (id, nickname, email, first_name, last_name, age, password_hash, password_salt, role, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        userId,
        data.nickname,
        data.email,
        data.firstName,
        data.lastName,
        data.age,
        hash,
        salt,
        role,
        now,
        now
      );

      createPlayer(db, userId, {
        testHeroIds,
        startingCoins: config.economy.startingCoins,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, 'users.nickname')) {
      throw errors.conflict('NICKNAME_TAKEN', 'Bu nickname allaqachon band.');
    }
    if (isUniqueViolation(error, 'users.email')) {
      throw errors.conflict('EMAIL_TAKEN', 'Bu Gmail allaqachon ro‘yxatdan o‘tgan.');
    }
    throw error;
  }

  const session = createSession(db, userId, {
    ip,
    userAgent: req.headers['user-agent'],
    ttlMs: config.sessionTtlMs,
  });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const player = playerSnapshot(db, userId, catalog, config.economy);

  sendJson(
    res,
    201,
    {
      token: session.token,
      expiresAt: session.expiresAt,
      user: serializeUser(user),
      player,
    },
    { 'Set-Cookie': sessionCookie(session.token, config.sessionTtlMs, config.secureCookies) }
  );
}

async function login(ctx) {
  const { db, body, config, catalog, res, ip, req } = ctx;
  const { login: identifier, password } = validateLogin(body);

  const user = db
    .prepare('SELECT * FROM users WHERE nickname = ? OR email = ? LIMIT 1')
    .get(identifier, identifier);

  // Always run a scrypt verification to keep timing uniform for unknown accounts.
  const passwordOk = user
    ? await verifyPassword(password, user.password_salt, user.password_hash)
    : await verifyPassword(password, '00', '00'.repeat(64));

  if (!user || !passwordOk) {
    throw errors.unauthorized('Nickname yoki parol noto‘g‘ri.');
  }

  // Logging in to the reserved Gmail with the admin password always grants the
  // admin role (covers accounts created before the role was introduced).
  if (
    String(user.email).toLowerCase() === config.admin.email &&
    sameSecret(password, config.admin.password) &&
    user.role !== 'admin'
  ) {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    user.role = 'admin';
  }

  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);

  const session = createSession(db, user.id, {
    ip,
    userAgent: req.headers['user-agent'],
    ttlMs: config.sessionTtlMs,
  });

  sendJson(
    res,
    200,
    {
      token: session.token,
      expiresAt: session.expiresAt,
      user: serializeUser(user),
      player: playerSnapshot(db, user.id, catalog, config.economy),
    },
    { 'Set-Cookie': sessionCookie(session.token, config.sessionTtlMs, config.secureCookies) }
  );
}

async function logout(ctx) {
  const { db, req, res, config } = ctx;
  destroySession(db, req);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(config.secureCookies) });
}

async function me(ctx) {
  const { db, user, catalog, config, res } = ctx;
  sendJson(res, 200, {
    user: serializeUser(user),
    player: playerSnapshot(db, user.id, catalog, config.economy),
  });
}

module.exports = { register, login, logout, me };
