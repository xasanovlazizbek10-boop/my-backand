'use strict';

const { sendJson } = require('../util/http');
const { loadState, saveState } = require('../services/state');

async function getState(ctx) {
  const { db, user, res } = ctx;
  const stored = loadState(db, user.id);
  sendJson(res, 200, {
    state: stored ? stored.state : null,
    version: stored ? stored.version : 0,
    updatedAt: stored ? stored.updatedAt : null,
  });
}

async function putState(ctx) {
  const { db, user, body, catalog, config, res } = ctx;
  const result = saveState(db, user.id, body.state, catalog, { maxBytes: config.stateLimit });
  sendJson(res, 200, result);
}

module.exports = { getState, putState };
