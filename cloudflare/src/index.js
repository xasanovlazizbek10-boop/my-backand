'use strict';

import { one, all, run, stmt, batch } from './db.js';
import { getConfig } from './config.js';
import { loadCatalog, TIER_ORDER } from './catalog.js';
import {
  hashPassword,
  verifyPassword,
  randomToken,
  sha256Hex,
  parseCookies,
  sessionCookie,
  clearSessionCookie,
  sameSecret,
  COOKIE_NAME,
} from './security.js';
import { getLiveState, getLiveHistory, joinLive, leaveLive, tickLive } from './live.js';

/* ---------- constants ---------- */
const GAME_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https:; " +
  "connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const CONSOLE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const DEFAULT_SETTINGS = {
  lang: 'uz',
  theme: 'system',
  quality: 'high',
  motion: 'system',
  shake: true,
  flashes: true,
  damage: true,
  skillTitles: true,
  hints: true,
};
const SETTINGS_SCHEMA = {
  lang: ['uz', 'ru', 'en'],
  theme: ['system', 'light', 'dark'],
  quality: ['high', 'balanced', 'low'],
  motion: ['system', 'reduce'],
};

const NICKNAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;
const GMAIL_RE = /^[^\s@]+@gmail\.com$/i;

/* ---------- errors / responses ---------- */
class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const errors = {
  badRequest: (message, details) => new HttpError(400, 'BAD_REQUEST', message, details),
  unauthorized: (message = 'Avtorizatsiya talab qilinadi.') => new HttpError(401, 'UNAUTHORIZED', message),
  forbidden: (message = 'Ruxsat yo‘q.') => new HttpError(403, 'FORBIDDEN', message),
  notFound: (message = 'Topilmadi.') => new HttpError(404, 'NOT_FOUND', message),
  conflict: (code, message) => new HttpError(409, code, message),
  payloadTooLarge: () => new HttpError(413, 'PAYLOAD_TOO_LARGE', 'So‘rov hajmi juda katta.'),
  unprocessable: (code, message, details) => new HttpError(422, code, message, details),
  tooManyRequests: (retryAfterMs) =>
    new HttpError(429, 'RATE_LIMITED', 'Juda ko‘p so‘rov. Birozdan so‘ng qayta urinib ko‘ring.', {
      retryAfterMs,
    }),
};

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

/* ---------- rate limiting (per isolate) ---------- */
const buckets = new Map();
function rateLimited(key, max, windowMs = 60_000) {
  const now = Date.now();
  let entry = buckets.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    buckets.set(key, entry);
    if (buckets.size > 5000) {
      for (const [bucketKey, value] of buckets) if (now >= value.resetAt) buckets.delete(bucketKey);
    }
  }
  entry.count += 1;
  return entry.count > max ? Math.max(0, entry.resetAt - now) : 0;
}

/* ---------- validation ---------- */
function cleanString(value, { min = 1, max = 120 } = {}) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) return null;
  return trimmed;
}

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
  if (!Number.isInteger(age) || age < 5 || age > 99) fields.age = 'Yosh 5 dan 99 gacha bo‘lishi kerak.';
  if (!email || !GMAIL_RE.test(email)) {
    fields.email = 'Gmail manzilini to‘g‘ri kiriting (masalan: ism@gmail.com).';
  }
  if (!isStrongPassword(password)) fields.password = 'Parolda kamida 6 harf, 3 raqam va 1 belgi bo‘lishi kerak.';
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

/* ---------- body / auth ---------- */
async function readJson(request, limit) {
  const contentType = request.headers.get('content-type') || '';
  if (contentType && !contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'application/json talab qilinadi.');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > limit) throw errors.payloadTooLarge();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw errors.badRequest('JSON noto‘g‘ri shakllangan.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw errors.badRequest('So‘rov tanasi obyekt bo‘lishi kerak.');
  }
  return parsed;
}

function clientIp(request) {
  const forwarded = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for');
  return forwarded ? String(forwarded).split(',')[0].trim() : 'unknown';
}

function tokenFromRequest(request) {
  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  const cookies = parseCookies(request.headers.get('cookie') || '');
  return cookies[COOKIE_NAME] || null;
}

async function authenticate(request, env) {
  const token = tokenFromRequest(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await one(
    env.DB,
    `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? LIMIT 1`,
    tokenHash
  );
  if (!row) return null;
  const now = Date.now();
  if (Number(row.expires_at) <= now) {
    await run(env.DB, 'DELETE FROM sessions WHERE id = ?', row.session_id);
    return null;
  }
  if (now - Number(row.last_seen_at) > 60_000) {
    await run(env.DB, 'UPDATE sessions SET last_seen_at = ? WHERE id = ?', now, row.session_id);
  }
  return row;
}

async function createSession(env, userId, request, config) {
  const token = randomToken(32);
  const now = Date.now();
  await run(
    env.DB,
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    userId,
    await sha256Hex(token),
    now,
    now + config.sessionTtlMs,
    now,
    clientIp(request),
    String(request.headers.get('user-agent') || '').slice(0, 300) || null
  );
  return token;
}

async function destroySession(env, request) {
  const token = tokenFromRequest(request);
  if (!token) return false;
  const result = await run(env.DB, 'DELETE FROM sessions WHERE token_hash = ?', await sha256Hex(token));
  return Boolean(result.meta?.changes);
}

function secureCookie(request) {
  return new URL(request.url).protocol === 'https:';
}

/* ---------- player / economy ---------- */
const startOfToday = (now = Date.now()) => {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const accountLevel = (total, ranks) => ranks.filter((rank) => Number(total) >= rank.totalRequired).length;
const accountRank = (total, ranks) => {
  const level = accountLevel(total, ranks);
  return level > 0 ? ranks[level - 1] : null;
};
const totalMultiplier = (level) => 1 + Math.max(0, Math.min(6, (Number(level) || 0) - 1)) * 0.025;

function serializeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    nickname: user.nickname,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    age: user.age,
    role: user.role,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
  };
}

function parseSettings(raw) {
  try {
    const stored = JSON.parse(raw || '{}');
    return { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function serializeSettings(settings) {
  return JSON.stringify({ ...DEFAULT_SETTINGS, ...settings });
}

function sanitizeSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw errors.badRequest('settings obyekt bo‘lishi kerak.');
  }
  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    if (SETTINGS_SCHEMA[key]) {
      if (!SETTINGS_SCHEMA[key].includes(value)) continue;
      clean[key] = value;
    } else if (typeof value === 'boolean') {
      clean[key] = value;
    }
  }
  return clean;
}

async function refreshTokens(db, userId, economy, now = Date.now()) {
  const row = await one(db, 'SELECT tokens, tokens_updated_at FROM players WHERE user_id = ?', userId);
  if (!row) return null;
  let tokens = Number(row.tokens) || 0;
  let updatedAt = Number(row.tokens_updated_at) || now;
  if (tokens >= economy.maxTokens) {
    updatedAt = now;
  } else {
    const elapsed = Math.max(0, now - updatedAt);
    const gained = Math.min(economy.maxTokens - tokens, Math.floor(elapsed / economy.tokenIntervalMs));
    if (gained > 0) {
      tokens += gained;
      updatedAt += gained * economy.tokenIntervalMs;
      if (tokens >= economy.maxTokens) updatedAt = now;
    }
  }
  if (tokens !== Number(row.tokens) || updatedAt !== Number(row.tokens_updated_at)) {
    await run(
      db,
      'UPDATE players SET tokens = ?, tokens_updated_at = ?, updated_at = ? WHERE user_id = ?',
      tokens,
      updatedAt,
      now,
      userId
    );
  }
  return { tokens, updatedAt };
}

function nextTokenInMs(row, economy, now = Date.now()) {
  if (Number(row.tokens) >= economy.maxTokens) return 0;
  return Math.max(0, economy.tokenIntervalMs - (now - Number(row.tokens_updated_at)));
}

