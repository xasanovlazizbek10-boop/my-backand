'use strict';

const { transaction } = require('../db');
const { errors } = require('../util/http');
const { recordTransaction, accountLevel, walletOf } = require('./player');

const CURRENCIES = new Set(['coin', 'diamond']);

function buyHero(db, { userId, heroId, currency = 'coin', catalog }) {
  const hero = catalog.getHero(heroId);
  if (!hero) throw errors.notFound('Bunday jangchi topilmadi.');
  if (!hero.purchasable) {
    throw errors.unprocessable('HERO_NOT_PURCHASABLE', 'Bu jangchi sotilmaydi.');
  }
  if (!CURRENCIES.has(currency)) {
    throw errors.unprocessable('INVALID_CURRENCY', 'Valyuta coin yoki diamond bo‘lishi kerak.');
  }
  if (hero.diamondOnly && currency === 'coin') {
    throw errors.unprocessable(
      'DIAMOND_ONLY',
      'S va Z darajadagi jangchilar faqat almazga olinadi.'
    );
  }

  const price = currency === 'diamond' ? hero.prices.diamonds : hero.prices.coins;
  const balanceColumn = currency === 'diamond' ? 'diamonds' : 'coins';

  return transaction(db, () => {
    const owned = db
      .prepare('SELECT 1 AS owned FROM owned_heroes WHERE user_id = ? AND hero_id = ?')
      .get(userId, heroId);
    if (owned) throw errors.conflict('HERO_ALREADY_OWNED', 'Bu jangchi allaqachon sizda.');

    const row = db
      .prepare(`SELECT coins, diamonds FROM players WHERE user_id = ?`)
      .get(userId);
    const balance = Number(row[balanceColumn]) || 0;
    if (balance < price) {
      throw errors.unprocessable('INSUFFICIENT_FUNDS', 'Mablag‘ yetarli emas.', {
        required: price,
        balance,
        currency,
      });
    }

    const nextBalance = balance - price;
    const now = Date.now();
    db.prepare(`UPDATE players SET ${balanceColumn} = ?, updated_at = ? WHERE user_id = ?`).run(
      nextBalance,
      now,
      userId
    );
    db.prepare(
      `INSERT INTO owned_heroes (user_id, hero_id, source, price, currency, acquired_at)
       VALUES (?, ?, 'purchase', ?, ?, ?)`
    ).run(userId, heroId, price, currency === 'diamond' ? 'diamond' : 'coin', now);

    recordTransaction(db, {
      userId,
      type: 'hero_purchase',
      currency,
      amount: -price,
      balanceAfter: nextBalance,
      ref: `hero:${heroId}`,
      meta: { heroId, heroName: hero.name },
      at: now,
    });

    return {
      hero: catalog.heroSummary(hero),
      paid: { amount: price, currency },
      wallet: walletOf(db, userId),
    };
  });
}

function buyMap(db, { userId, mapId, catalog }) {
  const map = catalog.getMap(mapId);
  if (!map) throw errors.notFound('Bunday arena topilmadi.');

  return transaction(db, () => {
    const owned = db
      .prepare('SELECT 1 AS owned FROM owned_maps WHERE user_id = ? AND map_id = ?')
      .get(userId, mapId);
    if (owned) throw errors.conflict('MAP_ALREADY_OWNED', 'Bu arena allaqachon sizda.');

    const row = db.prepare('SELECT coins, total FROM players WHERE user_id = ?').get(userId);
    const level = accountLevel(row.total, catalog.ranks);

    if (map.rankRequired && level < map.rankRequired) {
      throw errors.forbidden(
        `Bu arena ${map.rankRequired}-account rankda ochiladi. Hozirgi rank: ${level}.`
      );
    }

    const price = map.price || 0;
    if (price > 0 && Number(row.coins) < price) {
      throw errors.unprocessable('INSUFFICIENT_FUNDS', 'Tangalar yetmaydi.', {
        required: price,
        balance: Number(row.coins),
        currency: 'coin',
      });
    }

    const now = Date.now();
    if (price > 0) {
      db.prepare('UPDATE players SET coins = coins - ?, updated_at = ? WHERE user_id = ?').run(
        price,
        now,
        userId
      );
      recordTransaction(db, {
        userId,
        type: 'map_purchase',
        currency: 'coin',
        amount: -price,
        balanceAfter: Number(row.coins) - price,
        ref: `map:${mapId}`,
        meta: { mapId, mapName: map.name },
        at: now,
      });
    }

    db.prepare('INSERT INTO owned_maps (user_id, map_id, acquired_at) VALUES (?, ?, ?)').run(
      userId,
      mapId,
      now
    );
    db.prepare('UPDATE players SET map_id = ?, updated_at = ? WHERE user_id = ?').run(
      mapId,
      now,
      userId
    );

    return { map, wallet: walletOf(db, userId) };
  });
}

function selectMap(db, { userId, mapId, catalog }) {
  const map = catalog.getMap(mapId);
  if (!map) throw errors.notFound('Bunday arena topilmadi.');

  const row = db.prepare('SELECT total FROM players WHERE user_id = ?').get(userId);
  const level = accountLevel(row.total, catalog.ranks);

  if (map.rankRequired && level < map.rankRequired) {
    throw errors.forbidden(
      `Bu arena ${map.rankRequired}-account rankda ochiladi. Hozirgi rank: ${level}.`
    );
  }

  if (!map.rankRequired) {
    const owned = db
      .prepare('SELECT 1 AS owned FROM owned_maps WHERE user_id = ? AND map_id = ?')
      .get(userId, mapId);
    if (!owned) throw errors.unprocessable('MAP_NOT_OWNED', 'Avval bu arenani sotib oling.');
  }

  db.prepare('UPDATE players SET map_id = ?, updated_at = ? WHERE user_id = ?').run(
    mapId,
    Date.now(),
    userId
  );

  return { selected: mapId, map };
}

function shopHeroes(db, { userId, catalog }) {
  const owned = new Set(
    db.prepare('SELECT hero_id FROM owned_heroes WHERE user_id = ?').all(userId).map((r) => r.hero_id)
  );
  return catalog.heroes
    .filter((hero) => hero.purchasable)
    .map((hero) => ({
      ...catalog.heroSummary(hero),
      owned: owned.has(hero.id),
    }));
}

module.exports = { buyHero, buyMap, selectMap, shopHeroes };
