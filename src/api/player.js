'use strict';

const { errors, sendJson } = require('../util/http');
const {
  playerSnapshot,
  updateSettings,
  setFavorite,
  refreshTokens,
} = require('../services/player');

async function getPlayer(ctx) {
  const { db, user, catalog, config, res } = ctx;
  sendJson(res, 200, playerSnapshot(db, user.id, catalog, config.economy));
}

async function patchPlayer(ctx) {
  const { db, user, body, catalog, config, res } = ctx;
  let favorite = undefined;

  if (Object.prototype.hasOwnProperty.call(body, 'favoriteHeroId')) {
    const value = body.favoriteHeroId;
    if (value !== null && typeof value !== 'string') {
      throw errors.unprocessable('VALIDATION_FAILED', 'favoriteHeroId string yoki null bo‘lishi kerak.');
    }
    favorite = setFavorite(db, user.id, value, catalog);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'settings')) {
    updateSettings(db, user.id, body.settings);
  }

  sendJson(res, 200, {
    player: playerSnapshot(db, user.id, catalog, config.economy),
    updated: { ...(favorite !== undefined ? { favoriteHeroId: favorite } : {}) },
  });
}

async function refresh(ctx) {
  const { db, user, config, res } = ctx;
  const result = refreshTokens(db, user.id, config.economy);
  const row = db.prepare('SELECT tokens FROM players WHERE user_id = ?').get(user.id);
  sendJson(res, 200, { tokens: result?.tokens ?? row.tokens, updatedAt: result?.updatedAt });
}

async function transactions(ctx) {
  const { db, user, query, res } = ctx;
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.get('limit') || '30', 10) || 30));
  const rows = db
    .prepare(
      'SELECT id, type, currency, amount, balance_after, ref, meta, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    )
    .all(user.id, limit);

  sendJson(res, 200, {
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

async function tournaments(ctx) {
  const { db, user, query, res } = ctx;
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.get('limit') || '30', 10) || 30));
  const rows = db
    .prepare(
      `SELECT id, run_id, hero_id, size, status, champion, forfeit, placement, wins,
              base_total, total_awarded, coins, diamonds, created_at, settled_at
         FROM tournaments WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(user.id, limit);

  sendJson(res, 200, {
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

module.exports = { getPlayer, patchPlayer, refresh, transactions, tournaments };