async function playerSnapshot(env, config, catalog, userId) {
  const db = env.DB;
  const user = await one(db, 'SELECT * FROM users WHERE id = ?', userId);
  if (!user) throw errors.unauthorized();
  await refreshTokens(db, userId, config.economy);
  const row = await one(db, 'SELECT * FROM players WHERE user_id = ?', userId);
  if (!row) throw errors.unauthorized('O‘yinchi profili topilmadi.');
  const ownedHeroes = await all(
    db,
    'SELECT hero_id, source, price, currency, acquired_at FROM owned_heroes WHERE user_id = ? ORDER BY acquired_at',
    userId
  );
  const ownedMaps = await all(
    db,
    'SELECT map_id, acquired_at FROM owned_maps WHERE user_id = ? ORDER BY acquired_at',
    userId
  );
  const total = round2(row.total);
  const level = accountLevel(total, catalog.ranks);
  const rank = accountRank(total, catalog.ranks);
  return {
    user: serializeUser(user),
    wallet: {
      coins: Number(row.coins),
      diamonds: Number(row.diamonds),
      tokens: Number(row.tokens),
      maxTokens: config.economy.maxTokens,
      nextTokenInMs: nextTokenInMs(row, config.economy),
    },
    progress: {
      level: Number(row.level),
      wins: Number(row.wins),
      losses: Number(row.losses),
      total,
      accountLevel: level,
      accountRank: rank ? { level: rank.level, name: rank.name, color: rank.color } : null,
      totalMultiplier: round2(totalMultiplier(level) * 1000) / 1000,
    },
    heroes: {
      owned: ownedHeroes.map((entry) => entry.hero_id),
      details: ownedHeroes.map((entry) => ({
        id: entry.hero_id,
        source: entry.source,
        price: entry.price,
        currency: entry.currency,
        acquiredAt: entry.acquired_at,
      })),
      favorite: row.favorite_hero,
    },
    maps: {
      owned: ownedMaps.map((entry) => entry.map_id),
      selected: row.map_id,
    },
    settings: parseSettings(row.settings),
    updatedAt: row.updated_at,
  };
}

function createPlayerStatements(db, userId, { testHeroIds, startingCoins, now }) {
  const favorite = testHeroIds[0] || null;
  const statements = [
    stmt(
      db,
      `INSERT INTO players
         (user_id, coins, diamonds, tokens, tokens_updated_at, level, wins, losses, total,
          favorite_hero, map_id, settings, created_at, updated_at)
       VALUES (?, ?, 0, 8, ?, 0, 0, 0, 0, ?, 'std', ?, ?, ?)`,
      userId,
      startingCoins,
      now,
      favorite,
      serializeSettings(DEFAULT_SETTINGS),
      now,
      now
    ),
  ];
  for (const heroId of testHeroIds) {
    statements.push(
      stmt(
        db,
        `INSERT INTO owned_heroes (user_id, hero_id, source, price, currency, acquired_at)
         VALUES (?, ?, 'start', 0, NULL, ?)`,
        userId,
        heroId,
        now
      )
    );
  }
  statements.push(
    stmt(db, 'INSERT INTO owned_maps (user_id, map_id, acquired_at) VALUES (?, ?, ?)', userId, 'std', now)
  );
  return statements;
}

function walletOf(row) {
  return {
    coins: Number(row?.coins) || 0,
    diamonds: Number(row?.diamonds) || 0,
    tokens: Number(row?.tokens) || 0,
  };
}

