'use strict';

const { randomUUID } = require('node:crypto');
const { transaction } = require('../db');
const { errors } = require('../util/http');
const { TIER_ORDER } = require('../catalog');
const {
  recordTransaction,
  refreshTokens,
  getPlayerRow,
  accountLevel,
  accountRank,
  totalMultiplier,
  round2,
  walletOf,
} = require('./player');

const LEVEL_REWARD_MULTIPLIER = 2;
const LEVEL_BOSS_MULTIPLIER = 0.75; // boss fights use a scaled enemy, not a bigger reward cap
const LEVEL_BOSS_REWARD = 2;

/** Mirrors levelReward() in the client game. */
function levelReward(level, isBoss) {
  return (20 + level * 5) * (isBoss ? LEVEL_BOSS_REWARD : 1) * LEVEL_REWARD_MULTIPLIER;
}

function startOfToday(now = Date.now()) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function completeLevel(db, { userId, level, won, economy }) {
  if (!Number.isInteger(level) || level < 1 || level > economy.maxLevel) {
    throw errors.unprocessable(
      'INVALID_LEVEL',
      `Level 1 dan ${economy.maxLevel} gacha bo‘lishi kerak.`
    );
  }
  if (typeof won !== 'boolean') {
    throw errors.unprocessable('INVALID_RESULT', 'won true yoki false bo‘lishi kerak.');
  }

  const refreshed = refreshTokens(db, userId, economy);

  return transaction(db, () => {
    const row = getPlayerRow(db, userId);
    const now = Date.now();

    const lastRun = db
      .prepare('SELECT created_at FROM level_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(userId);
    if (lastRun && now - lastRun.created_at < economy.levelCooldownMs) {
      throw new HttpError429(
        'LEVEL_COOLDOWN',
        'Janglar orasida biroz tanaffus qiling.',
        economy.levelCooldownMs - (now - lastRun.created_at)
      );
    }

    if (level > Number(row.level) + 1) {
      throw errors.conflict('LEVEL_LOCKED', 'Avval oldingi levelni yeching.');
    }

    const todayCount = db
      .prepare('SELECT COUNT(*) AS count FROM level_runs WHERE user_id = ? AND created_at >= ?')
      .get(userId, startOfToday(now)).count;
    if (todayCount >= economy.levelDailyLimit) {
      throw new HttpError429('DAILY_LIMIT', 'Bugungi level janglari limiti tugadi.', 0);
    }

    if (Number(row.tokens) < 1) {
      throw new HttpError429('NO_TOKENS', 'Token yo‘q. Har 2 soatda 1 token beriladi.', 0);
    }

    const isBoss = level % 10 === 0;
    const reward = won ? levelReward(level, isBoss) : 0;
    const tokens = won ? Math.min(economy.maxTokens, Number(row.tokens) + 1) : Math.max(0, Number(row.tokens) - 1);
    const coins = Number(row.coins) + reward;
    const wins = Number(row.wins) + (won ? 1 : 0);
    const losses = Number(row.losses) + (won ? 0 : 1);
    const highest = won ? Math.max(Number(row.level), level) : Number(row.level);

    db.prepare(
      `UPDATE players
          SET coins = ?, tokens = ?, tokens_updated_at = ?, level = ?, wins = ?, losses = ?, updated_at = ?
        WHERE user_id = ?`
    ).run(coins, tokens, refreshed?.updatedAt ?? row.tokens_updated_at, highest, wins, losses, now, userId);

    db.prepare(
      `INSERT INTO level_runs (id, user_id, level, won, reward, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), userId, level, won ? 1 : 0, reward, now);

    if (reward > 0) {
      recordTransaction(db, {
        userId,
        type: 'level_reward',
        currency: 'coin',
        amount: reward,
        balanceAfter: coins,
        ref: `level:${level}`,
        meta: { level, boss: isBoss },
        at: now,
      });
    }

    return {
      level,
      won,
      boss: isBoss,
      reward,
      wallet: walletOf(db, userId),
      progress: {
        level: highest,
        wins,
        losses,
      },
    };
  });
}

/** Small dedicated 429 error so we can carry a retry hint. */
class HttpError429 extends Error {
  constructor(code, message, retryAfterMs) {
    super(message);
    this.status = 429;
    this.code = code;
    this.details = retryAfterMs ? { retryAfterMs } : null;
  }
}

/** Weight table copied from the client's gradeTournament(). */
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

  // A strong losing run: wins against equal-or-stronger opponents.
  const strong = validWins.filter((entry) => gapOf(entry.opponentTier) >= 0).length;
  if (strong >= 3) return 5;
  if (strong === 2) return 4;
  if (strong === 1) return 3;
  return 0;
}

function startTournament(db, { userId, heroId, paidSelection = false, catalog, economy }) {
  const hero = catalog.getHero(heroId);
  if (!hero) throw errors.notFound('Bunday jangchi topilmadi.');

  return transaction(db, () => {
    const active = db
      .prepare("SELECT run_id FROM tournaments WHERE user_id = ? AND status = 'active'")
      .get(userId);
    if (active) {
      throw errors.conflict(
        'TOURNAMENT_IN_PROGRESS',
        'Sizda tugallanmagan turnir bor. Uni yakunlang.'
      );
    }

    const last = db
      .prepare("SELECT settled_at FROM tournaments WHERE user_id = ? AND status = 'settled' ORDER BY settled_at DESC LIMIT 1")
      .get(userId);
    const now = Date.now();
    if (last?.settled_at && now - last.settled_at < economy.tournamentCooldownMs) {
      throw new HttpError429(
        'TOURNAMENT_COOLDOWN',
        'Turnirlar orasida qisqa tanaffus kerak.',
        economy.tournamentCooldownMs - (now - last.settled_at)
      );
    }

    const owned = db
      .prepare('SELECT 1 AS owned FROM owned_heroes WHERE user_id = ? AND hero_id = ?')
      .get(userId, heroId);

    const selectionCost = paidSelection ? economy.tournamentSelectionCost : 0;
    const row = getPlayerRow(db, userId);

    if (!owned && !paidSelection) {
      throw errors.unprocessable('HERO_NOT_OWNED', 'Bu jangchi sizga tegishli emas.');
    }
    if (selectionCost > 0) {
      if (Number(row.diamonds) < selectionCost) {
        throw errors.unprocessable('INSUFFICIENT_DIAMONDS', 'Almaz yetmaydi.', {
          required: selectionCost,
          balance: Number(row.diamonds),
          currency: 'diamond',
        });
      }
      db.prepare('UPDATE players SET diamonds = diamonds - ?, updated_at = ? WHERE user_id = ?').run(
        selectionCost,
        now,
        userId
      );
      recordTransaction(db, {
        userId,
        type: 'tournament_selection',
        currency: 'diamond',
        amount: -selectionCost,
        balanceAfter: Number(row.diamonds) - selectionCost,
        ref: `hero:${heroId}`,
        meta: { heroId, heroName: hero.name },
        at: now,
      });
    }

    const runId = `cup-${now}-${Math.floor(Math.random() * 1e8)}`;
    db.prepare(
      `INSERT INTO tournaments
         (id, user_id, run_id, hero_id, size, selection_cost, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
    ).run(randomUUID(), userId, runId, heroId, economy.tournamentSize, selectionCost, now);

    return {
      runId,
      hero: catalog.heroSummary(hero),
      size: economy.tournamentSize,
      selectionCost,
      wallet: walletOf(db, userId),
    };
  });
}

function completeTournament(db, { userId, runId, champion, forfeit, wins, placement, catalog, economy }) {
  if (typeof champion !== 'boolean' || typeof forfeit !== 'boolean') {
    throw errors.unprocessable('INVALID_RESULT', 'champion va forfeit boolean bo‘lishi kerak.');
  }
  if (champion && forfeit) {
    throw errors.unprocessable('INVALID_RESULT', 'Chempion turnirdan chiqqan bo‘lishi mumkin emas.');
  }
  if (!Array.isArray(wins) || wins.length > economy.tournamentSize - 1) {
    throw errors.unprocessable('INVALID_RESULT', 'wins jadvali noto‘g‘ri.');
  }

  const normalizedWins = wins.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.won !== 'boolean') {
      throw errors.unprocessable('INVALID_RESULT', 'Har bir jang natijasi noto‘g‘ri.');
    }
    const tier = entry.opponentTier;
    if (!TIER_ORDER.includes(tier)) {
      throw errors.unprocessable('INVALID_RESULT', 'opponentTier E–Z oralig‘ida bo‘lishi kerak.');
    }
    return { opponentTier: tier, won: entry.won };
  });

  return transaction(db, () => {
    const tournament = db
      .prepare("SELECT * FROM tournaments WHERE user_id = ? AND run_id = ? AND status = 'active'")
      .get(userId, runId);
    if (!tournament) {
      throw errors.notFound('Faol turnir topilmadi yoki u allaqachon yakunlangan.');
    }

    const hero = catalog.getHero(tournament.hero_id);
    const now = Date.now();

    const todayCount = db
      .prepare(
        "SELECT COUNT(*) AS count FROM tournaments WHERE user_id = ? AND status = 'settled' AND settled_at >= ?"
      )
      .get(userId, startOfToday(now)).count;
    if (todayCount >= economy.tournamentDailyLimit) {
      throw new HttpError429('DAILY_LIMIT', 'Bugungi turnir limiti tugadi.', 0);
    }

    const row = getPlayerRow(db, userId);
    const baseTotal = computeBaseTotal({
      heroTier: hero?.tier || 'E',
      champion,
      forfeit,
      wins: normalizedWins,
    });

    const levelBefore = accountLevel(Number(row.total), catalog.ranks);
    const awarded = round2(baseTotal * totalMultiplier(levelBefore));
    const totalAfter = round2(Number(row.total) + awarded);
    const coins = Number(row.coins) + (champion ? economy.tournamentPrizeCoins : 0);
    const diamonds = Number(row.diamonds) + (champion ? economy.tournamentPrizeDiamonds : 0);
    const winsCount = normalizedWins.filter((entry) => entry.won).length;

    db.prepare(
      `UPDATE players
          SET coins = ?, diamonds = ?, total = ?, updated_at = ?
        WHERE user_id = ?`
    ).run(coins, diamonds, totalAfter, now, userId);

    db.prepare(
      `UPDATE tournaments
          SET status = 'settled', champion = ?, forfeit = ?, placement = ?, wins = ?,
              base_total = ?, total_awarded = ?, coins = ?, diamonds = ?, payload = ?, settled_at = ?
        WHERE id = ?`
    ).run(
      champion ? 1 : 0,
      forfeit ? 1 : 0,
      placement || null,
      winsCount,
      baseTotal,
      awarded,
      champion ? economy.tournamentPrizeCoins : 0,
      champion ? economy.tournamentPrizeDiamonds : 0,
      JSON.stringify({ wins: normalizedWins }),
      now,
      tournament.id
    );

    if (champion) {
      recordTransaction(db, {
        userId,
        type: 'tournament_reward',
        currency: 'coin',
        amount: economy.tournamentPrizeCoins,
        balanceAfter: coins,
        ref: runId,
        meta: { placement: placement || '1', wins: winsCount },
        at: now,
      });
      recordTransaction(db, {
        userId,
        type: 'tournament_reward',
        currency: 'diamond',
        amount: economy.tournamentPrizeDiamonds,
        balanceAfter: diamonds,
        ref: runId,
        meta: { placement: placement || '1' },
        at: now,
      });
    }
    if (awarded > 0) {
      recordTransaction(db, {
        userId,
        type: 'total_award',
        currency: 'total',
        amount: awarded,
        balanceAfter: totalAfter,
        ref: runId,
        meta: { base: baseTotal, multiplier: totalMultiplier(levelBefore) },
        at: now,
      });
    }

    const levelAfter = accountLevel(totalAfter, catalog.ranks);
    const rankAfter = accountRank(totalAfter, catalog.ranks);

    return {
      runId,
      champion,
      forfeit,
      wins: winsCount,
      rewards: {
        coins: champion ? economy.tournamentPrizeCoins : 0,
        diamonds: champion ? economy.tournamentPrizeDiamonds : 0,
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
      wallet: walletOf(db, userId),
    };
  });
}

module.exports = {
  levelReward,
  computeBaseTotal,
  completeLevel,
  startTournament,
  completeTournament,
};
