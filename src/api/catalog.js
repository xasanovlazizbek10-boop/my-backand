'use strict';

const { errors, sendJson } = require('../util/http');

function overview(ctx) {
  const { catalog, res } = ctx;
  sendJson(res, 200, {
    meta: catalog.meta,
    tiers: catalog.tiers,
    ranks: catalog.ranks,
    maps: catalog.maps,
    monsters: catalog.monsters,
    heroes: catalog.summaryList(),
  });
}

function heroes(ctx) {
  const { catalog, query, res } = ctx;
  let list = catalog.heroes;

  const tier = query.get('tier');
  if (tier) list = list.filter((hero) => hero.tier === tier.toUpperCase());

  const search = (query.get('q') || '').trim().toLowerCase();
  if (search) list = list.filter((hero) => hero.name.toLowerCase().includes(search));

  if (query.get('purchasable') === '1') list = list.filter((hero) => hero.purchasable);

  sendJson(res, 200, {
    count: list.length,
    heroes: list.map((hero) => catalog.heroSummary(hero)),
  });
}

function hero(ctx) {
  const { catalog, params, res } = ctx;
  const found = catalog.getHero(params.id);
  if (!found) throw errors.notFound('Bunday jangchi topilmadi.');
  sendJson(res, 200, catalog.heroDetail(found));
}

function tiers(ctx) {
  sendJson(ctx.res, 200, { tiers: ctx.catalog.tiers });
}

function ranks(ctx) {
  sendJson(ctx.res, 200, { ranks: ctx.catalog.ranks });
}

function maps(ctx) {
  sendJson(ctx.res, 200, { maps: ctx.catalog.maps });
}

function monsters(ctx) {
  sendJson(ctx.res, 200, { monsters: ctx.catalog.monsters });
}

module.exports = { overview, heroes, hero, tiers, ranks, maps, monsters };