function transactionStatement(db, entry) {
  return stmt(
    db,
    `INSERT INTO transactions (id, user_id, type, currency, amount, balance_after, ref, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    entry.userId,
    entry.type,
    entry.currency,
    entry.amount,
    entry.balanceAfter,
    entry.ref || null,
    entry.meta ? JSON.stringify(entry.meta) : null,
    entry.at || Date.now()
  );
}

/* ---------- full state ---------- */
const STATE_NUMBER_LIMITS = {
  tok: [0, 8],
  tokT: [0, Number.MAX_SAFE_INTEGER],
  lv: [0, 100],
  coin: [0, 1e12],
  diamonds: [0, 1e9],
  b10: [0, 1],
  w: [0, 1e9],
  l: [0, 1e9],
  total: [0, 1e12],
  tournamentRunCounter: [0, 1e9],
  tournamentArchiveLast: [0, 1e9],
};
const STATE_STRING_FIELDS = ['map', 'fav'];
const STATE_STRING_ARRAY_FIELDS = ['own', 'maps'];
const STATE_OBJECT_FIELDS = ['hs', 'sel', 'diamondClaims', 'totalClaims'];
const STATE_HISTORY_FIELDS = ['diamondHistory', 'tournamentHistory', 'pinnedTournaments', 'totalHistory'];

function clampNumber(value, [min, max], fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function cleanStringList(value, maxItems = 500) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !item || item.length > 80) continue;
    seen.add(item);
    if (seen.size >= maxItems) break;
  }
  return [...seen];
}

function cleanFlatObject(value, maxKeys = 500) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  let keys = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (keys >= maxKeys) break;
    if (typeof key !== 'string' || key.length > 80) continue;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      out[key] = Math.max(0, Math.min(1e12, Math.round(entry * 100) / 100));
    } else if (typeof entry === 'string' && entry.length <= 120) {
      out[key] = entry;
    } else if (typeof entry === 'boolean') {
      out[key] = entry;
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const nested = {};
      for (const [nestedKey, nestedValue] of Object.entries(entry)) {
        if (typeof nestedValue === 'number' && Number.isFinite(nestedValue)) {
          nested[nestedKey] = Math.max(0, Math.min(1e12, Math.round(nestedValue * 100) / 100));
        } else if (typeof nestedValue === 'string' && nestedValue.length <= 120) {
          nested[nestedKey] = nestedValue;
        }
      }
      out[key] = nested;
    }
    keys += 1;
  }
  return out;
}

function cleanHistory(value, maxItems = 200) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value.slice(0, maxItems)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    try {
      out.push(JSON.parse(JSON.stringify(entry)));
    } catch {
      /* skip */
    }
  }
  return out;
}

function sanitizeState(input, catalog) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw errors.badRequest('state obyekt bo‘lishi kerak.');
  }
  const clean = {};
  for (const [key, limits] of Object.entries(STATE_NUMBER_LIMITS)) {
    clean[key] = clampNumber(input[key], limits, key === 'tok' ? 8 : 0);
  }
  if (clean.tokT === 0) clean.tokT = Date.now();
  for (const key of STATE_STRING_FIELDS) {
    if (typeof input[key] === 'string') clean[key] = input[key].slice(0, 80);
  }
  clean.own = cleanStringList(input.own).filter((id) => !catalog || catalog.getHero(id));
  clean.maps = cleanStringList(input.maps).filter((id) => !catalog || catalog.getMap(id));
  for (const key of STATE_OBJECT_FIELDS) clean[key] = cleanFlatObject(input[key], 500);
  if (input.tours && typeof input.tours === 'object' && !Array.isArray(input.tours)) {
    const tours = {};
    for (const [key, value] of Object.entries(input.tours).slice(0, 12)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      try {
        tours[key] = JSON.parse(JSON.stringify(value));
      } catch {
        /* skip */
      }
    }
    clean.tours = tours;
  } else {
    clean.tours = {};
  }
  for (const key of STATE_HISTORY_FIELDS) clean[key] = cleanHistory(input[key]);
  return clean;
}

async function loadState(env, userId) {
  const row = await one(env.DB, 'SELECT state, version, updated_at FROM player_states WHERE user_id = ?', userId);
  if (!row) return null;
  try {
    return { state: JSON.parse(row.state), version: row.version, updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

async function saveState(env, config, catalog, userId, input) {
  const state = sanitizeState(input, catalog);
  const serialized = JSON.stringify(state);
  if (new TextEncoder().encode(serialized).length > config.stateLimit) throw errors.payloadTooLarge();
  const now = Date.now();
  const existing = await one(env.DB, 'SELECT version, map_id, favorite_hero FROM player_states ps LEFT JOIN players p ON p.user_id = ps.user_id WHERE ps.user_id = ?', userId);
  const player = await one(env.DB, 'SELECT map_id, favorite_hero FROM players WHERE user_id = ?', userId);
  const nextVersion = existing ? Number(existing.version) + 1 : 1;
  await batch(env.DB, [
    stmt(
      env.DB,
      `INSERT INTO player_states (user_id, state, version, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, version = excluded.version, updated_at = excluded.updated_at`,
      userId,
      serialized,
      nextVersion,
      now
    ),
    stmt(
      env.DB,
      `UPDATE players
          SET coins = ?, diamonds = ?, tokens = ?, tokens_updated_at = ?, level = ?, wins = ?, losses = ?,
              total = ?, map_id = ?, favorite_hero = ?, updated_at = ?
        WHERE user_id = ?`,
      state.coin ?? 0,
      state.diamonds ?? 0,
      state.tok ?? 8,
      state.tokT || now,
      state.lv ?? 0,
      state.w ?? 0,
      state.l ?? 0,
      state.total ?? 0,
      state.map || player?.map_id || 'std',
      state.fav || player?.favorite_hero || null,
      now,
      userId
    ),
  ]);
  return { version: nextVersion, updatedAt: now };
}

async function applyWalletDelta(env, userId, { coins = 0, diamonds = 0, tokens = 0 }) {
  const db = env.DB;
  const row = await one(db, 'SELECT coins, diamonds, tokens FROM players WHERE user_id = ?', userId);
  if (!row) return null;
  const now = Date.now();
  const nextCoins = Math.max(0, Number(row.coins) + coins);
  const nextDiamonds = Math.max(0, Number(row.diamonds) + diamonds);
  const nextTokens = Math.min(8, Math.max(0, Number(row.tokens) + tokens));
  const statements = [
    stmt(
      db,
      'UPDATE players SET coins = ?, diamonds = ?, tokens = ?, updated_at = ? WHERE user_id = ?',
      nextCoins,
      nextDiamonds,
      nextTokens,
      now,
      userId
    ),
  ];
  const stateRow = await one(db, 'SELECT state, version FROM player_states WHERE user_id = ?', userId);
  if (stateRow) {
    try {
      const state = JSON.parse(stateRow.state);
      state.coin = nextCoins;
      state.diamonds = nextDiamonds;
      state.tok = nextTokens;
      statements.push(
        stmt(
          db,
          'UPDATE player_states SET state = ?, version = ?, updated_at = ? WHERE user_id = ?',
          JSON.stringify(state),
          Number(stateRow.version) + 1,
          now,
          userId
        )
      );
    } catch {
      /* corrupt snapshot */
    }
  }
  await batch(db, statements);
  return { coins: nextCoins, diamonds: nextDiamonds, tokens: nextTokens };
}

/* ---------- handlers: system / catalog ---------- */
async function health(ctx) {
  const total = await one(ctx.env.DB, 'SELECT COUNT(*) AS count FROM users');
  return jsonResponse({
    ok: true,
    service: 'anime-arena-top',
    version: '1.0.0',
    clock: Date.now(),
    catalog: ctx.catalog.meta.counts,
    registeredPlayers: Number(total?.count) || 0,
  });
}

async function publicConfig(ctx) {
  return jsonResponse({
    economy: ctx.config.economy,
    catalog: {
      heroes: ctx.catalog.meta.counts.heroes,
      purchasableHeroes: ctx.catalog.meta.counts.purchasableHeroes,
      tiers: ctx.catalog.tiers,
    },
    sessionTtlMs: ctx.config.sessionTtlMs,
    live: {
      size: ctx.config.live.size,
      restMs: ctx.config.live.restMs,
      cycleMs: ctx.config.live.cycleMs,
      prize: { coins: ctx.config.live.prizeCoins, diamonds: ctx.config.live.prizeDiamonds },
    },
  });
}

async function catalogOverview(ctx) {
  return jsonResponse({
    meta: ctx.catalog.meta,
    tiers: ctx.catalog.tiers,
    ranks: ctx.catalog.ranks,
    maps: ctx.catalog.maps,
    monsters: ctx.catalog.monsters,
    heroes: ctx.catalog.summaryList(),
  });
}

async function catalogHeroes(ctx) {
  let list = ctx.catalog.heroes;
  const tier = ctx.url.searchParams.get('tier');
  if (tier) list = list.filter((hero) => hero.tier === tier.toUpperCase());
  const search = (ctx.url.searchParams.get('q') || '').trim().toLowerCase();
  if (search) list = list.filter((hero) => hero.name.toLowerCase().includes(search));
  if (ctx.url.searchParams.get('purchasable') === '1') list = list.filter((hero) => hero.purchasable);
  return jsonResponse({ count: list.length, heroes: list.map((hero) => ctx.catalog.heroSummary(hero)) });
}

async function catalogHero(ctx) {
  const hero = ctx.catalog.getHero(ctx.params.id);
  if (!hero) throw errors.notFound('Bunday jangchi topilmadi.');
  return jsonResponse(ctx.catalog.heroDetail(hero));
}

const catalogTiers = (ctx) => jsonResponse({ tiers: ctx.catalog.tiers });
const catalogRanks = (ctx) => jsonResponse({ ranks: ctx.catalog.ranks });
const catalogMaps = (ctx) => jsonResponse({ maps: ctx.catalog.maps });
const catalogMonsters = (ctx) => jsonResponse({ monsters: ctx.catalog.monsters });

/* ---------- handlers: auth ---------- */
async function register(ctx) {
  const data = validateRegistration(ctx.body);
  const roleCheckEmail = data.email === ctx.config.admin.email;
  let role = 'player';
  if (roleCheckEmail) {
    if (!sameSecret(data.password, ctx.config.admin.password)) {
      throw errors.conflict('ADMIN_EMAIL_RESERVED', 'Bu Gmail band. Administrator paroli noto‘g‘ri.');
    }
    role = 'admin';
  }
  const { salt, hash } = await hashPassword(data.password);
  const userId = crypto.randomUUID();
  const now = Date.now();
  const testHeroIds = ctx.catalog.heroes.filter((hero) => hero.test).map((hero) => hero.id);
  try {
    await batch(ctx.env.DB, [
      stmt(
        ctx.env.DB,
        `INSERT INTO users
           (id, nickname, email, first_name, last_name, age, password_hash, password_salt, role, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ),
      ...createPlayerStatements(ctx.env.DB, userId, {
        testHeroIds,
        startingCoins: ctx.config.economy.startingCoins,
        now,
      }),
    ]);
  } catch (error) {
    const message = String(error?.message || '');
    if (/UNIQUE constraint failed: users\.nickname/i.test(message)) {
      throw errors.conflict('NICKNAME_TAKEN', 'Bu nickname allaqachon band.');
    }
    if (/UNIQUE constraint failed: users\.email/i.test(message)) {
      throw errors.conflict('EMAIL_TAKEN', 'Bu Gmail allaqachon ro‘yxatdan o‘tgan.');
    }
    throw error;
  }
  const token = await createSession(ctx.env, userId, ctx.request, ctx.config);
  const user = await one(ctx.env.DB, 'SELECT * FROM users WHERE id = ?', userId);
  const player = await playerSnapshot(ctx.env, ctx.config, ctx.catalog, userId);
  return jsonResponse(
    { token, expiresAt: Date.now() + ctx.config.sessionTtlMs, user: serializeUser(user), player },
    201,
    { 'Set-Cookie': sessionCookie(token, ctx.config.sessionTtlMs, secureCookie(ctx.request)) }
  );
}

