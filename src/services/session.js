'use strict';

const { randomUUID } = require('node:crypto');
const { parseCookies } = require('../util/http');
const { randomToken, sha256 } = require('../util/passwords');

const COOKIE_NAME = 'aa_session';

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();

  const cookies = parseCookies(req.headers.cookie || '');
  return cookies[COOKIE_NAME] || null;
}

function createSession(db, userId, { ip, userAgent, ttlMs }) {
  const token = randomToken(32);
  const now = Date.now();

  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    userId,
    sha256(token),
    now,
    now + ttlMs,
    now,
    ip || null,
    String(userAgent || '').slice(0, 300) || null
  );

  return { token, expiresAt: now + ttlMs };
}

/** Returns the authenticated user row, or null. */
function authenticate(db, req, { touchIntervalMs = 60_000 } = {}) {
  const token = extractToken(req);
  if (!token) return null;

  const session = db
    .prepare('SELECT * FROM sessions WHERE token_hash = ?')
    .get(sha256(token));
  if (!session) return null;

  const now = Date.now();
  if (session.expires_at <= now) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    return null;
  }

  if (now - session.last_seen_at > touchIntervalMs) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, session.id);
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
  if (!user) return null;

  return { user, session, token };
}

function destroySession(db, req) {
  const token = extractToken(req);
  if (!token) return false;
  const result = db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  return result.changes > 0;
}

function sessionCookie(token, maxAgeMs, secure) {
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

function clearSessionCookie(secure) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

module.exports = {
  COOKIE_NAME,
  extractToken,
  createSession,
  authenticate,
  destroySession,
  sessionCookie,
  clearSessionCookie,
};
