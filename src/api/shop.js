'use strict';

const { sendJson } = require('../util/http');
const { requireString } = require('../util/validation');
const { shopHeroes, buyHero, buyMap, selectMap } = require('../services/shop');

async function listHeroes(ctx) {
  const { db, user, catalog, res } = ctx;
  sendJson(res, 200, { heroes: shopHeroes(db, { userId: user.id, catalog }) });
}

async function purchaseHero(ctx) {
  const { db, user, body, catalog, res } = ctx;
  const heroId = requireString(body.heroId, 'heroId', { min: 1, max: 60 });
  const currency =
    body.currency === undefined
      ? 'coin'
      : requireString(body.currency, 'currency', { min: 4, max: 10 });

  const result = buyHero(db, { userId: user.id, heroId, currency, catalog });
  sendJson(res, 200, result);
}

async function purchaseMap(ctx) {
  const { db, user, body, catalog, res } = ctx;
  const mapId = requireString(body.mapId, 'mapId', { min: 1, max: 60 });

  const result = buyMap(db, { userId: user.id, mapId, catalog });
  sendJson(res, 200, result);
}

async function select(ctx) {
  const { db, user, body, catalog, res } = ctx;
  const mapId = requireString(body.mapId, 'mapId', { min: 1, max: 60 });

  const result = selectMap(db, { userId: user.id, mapId, catalog });
  sendJson(res, 200, result);
}

module.exports = { listHeroes, purchaseHero, purchaseMap, select };