async function login(ctx) {
  const { login: identifier, password } = validateLogin(ctx.body);
  const user = await one(
    ctx.env.DB,
    'SELECT * FROM users WHERE nickname = ? OR email = ? LIMIT 1',
    identifier,
    identifier
  );
  const passwordOk = user
    ? await verifyPassword(password, user.password_salt, user.password_hash)
    : await verifyPassword(password, '00'.repeat(16), '00'.repeat(32));
  if (!user || !passwordOk) throw errors.unauthorized('Nickname yoki parol noto‘g‘ri.');
  if (
    String(user.email).toLowerCase() === ctx.config.admin.email &&
    sameSecret(password, ctx.config.admin.password) &&
    user.role !== 'admin'
  ) {
    await run(ctx.env.DB, "UPDATE users SET role = 'admin' WHERE id = ?", user.id);
    user.role = 'admin';
  }
  await run(ctx.env.DB, 'UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), user.id);
  const token = await createSession(ctx.env, user.id, ctx.request, ctx.config);
  return jsonResponse(
    {
      token,
      expiresAt: Date.now() + ctx.config.sessionTtlMs,
      user: serializeUser(user),
      player: await playerSnapshot(ctx.env, ctx.config, ctx.catalog, user.id),
    },
    200,
    { 'Set-Cookie': sessionCookie(token, ctx.config.sessionTtlMs, secureCookie(ctx.request)) }
  );
}

async function logout(ctx) {
  await destroySession(ctx.env, ctx.request);
  return jsonResponse({ ok: true }, 200, {
    'Set-Cookie': clearSessionCookie(secureCookie(ctx.request)),
  });
}

async function me(ctx) {
  return jsonResponse({
    user: serializeUser(ctx.user),
    player: await playerSnapshot(ctx.env, ctx.config, ctx.catalog, ctx.user.id),
  });
}

/* ---------- handlers: player ---------- */
async function getPlayer(ctx) {
  return jsonResponse(await playerSnapshot(ctx.env, ctx.config, ctx.catalog, ctx.user.id));
}

async function patchPlayer(ctx) {
  const db = ctx.env.DB;
  if (Object.prototype.hasOwnProperty.call(ctx.body, 'favoriteHeroId')) {
    const value = ctx.body.favoriteHeroId;
    if (value !== null && typeof value !== 'string') {
      throw errors.unprocessable('VALIDATION_FAILED', 'favoriteHeroId string yoki null bo‘lishi kerak.');
    }
    if (value !== null) {
      if (!ctx.catalog.getHero(value)) throw errors.notFound('Bunday jangchi topilmadi.');
      const owned = await one(db, 'SELECT 1 AS owned FROM owned_heroes WHERE user_id = ? AND hero_id = ?', ctx.user.id, value);
      if (!owned) throw errors.unprocessable('HERO_NOT_OWNED', 'Bu jangchi sizga tegishli emas.');
    }
    await run(db, 'UPDATE players SET favorite_hero = ?, updated_at = ? WHERE user_id = ?', value, Date.now(), ctx.user.id);
  }
  if (Object.prototype.hasOwnProperty.call(ctx.body, 'settings')) {
    const clean = sanitizeSettings(ctx.body.settings);
    const row = await one(db, 'SELECT settings FROM players WHERE user_id = ?', ctx.user.id);
    const merged = { ...parseSettings(row?.settings), ...clean };
    await run(db, 'UPDATE players SET settings = ?, updated_at = ? WHERE user_id = ?', serializeSettings(merged), Date.now(), ctx.user.id);
  }
  return jsonResponse({ player: await playerSnapshot(ctx.env, ctx.config, ctx.catalog, ctx.user.id) });
}

async function refreshPlayerTokens(ctx) {
  const result = await refreshTokens(ctx.env.DB, ctx.user.id, ctx.config.economy);
  return jsonResponse({ tokens: result?.tokens ?? 0, updatedAt: result?.updatedAt });
}

async function transactions(ctx) {
  const limit = Math.min(100, Math.max(1, Number.parseInt(ctx.url.searchParams.get('limit') || '30', 10) || 30));
  const rows = await all(
    ctx.env.DB,
    'SELECT id, type, currency, amount, balance_after, ref, meta, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    ctx.user.id,
    limit
  );
  return jsonResponse({
    transactions: rows.map((row) => ({
      id: row.id,
      type: row.type,
      currency: row.currency,
      amount: row.amount,
      balanceAfter: row.balance_after,
      ref: row.ref,
      meta: row.meta ? safeJson(row.meta) : null,
      createdAt: row.created_at,
    })),
  });
}

async function playerTournaments(ctx) {
  const limit = Math.min(100, Math.max(1, Number.parseInt(ctx.url.searchParams.get('limit') || '30', 10) || 30));
  const rows = await all(
    ctx.env.DB,
    `SELECT id, run_id, hero_id, size, status, champion, forfeit, placement, wins, base_total, total_awarded,
            coins, diamonds, created_at, settled_at
       FROM tournaments WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    ctx.user.id,
    limit
  );
  return jsonResponse({
    tournaments: rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      heroId: row.hero_id,
      size: row.size,
      status: row.status,
      champion: Boolean(row.champion),
      forfeit: Boolean(row.forfeit),
      placement: row.placement,
      wins: row.wins,
      baseTotal: row.base_total,
      totalAwarded: row.total_awarded,
      coins: row.coins,
      diamonds: row.diamonds,
      createdAt: row.created_at,
      settledAt: row.settled_at,
    })),
  });
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/* ---------- handlers: state ---------- */
async function getState(ctx) {
  const stored = await loadState(ctx.env, ctx.user.id);
  return jsonResponse({
    state: stored ? stored.state : null,
    version: stored ? stored.version : 0,
    updatedAt: stored ? stored.updatedAt : null,
  });
}

async function putState(ctx) {
  return jsonResponse(await saveState(ctx.env, ctx.config, ctx.catalog, ctx.user.id, ctx.body.state));
}

/* ---------- handlers: shop ---------- */
async function listShopHeroes(ctx) {
  const owned = new Set(
    (await all(ctx.env.DB, 'SELECT hero_id FROM owned_heroes WHERE user_id = ?', ctx.user.id)).map((row) => row.hero_id)
  );
  return jsonResponse({
    heroes: ctx.catalog.heroes
      .filter((hero) => hero.purchasable)
      .map((hero) => ({ ...ctx.catalog.heroSummary(hero), owned: owned.has(hero.id) })),
  });
}

async function buyHero(ctx) {
  const db = ctx.env.DB;
  const heroId = requireString(ctx.body.heroId, 'heroId', { min: 1, max: 60 });
  const currency = ctx.body.currency === undefined ? 'coin' : requireString(ctx.body.currency, 'currency', { min: 4, max: 10 });
  const hero = ctx.catalog.getHero(heroId);
  if (!hero) throw errors.notFound('Bunday jangchi topilmadi.');
  if (!hero.purchasable) throw errors.unprocessable('HERO_NOT_PURCHASABLE', 'Bu jangchi sotilmaydi.');
  if (currency !== 'coin' && currency !== 'diamond') {
    throw errors.unprocessable('INVALID_CURRENCY', 'Valyuta coin yoki diamond bo‘lishi kerak.');
  }
  if (hero.diamondOnly && currency === 'coin') {
    throw errors.unprocessable('DIAMOND_ONLY', 'S va Z darajadagi jangchilar faqat almazga olinadi.');
  }
  const owned = await one(db, 'SELECT 1 AS owned FROM owned_heroes WHERE user_id = ? AND hero_id = ?', ctx.user.id, heroId);
  if (owned) throw errors.conflict('HERO_ALREADY_OWNED', 'Bu jangchi allaqachon sizda.');
  const row = await one(db, 'SELECT coins, diamonds, tokens FROM players WHERE user_id = ?', ctx.user.id);
  const price = currency === 'diamond' ? hero.prices.diamonds : hero.prices.coins;
  const column = currency === 'diamond' ? 'diamonds' : 'coins';
  const balance = Number(row?.[column]) || 0;
  if (balance < price) {
    throw errors.unprocessable('INSUFFICIENT_FUNDS', 'Mablag‘ yetarli emas.', {
      required: price,
      balance,
      currency,
    });
  }
  const nextBalance = balance - price;
  const now = Date.now();
  try {
    await batch(db, [
      stmt(db, `UPDATE players SET ${column} = ?, updated_at = ? WHERE user_id = ?`, nextBalance, now, ctx.user.id),
      stmt(
        db,
        `INSERT INTO owned_heroes (user_id, hero_id, source, price, currency, acquired_at)
         VALUES (?, ?, 'purchase', ?, ?, ?)`,
        ctx.user.id,
        heroId,
        price,
        currency,
        now
      ),
      transactionStatement(db, {
        userId: ctx.user.id,
        type: 'hero_purchase',
        currency,
        amount: -price,
        balanceAfter: nextBalance,
        ref: `hero:${heroId}`,
        meta: { heroId, heroName: hero.name },
        at: now,
      }),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed: owned_heroes/i.test(String(error?.message || ''))) {
      throw errors.conflict('HERO_ALREADY_OWNED', 'Bu jangchi allaqachon sizda.');
    }
    throw error;
  }
  return jsonResponse({
    hero: ctx.catalog.heroSummary(hero),
    paid: { amount: price, currency },
    wallet: { ...walletOf({ ...row, [column]: nextBalance }) },
  });
}

async function buyMap(ctx) {
  const db = ctx.env.DB;
  const mapId = requireString(ctx.body.mapId, 'mapId', { min: 1, max: 60 });
  const map = ctx.catalog.getMap(mapId);
  if (!map) throw errors.notFound('Bunday arena topilmadi.');
  const owned = await one(db, 'SELECT 1 AS owned FROM owned_maps WHERE user_id = ? AND map_id = ?', ctx.user.id, mapId);
  if (owned) throw errors.conflict('MAP_ALREADY_OWNED', 'Bu arena allaqachon sizda.');
  const row = await one(db, 'SELECT coins, diamonds, tokens, total FROM players WHERE user_id = ?', ctx.user.id);
  const level = accountLevel(row?.total, ctx.catalog.ranks);
  if (map.rankRequired && level < map.rankRequired) {
    throw errors.forbidden(`Bu arena ${map.rankRequired}-account rankda ochiladi. Hozirgi rank: ${level}.`);
  }
  const price = map.price || 0;
  if (price > 0 && Number(row?.coins) < price) {
    throw errors.unprocessable('INSUFFICIENT_FUNDS', 'Tangalar yetmaydi.', {
      required: price,
      balance: Number(row?.coins),
      currency: 'coin',
    });
  }
  const now = Date.now();
  const statements = [
    stmt(
      db,
      'UPDATE players SET coins = coins - ?, map_id = ?, updated_at = ? WHERE user_id = ? AND coins >= ?',
      price,
      mapId,
      now,
      ctx.user.id,
      price
    ),
    stmt(db, 'INSERT INTO owned_maps (user_id, map_id, acquired_at) VALUES (?, ?, ?)', ctx.user.id, mapId, now),
  ];
  if (price > 0) {
    statements.push(
      transactionStatement(db, {
        userId: ctx.user.id,
        type: 'map_purchase',
        currency: 'coin',
        amount: -price,
        balanceAfter: Number(row.coins) - price,
        ref: `map:${mapId}`,
        meta: { mapId, mapName: map.name },
        at: now,
      })
    );
  }
  await batch(db, statements);
  const updated = await one(db, 'SELECT coins, diamonds, tokens FROM players WHERE user_id = ?', ctx.user.id);
  return jsonResponse({ map, wallet: walletOf(updated) });
}

async function selectMap(ctx) {
  const db = ctx.env.DB;
  const mapId = requireString(ctx.body.mapId, 'mapId', { min: 1, max: 60 });
  const map = ctx.catalog.getMap(mapId);
  if (!map) throw errors.notFound('Bunday arena topilmadi.');
  const row = await one(db, 'SELECT total FROM players WHERE user_id = ?', ctx.user.id);
  const level = accountLevel(row?.total, ctx.catalog.ranks);
  if (map.rankRequired && level < map.rankRequired) {
    throw errors.forbidden(`Bu arena ${map.rankRequired}-account rankda ochiladi. Hozirgi rank: ${level}.`);
  }
  if (!map.rankRequired) {
    const owned = await one(db, 'SELECT 1 AS owned FROM owned_maps WHERE user_id = ? AND map_id = ?', ctx.user.id, mapId);
    if (!owned) throw errors.unprocessable('MAP_NOT_OWNED', 'Avval bu arenani sotib oling.');
  }
  await run(db, 'UPDATE players SET map_id = ?, updated_at = ? WHERE user_id = ?', mapId, Date.now(), ctx.user.id);
  return jsonResponse({ selected: mapId, map });
}

/* ---------- handlers: progress ---------- */
const LEVEL_REWARD_MULTIPLIER = 2;
const levelReward = (level, isBoss) => (20 + level * 5) * (isBoss ? 2 : 1) * LEVEL_REWARD_MULTIPLIER;

async function completeLevel(ctx) {
  const db = ctx.env.DB;
  const level = optionalInt(ctx.body.level, 'level', { min: 1, max: ctx.config.economy.maxLevel });
  const won = requireBoolean(ctx.body.won, 'won');
  if (level === null) throw errors.unprocessable('INVALID_LEVEL', 'Level kiritilishi kerak.');
  await refreshTokens(db, ctx.user.id, ctx.config.economy);
  const row = await one(db, 'SELECT * FROM players WHERE user_id = ?', ctx.user.id);
  if (!row) throw errors.unauthorized();
  const now = Date.now();
  const lastRun = await one(db, 'SELECT created_at FROM level_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', ctx.user.id);
  if (lastRun && now - Number(lastRun.created_at) < ctx.config.economy.levelCooldownMs) {
    throw new HttpError(429, 'LEVEL_COOLDOWN', 'Janglar orasida biroz tanaffus qiling.');
  }
  if (level > Number(row.level) + 1) throw errors.conflict('LEVEL_LOCKED', 'Avval oldingi levelni yeching.');
  const today = await one(
    db,
    'SELECT COUNT(*) AS count FROM level_runs WHERE user_id = ? AND created_at >= ?',
    ctx.user.id,
    startOfToday(now)
  );
  if (Number(today?.count) >= ctx.config.economy.levelDailyLimit) {
    throw new HttpError(429, 'DAILY_LIMIT', 'Bugungi level janglari limiti tugadi.');
  }
  if (Number(row.tokens) < 1) throw new HttpError(429, 'NO_TOKENS', 'Token yo‘q. Har 2 soatda 1 token beriladi.');
  const isBoss = level % 10 === 0;
  const reward = won ? levelReward(level, isBoss) : 0;
  const tokens = won
    ? Math.min(ctx.config.economy.maxTokens, Number(row.tokens) + 1)
    : Math.max(0, Number(row.tokens) - 1);
  const coins = Number(row.coins) + reward;
  const wins = Number(row.wins) + (won ? 1 : 0);
  const losses = Number(row.losses) + (won ? 0 : 1);
  const highest = won ? Math.max(Number(row.level), level) : Number(row.level);
  const statements = [
    stmt(
      db,
      `UPDATE players SET coins = ?, tokens = ?, tokens_updated_at = ?, level = ?, wins = ?, losses = ?, updated_at = ?
        WHERE user_id = ?`,
      coins,
      tokens,
      now,
      highest,
      wins,
      losses,
      now,
      ctx.user.id
    ),
    stmt(
      db,
      'INSERT INTO level_runs (id, user_id, level, won, reward, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      crypto.randomUUID(),
      ctx.user.id,
      level,
      won ? 1 : 0,
      reward,
      now
    ),
  ];
  if (reward > 0) {
    statements.push(
      transactionStatement(db, {
        userId: ctx.user.id,
        type: 'level_reward',
        currency: 'coin',
        amount: reward,
        balanceAfter: coins,
        ref: `level:${level}`,
        meta: { level, boss: isBoss },
        at: now,
      })
    );
  }
  await batch(db, statements);
  return jsonResponse({
    level,
    won,
    boss: isBoss,
    reward,
    wallet: { coins, diamonds: Number(row.diamonds), tokens },
    progress: { level: highest, wins, losses },
  });
}

function gapWeight(gap) {
  if (gap >= 2) return 1.15;
  if (gap === 1) return 1.1;
  if (gap === 0) return 1;
  if (gap === -1) return 0.75;
  return 0.5;
}

function computeBaseTotal({ heroTier, champion, forfeit, wins }) {
  const ownIndex = TIER_ORDER.indexOf(heroTier);
  const gapOf = (tier) => TIER_ORDER.indexOf(tier) - ownIndex;
  const validWins = wins.filter((entry) => entry.won);
  if (champion) {
    const average =
      validWins.reduce((sum, entry) => sum + gapWeight(gapOf(entry.opponentTier)), 0) /
      Math.max(1, validWins.length);
    return Math.min(10, Math.max(5, Math.round(10 * average)));
  }
  if (forfeit) return 0;
  const strong = validWins.filter((entry) => gapOf(entry.opponentTier) >= 0).length;
  if (strong >= 3) return 5;
  if (strong === 2) return 4;
  if (strong === 1) return 3;
  return 0;
}

async function startTournament(ctx) {
  const db = ctx.env.DB;
  const heroId = requireString(ctx.body.heroId, 'heroId', { min: 1, max: 60 });
  const paidSelection = ctx.body.paidSelection === undefined ? false : requireBoolean(ctx.body.paidSelection, 'paidSelection');
  const hero = ctx.catalog.getHero(heroId);
  if (!hero) throw errors.notFound('Bunday jangchi topilmadi.');
  const active = await one(db, "SELECT run_id FROM tournaments WHERE user_id = ? AND status = 'active'", ctx.user.id);
  if (active) throw errors.conflict('TOURNAMENT_IN_PROGRESS', 'Sizda tugallanmagan turnir bor.');
  const last = await one(
    db,
    "SELECT settled_at FROM tournaments WHERE user_id = ? AND status = 'settled' ORDER BY settled_at DESC LIMIT 1",
    ctx.user.id
  );
  const now = Date.now();
  if (last?.settled_at && now - Number(last.settled_at) < ctx.config.economy.tournamentCooldownMs) {
    throw new HttpError(429, 'TOURNAMENT_COOLDOWN', 'Turnirlar orasida qisqa tanaffus kerak.');
  }
  const owned = await one(db, 'SELECT 1 AS owned FROM owned_heroes WHERE user_id = ? AND hero_id = ?', ctx.user.id, heroId);
  if (!owned && !paidSelection) throw errors.unprocessable('HERO_NOT_OWNED', 'Bu jangchi sizga tegishli emas.');
  const row = await one(db, 'SELECT * FROM players WHERE user_id = ?', ctx.user.id);
  const selectionCost = paidSelection ? ctx.config.economy.tournamentSelectionCost : 0;
  if (selectionCost > 0 && Number(row.diamonds) < selectionCost) {
    throw errors.unprocessable('INSUFFICIENT_DIAMONDS', 'Almaz yetmaydi.', {
      required: selectionCost,
      balance: Number(row.diamonds),
      currency: 'diamond',
    });
  }
  const runId = `cup-${now}-${Math.floor(Math.random() * 1e8)}`;
  const statements = [];
  if (selectionCost > 0) {
    statements.push(
      stmt(
        db,
        'UPDATE players SET diamonds = diamonds - ?, updated_at = ? WHERE user_id = ? AND diamonds >= ?',
        selectionCost,
        now,
        ctx.user.id,
        selectionCost
      ),
      transactionStatement(db, {
        userId: ctx.user.id,
        type: 'tournament_selection',
        currency: 'diamond',
        amount: -selectionCost,
        balanceAfter: Number(row.diamonds) - selectionCost,
        ref: `hero:${heroId}`,
        meta: { heroId, heroName: hero.name },
        at: now,
      })
    );
  }
  statements.push(
    stmt(
      db,
      `INSERT INTO tournaments (id, user_id, run_id, hero_id, size, selection_cost, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      crypto.randomUUID(),
      ctx.user.id,
      runId,
      heroId,
      ctx.config.economy.tournamentSize,
      selectionCost,
      now
    )
  );
  await batch(db, statements);
  return jsonResponse(
    {
      runId,
      hero: ctx.catalog.heroSummary(hero),
      size: ctx.config.economy.tournamentSize,
      selectionCost,
      wallet: { coins: Number(row.coins), diamonds: Number(row.diamonds) - selectionCost, tokens: Number(row.tokens) },
    },
    201
  );
}

async function completeTournament(ctx) {
  const db = ctx.env.DB;
  const runId = requireString(ctx.body.runId, 'runId', { min: 6, max: 80 });
  const champion = requireBoolean(ctx.body.champion, 'champion');
  const forfeit = ctx.body.forfeit === undefined ? false : requireBoolean(ctx.body.forfeit, 'forfeit');
  if (champion && forfeit) throw errors.unprocessable('INVALID_RESULT', 'Chempion turnirdan chiqqan bo‘lishi mumkin emas.');
  const wins = Array.isArray(ctx.body.wins) ? ctx.body.wins : [];
  if (wins.length > ctx.config.economy.tournamentSize - 1) {
    throw errors.unprocessable('INVALID_RESULT', 'wins jadvali noto‘g‘ri.');
  }
  const normalizedWins = wins.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.won !== 'boolean') {
      throw errors.unprocessable('INVALID_RESULT', 'Har bir jang natijasi noto‘g‘ri.');
    }
    if (!TIER_ORDER.includes(entry.opponentTier)) {
      throw errors.unprocessable('INVALID_RESULT', 'opponentTier E–Z oralig‘ida bo‘lishi kerak.');
    }
    return { opponentTier: entry.opponentTier, won: entry.won };
  });
  const tournament = await one(
    db,
    "SELECT * FROM tournaments WHERE user_id = ? AND run_id = ? AND status = 'active'",
    ctx.user.id,
    runId
  );
  if (!tournament) throw errors.notFound('Faol turnir topilmadi yoki u allaqachon yakunlangan.');
  const hero = ctx.catalog.getHero(tournament.hero_id);
  const now = Date.now();
  const today = await one(
    db,
    "SELECT COUNT(*) AS count FROM tournaments WHERE user_id = ? AND status = 'settled' AND settled_at >= ?",
    ctx.user.id,
    startOfToday(now)
  );
  if (Number(today?.count) >= ctx.config.economy.tournamentDailyLimit) {
    throw new HttpError(429, 'DAILY_LIMIT', 'Bugungi turnir limiti tugadi.');
  }
  const row = await one(db, 'SELECT * FROM players WHERE user_id = ?', ctx.user.id);
  const baseTotal = computeBaseTotal({
    heroTier: hero?.tier || 'E',
    champion,
    forfeit,
    wins: normalizedWins,
  });
  const levelBefore = accountLevel(Number(row.total), ctx.catalog.ranks);
  const awarded = round2(baseTotal * totalMultiplier(levelBefore));
  const totalAfter = round2(Number(row.total) + awarded);
  const coins = Number(row.coins) + (champion ? ctx.config.economy.tournamentPrizeCoins : 0);
  const diamonds = Number(row.diamonds) + (champion ? ctx.config.economy.tournamentPrizeDiamonds : 0);
  const winsCount = normalizedWins.filter((entry) => entry.won).length;
  const statements = [
    stmt(
      db,
      'UPDATE players SET coins = ?, diamonds = ?, total = ?, updated_at = ? WHERE user_id = ? AND EXISTS (SELECT 1 FROM tournaments WHERE id = ? AND status = \'active\')',
      coins,
      diamonds,
      totalAfter,
      now,
      ctx.user.id,
      tournament.id
    ),
    stmt(
      db,
      `UPDATE tournaments SET status = 'settled', champion = ?, forfeit = ?, placement = ?, wins = ?,
              base_total = ?, total_awarded = ?, coins = ?, diamonds = ?, payload = ?, settled_at = ?
        WHERE id = ? AND status = 'active'`,
      champion ? 1 : 0,
      forfeit ? 1 : 0,
      typeof ctx.body.placement === 'string' ? ctx.body.placement.slice(0, 20) : null,
      winsCount,
      baseTotal,
      awarded,
      champion ? ctx.config.economy.tournamentPrizeCoins : 0,
      champion ? ctx.config.economy.tournamentPrizeDiamonds : 0,
      JSON.stringify({ wins: normalizedWins }),
      now,
      tournament.id
    ),
  ];
  if (champion) {
    statements.push(
      transactionStatement(db, {
        userId: ctx.user.id,
        type: 'tournament_reward',
        currency: 'coin',
        amount: ctx.config.economy.tournamentPrizeCoins,
        balanceAfter: coins,
        ref: runId,
        meta: { placement: ctx.body.placement || '1', wins: winsCount },
        at: now,
      }),
      transactionStatement(db, {
        userId: ctx.user.id,
        type: 'tournament_reward',
        currency: 'diamond',
        amount: ctx.config.economy.tournamentPrizeDiamonds,
        balanceAfter: diamonds,
        ref: runId,
        meta: { placement: ctx.body.placement || '1' },
        at: now,
      })
    );
  }
  if (awarded > 0) {
    statements.push(
      transactionStatement(db, {
        userId: ctx.user.id,
        type: 'total_award',
        currency: 'total',
        amount: awarded,
        balanceAfter: totalAfter,
        ref: runId,
        meta: { base: baseTotal, multiplier: totalMultiplier(levelBefore) },
        at: now,
      })
    );
  }
  await batch(db, statements);
  const levelAfter = accountLevel(totalAfter, ctx.catalog.ranks);
  const rankAfter = accountRank(totalAfter, ctx.catalog.ranks);
  return jsonResponse({
    runId,
    champion,
    forfeit,
    wins: winsCount,
    rewards: {
      coins: champion ? ctx.config.economy.tournamentPrizeCoins : 0,
      diamonds: champion ? ctx.config.economy.tournamentPrizeDiamonds : 0,
      total: awarded,
      baseTotal,
    },
    progress: {
      total: totalAfter,
      accountLevel: levelAfter,
      previousAccountLevel: levelBefore,
      accountRank: rankAfter ? { level: rankAfter.level, name: rankAfter.name } : null,
      rankedUp: levelAfter > levelBefore,
    },
    wallet: { coins, diamonds, tokens: Number(row.tokens) },
  });
}

