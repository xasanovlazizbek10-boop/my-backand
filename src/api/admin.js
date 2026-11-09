'use strict';

const { randomUUID } = require('node:crypto');
const { transaction } = require('../db');
const { errors, sendJson } = require('../util/http');
const { requireString, optionalInt } = require('../util/validation');
const { applyWalletDelta } = require('../services/state');
const { recordTransaction } = require('../services/player');

function requireAdmin(user) {
  if (!user || user.role !== 'admin') throw errors.forbidden('Bu bo‘lim faqat admin uchun.');
}

async function listUsers(ctx) {
  const { db, user, query, res } = ctx;
  requireAdmin(user);

  const search = (query.get('q') || '').trim().slice(0, 120);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.get('limit') || '50', 10) || 50));
  const offset = Math.max(0, Number.parseInt(query.get('offset') || '0', 10) || 0);
  const like = `%${search}%`;

  const rows = db
    .prepare(
      `SELECT u.id, u.nickname, u.email, u.first_name, u.last_name, u.role,
              u.created_at, u.last_login_at,
              p.coins, p.diamonds, p.tokens, p.level, p.wins, p.losses, p.total
         FROM users u
         LEFT JOIN players p ON p.user_id = u.id
        WHERE (? = '' OR u.nickname LIKE ? OR u.email LIKE ?)
        ORDER BY u.created_at DESC
        LIMIT ? OFFSET ?`
    )
    .all(search, like, like, limit, offset);

  const total = db
    .prepare('SELECT COUNT(*) AS count FROM users WHERE (? = \'\' OR nickname LIKE ? OR email LIKE ?)')
    .get(search, like, like).count;

  sendJson(res, 200, {
    total,
    limit,
    offset,
    users: rows.map((row) => ({
      id: row.id,
      nickname: row.nickname,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      role: row.role,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      wallet: {
        coins: Number(row.coins) || 0,
        diamonds: Number(row.diamonds) || 0,
        tokens: Number(row.tokens) || 0,
      },
      progress: {
        level: Number(row.level) || 0,
        wins: Number(row.wins) || 0,
        losses: Number(row.losses) || 0,
        total: Number(row.total) || 0,
      },
    })),
  });
}

async function transferDiamonds(ctx) {
  const { db, user, body, res } = ctx;
  requireAdmin(user);

  const targetId = requireString(body.userId, 'userId', { min: 1, max: 64 });
  const amount = optionalInt(body.amount, 'amount', { min: 1, max: 1_000_000 });
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 160) : '';

  if (amount === null) {
    throw errors.unprocessable('VALIDATION_FAILED', 'O‘tkaziladigan almaz miqdorini kiriting.');
  }

  const result = transaction(db, () => {
    const target = db
      .prepare('SELECT u.id, u.nickname, u.email, p.diamonds FROM users u LEFT JOIN players p ON p.user_id = u.id WHERE u.id = ?')
      .get(targetId);
    if (!target) throw errors.notFound('Foydalanuvchi topilmadi.');

    const wallet = applyWalletDelta(db, targetId, { diamonds: amount });
    if (!wallet) throw errors.notFound('Foydalanuvchi hamyoni topilmadi.');

    recordTransaction(db, {
      userId: targetId,
      type: 'admin_diamond_grant',
      currency: 'diamond',
      amount,
      balanceAfter: wallet.diamonds,
      ref: `admin:${user.id}`,
      meta: { adminId: user.id, adminNickname: user.nickname, note },
    });

    const auditId = randomUUID();
    db.prepare(
      `INSERT INTO admin_audit
         (id, admin_user_id, target_user_id, action, currency, amount, note, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, 'diamond_grant', 'diamond', ?, ?, ?, ?, ?)`
    ).run(
      auditId,
      user.id,
      targetId,
      amount,
      note || null,
      Number(target.diamonds) || 0,
      wallet.diamonds,
      Date.now()
    );

    return {
      auditId,
      user: { id: target.id, nickname: target.nickname, email: target.email },
      wallet,
    };
  });

  sendJson(res, 200, result);
}

async function audit(ctx) {
  const { db, user, query, res } = ctx;
  requireAdmin(user);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.get('limit') || '30', 10) || 30));
  const rows = db
    .prepare(
      `SELECT a.id, a.action, a.currency, a.amount, a.note, a.balance_before, a.balance_after, a.created_at,
              admin.nickname AS admin_nickname, target.nickname AS target_nickname
         FROM admin_audit a
         JOIN users admin ON admin.id = a.admin_user_id
         JOIN users target ON target.id = a.target_user_id
        ORDER BY a.created_at DESC LIMIT ?`
    )
    .all(limit);

  sendJson(res, 200, {
    audit: rows.map((row) => ({
      id: row.id,
      action: row.action,
      currency: row.currency,
      amount: row.amount,
      note: row.note,
      balanceBefore: row.balance_before,
      balanceAfter: row.balance_after,
      createdAt: row.created_at,
      admin: row.admin_nickname,
      target: row.target_nickname,
    })),
  });
}

module.exports = { listUsers, transferDiamonds, audit };
