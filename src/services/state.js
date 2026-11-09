'use strict';

/**
 * Full client-state persistence for the anime-arena2 game.
 *
 * The game keeps almost everything in one object (`D`) — wallet, owned heroes,
 * maps, level, tournament history, local solo-cup state, UI selections … .
 * Rather than re-modelling every field in SQL we store the sanitised snapshot
 * as JSON and mirror the meaningful wallet/progress columns into `players`
 * (leaderboard, admin panel, live tournaments rely on those columns).
 *
 * `applyWalletDelta()` is the important bridge: when the server itself changes
 * a wallet (admin diamond transfer, live-tournament prize) the stored snapshot
 * is updated too, so the next login sees the new balance.
 */

const { transaction } = require('../db');
const { errors } = require('../util/http');

const MAX_STATE_BYTES = 512 * 1024;

const NUMBER_LIMITS = {
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

const STRING_FIELDS = ['map', 'fav'];
const STRING_ARRAY_FIELDS = ['own', 'maps'];
const OBJECT_FIELDS = ['hs', 'sel', 'diamondClaims', 'totalClaims', 'tours'];
const HISTORY_FIELDS = ['diamondHistory', 'tournamentHistory', 'pinnedTournaments', 'totalHistory'];

function clampNumber(value, [min, max], fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function cleanString(value, max = 80) {
  return typeof value === 'string' ? value.slice(0, max) : null;
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
      for (const [k, v] of Object.entries(entry)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          nested[k] = Math.max(0, Math.min(1e12, Math.round(v * 100) / 100));
        } else if (typeof v === 'string' && v.length <= 120) {
          nested[k] = v;
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
      const clone = JSON.parse(JSON.stringify(entry));
      out.push(clone);
    } catch {
      /* skip non-serialisable entry */
    }
  }
  return out;
}

/**
 * Reduce an arbitrary client payload to the fields the game actually uses.
 * Unknown keys are dropped; numbers are clamped to sane ranges.
 */
function sanitizeState(input, catalog) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw errors.badRequest('state obyekt bo‘lishi kerak.');
  }

  const clean = {};

  for (const [key, limits] of Object.entries(NUMBER_LIMITS)) {
    clean[key] = clampNumber(input[key], limits, key === 'tok' ? 8 : 0);
  }
  if (clean.tokT === 0) clean.tokT = Date.now();

  for (const key of STRING_FIELDS) {
    const value = cleanString(input[key]);
    if (value !== null) clean[key] = value;
  }

  clean.own = cleanStringList(input.own).filter((id) => !catalog || catalog.getHero(id));
  clean.maps = cleanStringList(input.maps).filter((id) => !catalog || catalog.getMap(id));

  for (const key of OBJECT_FIELDS) {
    clean[key] = cleanFlatObject(input[key], key === 'tours' ? 12 : 500);
  }
  // `tours` contains full local solo-cup snapshots; keep them verbatim-ish.
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
  }

  for (const key of HISTORY_FIELDS) clean[key] = cleanHistory(input[key]);

  if (typeof input.map === 'string' && input.map.length > 80) delete clean.map;
  if (typeof input.fav === 'string' && input.fav.length > 80) delete clean.fav;

  return clean;
}

function loadState(db, userId) {
  const row = db
    .prepare('SELECT state, version, updated_at FROM player_states WHERE user_id = ?')
    .get(userId);
  if (!row) return null;
  let state;
  try {
    state = JSON.parse(row.state);
  } catch {
    return null;
  }
  return { state, version: row.version, updatedAt: row.updated_at };
}

/**
 * Persist a client snapshot and mirror its wallet/progress into `players`.
 * Returns the new server version.
 */
function saveState(db, userId, input, catalog, { maxBytes = MAX_STATE_BYTES } = {}) {
  const state = sanitizeState(input, catalog);
  const serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw errors.payloadTooLarge();
  }

  const now = Date.now();
  const version = transaction(db, () => {
    const existing = db.prepare('SELECT version FROM player_states WHERE user_id = ?').get(userId);
    const nextVersion = existing ? Number(existing.version) + 1 : 1;

    db.prepare(
      `INSERT INTO player_states (user_id, state, version, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         state = excluded.state,
         version = excluded.version,
         updated_at = excluded.updated_at`
    ).run(userId, serialized, nextVersion, now);

    const player = db.prepare('SELECT map_id, favorite_hero FROM players WHERE user_id = ?').get(userId);
    if (player) {
      db.prepare(
        `UPDATE players
            SET coins = ?, diamonds = ?, tokens = ?, tokens_updated_at = ?,
                level = ?, wins = ?, losses = ?, total = ?, map_id = ?, favorite_hero = ?, updated_at = ?
          WHERE user_id = ?`
      ).run(
        state.coin ?? 0,
        state.diamonds ?? 0,
        state.tok ?? 8,
        state.tokT || now,
        state.lv ?? 0,
        state.w ?? 0,
        state.l ?? 0,
        state.total ?? 0,
        state.map || player.map_id,
        state.fav || player.favorite_hero,
        now,
        userId
      );
    }

    return nextVersion;
  });

  return { version, updatedAt: now };
}

/**
 * Server-side wallet change that has to survive the next client snapshot save.
 * Updates both `players` and the stored JSON state (when one exists).
 */
function applyWalletDelta(db, userId, { coins = 0, diamonds = 0, tokens = 0 } = {}) {
  const now = Date.now();
  const row = db
    .prepare('SELECT coins, diamonds, tokens FROM players WHERE user_id = ?')
    .get(userId);
  if (!row) return null;

  const nextCoins = Math.max(0, Number(row.coins) + coins);
  const nextDiamonds = Math.max(0, Number(row.diamonds) + diamonds);
  const nextTokens = Math.min(8, Math.max(0, Number(row.tokens) + tokens));

  db.prepare(
    'UPDATE players SET coins = ?, diamonds = ?, tokens = ?, updated_at = ? WHERE user_id = ?'
  ).run(nextCoins, nextDiamonds, nextTokens, now, userId);

  const stored = db.prepare('SELECT state, version FROM player_states WHERE user_id = ?').get(userId);
  if (stored) {
    try {
      const state = JSON.parse(stored.state);
      state.coin = nextCoins;
      state.diamonds = nextDiamonds;
      state.tok = nextTokens;
      db.prepare(
        'UPDATE player_states SET state = ?, version = ?, updated_at = ? WHERE user_id = ?'
      ).run(JSON.stringify(state), Number(stored.version) + 1, now, userId);
    } catch {
      /* a corrupt snapshot is replaced on the next client save */
    }
  }

  return { coins: nextCoins, diamonds: nextDiamonds, tokens: nextTokens };
}

module.exports = { sanitizeState, loadState, saveState, applyWalletDelta, MAX_STATE_BYTES };