/* ---------- handlers: leaderboard ---------- */
const SORTS = {
  total: 'p.total DESC, p.wins DESC, p.coins DESC',
  coins: 'p.coins DESC, p.total DESC',
  wins: 'p.wins DESC, p.total DESC',
  level: 'p.level DESC, p.total DESC',
};

async function leaderboard(ctx) {
  const sortKey = SORTS[ctx.url.searchParams.get('sort')] ? ctx.url.searchParams.get('sort') : 'total';
  const limit = Math.min(100, Math.max(1, Number.parseInt(ctx.url.searchParams.get('limit') || '25', 10) || 25));
  const rows = await all(
    ctx.env.DB,
    `SELECT u.nickname, p.total, p.coins, p.wins, p.losses, p.level
       FROM players p JOIN users u ON u.id = p.user_id
      ORDER BY ${SORTS[sortKey]}
      LIMIT ?`,
    limit
  );
  return jsonResponse({
    sort: sortKey,
    leaders: rows.map((row, index) => ({
      rank: index + 1,
      nickname: row.nickname,
      total: row.total,
      coins: row.coins,
      wins: row.wins,
      losses: row.losses,
      level: row.level,
    })),
  });
}

/* ---------- handlers: live ---------- */
async function liveState(ctx) {
  return jsonResponse(await getLiveState(ctx.env, ctx.config, ctx.catalog, ctx.user.id));
}
async function liveHistory(ctx) {
  return jsonResponse({ history: await getLiveHistory(ctx.env, ctx.config, ctx.catalog, ctx.user.id) });
}
async function liveEnter(ctx) {
  const heroId = requireString(ctx.body.heroId, 'heroId', { min: 1, max: 60 });
  await joinLive(ctx.env, ctx.config, ctx.catalog, ctx.user.id, heroId);
  return jsonResponse(await getLiveState(ctx.env, ctx.config, ctx.catalog, ctx.user.id));
}
async function liveLeave(ctx) {
  await leaveLive(ctx.env, ctx.config, ctx.user.id);
  return jsonResponse(await getLiveState(ctx.env, ctx.config, ctx.catalog, ctx.user.id));
}

