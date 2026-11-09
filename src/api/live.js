'use strict';

const { sendJson } = require('../util/http');
const { requireString } = require('../util/validation');
const {
  getLiveState,
  getLiveHistory,
  joinLive,
  leaveLive,
} = require('../services/live');

async function state(ctx) {
  const { db, user, catalog, config, res } = ctx;
  sendJson(res, 200, getLiveState(db, { userId: user.id, catalog, config }));
}

async function history(ctx) {
  const { db, user, catalog, config, res } = ctx;
  sendJson(res, 200, { history: getLiveHistory(db, { userId: user.id, catalog, config }) });
}

async function enter(ctx) {
  const { db, user, body, catalog, config, res } = ctx;
  const heroId = requireString(body.heroId, 'heroId', { min: 1, max: 60 });
  joinLive(db, { userId: user.id, heroId, catalog, config });
  sendJson(res, 200, getLiveState(db, { userId: user.id, catalog, config }));
}

async function leave(ctx) {
  const { db, user, catalog, config, res } = ctx;
  leaveLive(db, { userId: user.id, config });
  sendJson(res, 200, getLiveState(db, { userId: user.id, catalog, config }));
}

module.exports = { state, history, enter, leave };
