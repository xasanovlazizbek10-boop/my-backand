'use strict';

const { sendJson } = require('../util/http');

const SORTS = {
  total: 'p.total DESC, p.wins DESC, p.coins DESC',
  coins: 'p.coins DESC, p.total DESC',
  wins: 'p.wins DESC, p.total DESC',
  level: 'p.level DESC, p.total DESC',
};

async function leaderboard(ctx) {
  const { db, query, res } = ctx;
  const sortKey = SORTS[query.get('sort')] ? query.get('sort') : 'total';
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.get('limit') || '25', 10) || 25));

  const rows = db
    .prepare(
      `SELECT u.nickname, p.total, p.coins, p.wins, p.losses, p.level
         FROM players p JOIN users u ON u.id = p.user_id
        ORDER BY ${SORTS[sortKey]}
        LIMIT ?`
    )
    .all(limit);

  sendJson(res, 200, {
    sort: sortKey,
    leaders: rows.map((row, index) => ({
      rank: index + 1,
      nickname: row.nickname,
      total: row.total,
      coins: row.coins,
      wins: row.wins,
      losses: row.losses,
      level: row.level,
    })),
  });
}

module.exports = { leaderboard };