/* ---------- handlers: admin ---------- */
function requireAdmin(user) {
  if (!user || user.role !== 'admin') throw errors.forbidden('Bu bo‘lim faqat admin uchun.');
}

async function adminUsers(ctx) {
  requireAdmin(ctx.user);
  const search = (ctx.url.searchParams.get('q') || '').trim().slice(0, 120);
  const limit = Math.min(100, Math.max(1, Number.parseInt(ctx.url.searchParams.get('limit') || '50', 10) || 50));
  const offset = Math.max(0, Number.parseInt(ctx.url.searchParams.get('offset') || '0', 10) || 0);
  const like = `%${search}%`;
  const rows = await all(
    ctx.env.DB,
    `SELECT u.id, u.nickname, u.email, u.first_name, u.last_name, u.role, u.created_at, u.last_login_at,
            p.coins, p.diamonds, p.tokens, p.level, p.wins, p.losses, p.total
       FROM users u LEFT JOIN players p ON p.user_id = u.id
      WHERE (? = '' OR u.nickname LIKE ? OR u.email LIKE ?)
      ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
    search,
    like,
    like,
    limit,
    offset
  );
  const total = await one(
    ctx.env.DB,
    "SELECT COUNT(*) AS count FROM users WHERE (? = '' OR nickname LIKE ? OR email LIKE ?)",
    search,
    like,
    like
  );
  return jsonResponse({
    total: Number(total?.count) || 0,
    limit,
    offset,
    users: rows.map((row) => ({
      id: row.id,
      nickname: row.nickname,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      role: row.role,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      wallet: {
        coins: Number(row.coins) || 0,
        diamonds: Number(row.diamonds) || 0,
        tokens: Number(row.tokens) || 0,
      },
      progress: {
        level: Number(row.level) || 0,
        wins: Number(row.wins) || 0,
        losses: Number(row.losses) || 0,
        total: Number(row.total) || 0,
      },
    })),
  });
}

async function adminGrant(ctx) {
  requireAdmin(ctx.user);
  const targetId = requireString(ctx.body.userId, 'userId', { min: 1, max: 64 });
  const amount = optionalInt(ctx.body.amount, 'amount', { min: 1, max: 1_000_000 });
  const note = typeof ctx.body.note === 'string' ? ctx.body.note.trim().slice(0, 160) : '';
  if (amount === null) throw errors.unprocessable('VALIDATION_FAILED', 'O‘tkaziladigan almaz miqdorini kiriting.');
  const target = await one(
    ctx.env.DB,
    'SELECT u.id, u.nickname, u.email, p.diamonds FROM users u LEFT JOIN players p ON p.user_id = u.id WHERE u.id = ?',
    targetId
  );
  if (!target) throw errors.notFound('Foydalanuvchi topilmadi.');
  const wallet = await applyWalletDelta(ctx.env, targetId, { diamonds: amount });
  if (!wallet) throw errors.notFound('Foydalanuvchi hamyoni topilmadi.');
  const now = Date.now();
  await batch(ctx.env.DB, [
    transactionStatement(ctx.env.DB, {
      userId: targetId,
      type: 'admin_diamond_grant',
      currency: 'diamond',
      amount,
      balanceAfter: wallet.diamonds,
      ref: `admin:${ctx.user.id}`,
      meta: { adminId: ctx.user.id, adminNickname: ctx.user.nickname, note },
      at: now,
    }),
    stmt(
      ctx.env.DB,
      `INSERT INTO admin_audit
         (id, admin_user_id, target_user_id, action, currency, amount, note, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, 'diamond_grant', 'diamond', ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      ctx.user.id,
      targetId,
      amount,
      note || null,
      Number(target.diamonds) || 0,
      wallet.diamonds,
      now
    ),
  ]);
  return jsonResponse({
    user: { id: target.id, nickname: target.nickname, email: target.email },
    wallet,
  });
}

