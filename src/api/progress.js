'use strict';

const { sendJson } = require('../util/http');
const { requireString, requireBoolean, optionalInt } = require('../util/validation');
const {
  completeLevel,
  startTournament,
  completeTournament,
} = require('../services/progress');

async function levelComplete(ctx) {
  const { db, user, body, config, res } = ctx;
  const level = optionalInt(body.level, 'level', { min: 1, max: config.economy.maxLevel });
  const won = requireBoolean(body.won, 'won');

  const result = completeLevel(db, { userId: user.id, level, won, economy: config.economy });
  sendJson(res, 200, result);
}

async function tournamentStart(ctx) {
  const { db, user, body, catalog, config, res } = ctx;
  const heroId = requireString(body.heroId, 'heroId', { min: 1, max: 60 });
  const paidSelection = body.paidSelection === undefined ? false : requireBoolean(body.paidSelection, 'paidSelection');

  const result = startTournament(db, {
    userId: user.id,
    heroId,
    paidSelection,
    catalog,
    economy: config.economy,
  });
  sendJson(res, 201, result);
}

async function tournamentComplete(ctx) {
  const { db, user, body, catalog, config, res } = ctx;
  const runId = requireString(body.runId, 'runId', { min: 6, max: 80 });
  const champion = requireBoolean(body.champion, 'champion');
  const forfeit = body.forfeit === undefined ? false : requireBoolean(body.forfeit, 'forfeit');
  const wins = body.wins === undefined ? [] : body.wins;
  const placement = typeof body.placement === 'string' ? body.placement.slice(0, 20) : null;

  const result = completeTournament(db, {
    userId: user.id,
    runId,
    champion,
    forfeit,
    wins,
    placement,
    catalog,
    economy: config.economy,
  });
  sendJson(res, 200, result);
}

module.exports = { levelComplete, tournamentStart, tournamentComplete };
