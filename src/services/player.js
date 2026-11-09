'use strict';

const { randomUUID } = require('node:crypto');
const { errors } = require('../util/http');

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

/** Mirrors the game's account rank ladder. */
function accountLevel(total, ranks) {
  const value = Number(total) || 0;
  return ranks.filter((rank) => value >= rank.totalRequired).length;
}

function accountRank(total, ranks) {
  const level = accountLevel(total, ranks);
  return level > 0 ? ranks[level - 1] : null;
}

function totalMultiplier(level) {
  return 1 + Math.max(0, Math.min(6, (Number(level) || 0) - 1)) * 0.025;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function recordTransaction(db, entry) {
  db.prepare(
    `INSERT INTO transactions (id, user_id, type, currency, amount, balance_after, ref, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
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

function createPlayer(db, userId, { testHeroIds = [], startingCoins }) {
  const now = Date.now();
  const favorite = testHeroIds[0] || null;

  db.prepare(
    `INSERT INTO players
       (user_id, coins, diamonds, tokens, tokens_updated_at, level, wins, losses, total,
        favorite_hero, map_id, settings, created_at, updated_at)
     VALUES (?, ?, 0, 8, ?, 0, 0, 0, 0, ?, 'std', ?, ?, ?)`
  ).run(userId, startingCoins, now, favorite, serializeSettings(DEFAULT_SETTINGS), now, now);

  const insertHero = db.prepare(
    `INSERT INTO owned_heroes (user_id, hero_id, source, price, currency, acquired_at)
     VALUES (?, ?, 'start', 0, NULL, ?)`
  );
  for (const heroId of testHeroIds) insertHero.run(userId, heroId, now);

  db.prepare('INSERT INTO owned_maps (user_id, map_id, acquired_at) VALUES (?, ?, ?)').run(
    userId,
    'std',
    now
  );
}

function getPlayerRow(db, userId) {
  const row = db.prepare('SELECT * FROM players WHERE user_id = ?').get(userId);
  if (!row) throw errors.unauthorized('O‘yinchi profili topilmadi.');
  return row;
}

/**
 * Regenerates tokens exactly like the client game: +1 every 2 hours, capped at 8.
 * Persists only when something actually changed.
 */
function refreshTokens(db, userId, economy) {
  const now = Date.now();
  const row = db
    .prepare('SELECT tokens, tokens_updated_at FROM players WHERE user_id = ?')
    .get(userId);
  if (!row) return null;

  let tokens = Number(row.tokens) || 0;
  let updatedAt = Number(row.tokens_updated_at) || now;

  if (tokens >= economy.maxTokens) {
    updatedAt = now;
  } else {
    const elapsed = Math.max(0, now - updatedAt);
    const gained = Math.min(
      economy.maxTokens - tokens,
      Math.floor(elapsed / economy.tokenIntervalMs)
    );
    if (gained > 0) {
      tokens += gained;
      updatedAt += gained * economy.tokenIntervalMs;
      if (tokens >= economy.maxTokens) updatedAt = now;
    }
  }

  if (tokens !== row.tokens || updatedAt !== row.tokens_updated_at) {
    db.prepare(
      'UPDATE players SET tokens = ?, tokens_updated_at = ?, updated_at = ? WHERE user_id = ?'
    ).run(tokens, updatedAt, now, userId);
  }

  return { tokens, updatedAt };
}

function nextTokenInMs(row, economy, now = Date.now()) {
  if (row.tokens >= economy.maxTokens) return 0;
  return Math.max(0, economy.tokenIntervalMs - (now - row.tokens_updated_at));
}

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

/**
 * Complete client-facing player state.
 */
function playerSnapshot(db, userId, catalog, economy) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw errors.unauthorized();

  refreshTokens(db, userId, economy);
  const row = getPlayerRow(db, userId);

  const ownedHeroes = db
    .prepare('SELECT hero_id, source, price, currency, acquired_at FROM owned_heroes WHERE user_id = ? ORDER BY acquired_at')
    .all(userId);
  const ownedMaps = db
    .prepare('SELECT map_id, acquired_at FROM owned_maps WHERE user_id = ? ORDER BY acquired_at')
    .all(userId);

  const total = round2(row.total);
  const level = accountLevel(total, catalog.ranks);
  const rank = accountRank(total, catalog.ranks);

  return {
    user: serializeUser(user),
    wallet: {
      coins: Number(row.coins),
      diamonds: Number(row.diamonds),
      tokens: Number(row.tokens),
      maxTokens: economy.maxTokens,
      nextTokenInMs: nextTokenInMs(row, economy),
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

function updateSettings(db, userId, patch) {
  const clean = sanitizeSettings(patch);
  const row = getPlayerRow(db, userId);
  const merged = { ...parseSettings(row.settings), ...clean };
  db.prepare('UPDATE players SET settings = ?, updated_at = ? WHERE user_id = ?').run(
    serializeSettings(merged),
    Date.now(),
    userId
  );
  return merged;
}

function setFavorite(db, userId, heroId, catalog) {
  if (heroId !== null && !catalog.getHero(heroId)) {
    throw errors.notFound('Bunday jangchi topilmadi.');
  }
  const owned = db
    .prepare('SELECT 1 AS owned FROM owned_heroes WHERE user_id = ? AND hero_id = ?')
    .get(userId, heroId);
  if (!owned) throw errors.unprocessable('HERO_NOT_OWNED', 'Bu jangchi sizga tegishli emas.');
  db.prepare('UPDATE players SET favorite_hero = ?, updated_at = ? WHERE user_id = ?').run(
    heroId,
    Date.now(),
    userId
  );
  return heroId;
}

function walletOf(db, userId) {
  const row = db.prepare('SELECT coins, diamonds, tokens FROM players WHERE user_id = ?').get(userId);
  return {
    coins: Number(row?.coins) || 0,
    diamonds: Number(row?.diamonds) || 0,
    tokens: Number(row?.tokens) || 0,
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  accountLevel,
  accountRank,
  totalMultiplier,
  round2,
  recordTransaction,
  createPlayer,
  getPlayerRow,
  refreshTokens,
  nextTokenInMs,
  serializeUser,
  playerSnapshot,
  updateSettings,
  setFavorite,
  walletOf,
  parseSettings,
};