async function adminAudit(ctx) {
  requireAdmin(ctx.user);
  const limit = Math.min(100, Math.max(1, Number.parseInt(ctx.url.searchParams.get('limit') || '30', 10) || 30));
  const rows = await all(
    ctx.env.DB,
    `SELECT a.id, a.action, a.currency, a.amount, a.note, a.balance_before, a.balance_after, a.created_at,
            admin.nickname AS admin_nickname, target.nickname AS target_nickname
       FROM admin_audit a
       JOIN users admin ON admin.id = a.admin_user_id
       JOIN users target ON target.id = a.target_user_id
      ORDER BY a.created_at DESC LIMIT ?`,
    limit
  );
  return jsonResponse({
    audit: rows.map((row) => ({
      id: row.id,
      action: row.action,
      currency: row.currency,
      amount: row.amount,
      note: row.note,
      balanceBefore: row.balance_before,
      balanceAfter: row.balance_after,
      createdAt: row.created_at,
      admin: row.admin_nickname,
      target: row.target_nickname,
    })),
  });
}

/* ---------- routes ---------- */
const ROUTES = [
  { method: 'GET', path: '/api/health', handler: health, public: true },
  { method: 'GET', path: '/api/config', handler: publicConfig, public: true },
  { method: 'POST', path: '/api/auth/register', handler: register, public: true, authLimit: true },
  { method: 'POST', path: '/api/auth/login', handler: login, public: true, authLimit: true },
  { method: 'POST', path: '/api/auth/logout', handler: logout, public: true },
  { method: 'GET', path: '/api/auth/me', handler: me },
  { method: 'GET', path: '/api/player', handler: getPlayer },
  { method: 'PATCH', path: '/api/player', handler: patchPlayer },
  { method: 'POST', path: '/api/player/tokens/refresh', handler: refreshPlayerTokens },
  { method: 'GET', path: '/api/player/transactions', handler: transactions },
  { method: 'GET', path: '/api/player/tournaments', handler: playerTournaments },
  { method: 'GET', path: '/api/player/state', handler: getState },
  { method: 'PUT', path: '/api/player/state', handler: putState },
  { method: 'GET', path: '/api/live/state', handler: liveState },
  { method: 'GET', path: '/api/live/history', handler: liveHistory },
  { method: 'POST', path: '/api/live/enter', handler: liveEnter },
  { method: 'POST', path: '/api/live/leave', handler: liveLeave },
  { method: 'GET', path: '/api/catalog', handler: catalogOverview, public: true },
  { method: 'GET', path: '/api/catalog/heroes', handler: catalogHeroes, public: true },
  { method: 'GET', path: '/api/catalog/heroes/:id', handler: catalogHero, public: true },
  { method: 'GET', path: '/api/catalog/tiers', handler: catalogTiers, public: true },
  { method: 'GET', path: '/api/catalog/ranks', handler: catalogRanks, public: true },
  { method: 'GET', path: '/api/catalog/maps', handler: catalogMaps, public: true },
  { method: 'GET', path: '/api/catalog/monsters', handler: catalogMonsters, public: true },
  { method: 'GET', path: '/api/shop/heroes', handler: listShopHeroes },
  { method: 'POST', path: '/api/shop/heroes/buy', handler: buyHero },
  { method: 'POST', path: '/api/shop/maps/buy', handler: buyMap },
  { method: 'POST', path: '/api/shop/maps/select', handler: selectMap },
  { method: 'POST', path: '/api/progress/levels/complete', handler: completeLevel },
  { method: 'POST', path: '/api/progress/tournaments/start', handler: startTournament },
  { method: 'POST', path: '/api/progress/tournaments/complete', handler: completeTournament },
  { method: 'GET', path: '/api/leaderboard', handler: leaderboard, public: true },
  { method: 'GET', path: '/api/admin/users', handler: adminUsers },
  { method: 'POST', path: '/api/admin/diamonds', handler: adminGrant },
  { method: 'GET', path: '/api/admin/audit', handler: adminAudit },
];

const COMPILED = ROUTES.map((route) => {
  const keys = [];
  const pattern = route.path
    .split('/')
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith(':')) {
        keys.push(part.slice(1));
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { ...route, regex: new RegExp(`^/${pattern}/?$`), keys };
});

/* ---------- static ---------- */
async function serveAsset(request, env, url) {
  let response = await env.ASSETS.fetch(request);
  if (response.status === 404 && (url.pathname === '/' || url.pathname === '/index.html')) {
    response = await env.ASSETS.fetch(new Request(new URL('/index.html', url).toString()));
  }
  if (response.status === 404) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  headers.set('Cross-Origin-Resource-Policy', 'same-site');
  const type = headers.get('content-type') || '';
  if (type.includes('text/html')) {
    const isGame = url.pathname === '/' || url.pathname === '/index.html';
    headers.set('Content-Security-Policy', isGame ? GAME_CSP : CONSOLE_CSP);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/* ---------- worker entry ---------- */
function corsHeaders(request, config) {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  const urlOrigin = new URL(request.url).origin;
  if (origin === urlOrigin || config.corsOrigins.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
    };
  }
  return {};
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const started = Date.now();

    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('origin');
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '600',
          'Cache-Control': 'no-store',
          ...(origin
            ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' }
            : {}),
        },
      });
    }

    if (!url.pathname.startsWith('/api')) {
      if (url.pathname === '/console' || url.pathname === '/console/') {
        return Response.redirect(new URL('/console.html', url).toString(), 302);
      }
      return serveAsset(request, env, url);
    }

    const config = getConfig(env);
    const cors = corsHeaders(request, config);
    try {
      const catalog = await loadCatalog(env, request);
      const route = COMPILED.find((candidate) => candidate.method === request.method && candidate.regex.test(url.pathname));
      if (!route) throw errors.notFound(`Endpoint topilmadi: ${request.method} ${url.pathname}`);

      const ip = clientIp(request);
      const retryAfter = rateLimited(`${route.authLimit ? 'auth' : 'api'}:${ip}`, route.authLimit ? 12 : 180);
      if (retryAfter) throw errors.tooManyRequests(retryAfter);

      const match = url.pathname.match(route.regex);
      const params = {};
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(match[index + 1]);
      });

      const user = route.public ? null : await authenticate(request, env);
      if (!route.public && !user) throw errors.unauthorized();

      const needsBody = !['GET', 'HEAD', 'DELETE'].includes(request.method);
      const body = needsBody
        ? await readJson(request, url.pathname === '/api/player/state' ? config.stateLimit : config.bodyLimit)
        : {};

      const ctx = { request, env, url, config, catalog, params, body, user, ip };
      const response = await route.handler(ctx);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) headers.set(key, value);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('X-Frame-Options', 'DENY');
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      const status = Number(error?.status) || 500;
      const code = error?.code || (status === 500 ? 'INTERNAL' : 'ERROR');
      if (status >= 500) console.error(`API ERROR ${request.method} ${url.pathname}:`, error?.stack || error);
      const headers = { 'Cache-Control': 'no-store', ...cors };
      return jsonResponse(
        {
          error: {
            code,
            message: status >= 500 ? 'Ichki xatolik.' : error?.message || 'Ichki xatolik.',
            ...(error?.details ? { details: error.details } : {}),
          },
        },
        status,
        headers
      );
    } finally {
      const elapsed = Date.now() - started;
      if (elapsed > 2000) console.warn(`SLOW ${request.method} ${url.pathname} ${elapsed}ms`);
    }
  },

  async scheduled(event, env, ctx) {
    const config = getConfig(env);
    const catalog = await loadCatalog(env, new Request('https://anime-arena-top.local/'));
    ctx.waitUntil(tickLive(env, config, catalog));
  },
};
