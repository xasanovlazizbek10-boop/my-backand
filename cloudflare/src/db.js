'use strict';

const clean = (args) => args.map((value) => (value === undefined ? null : value));

export async function one(db, sql, ...args) {
  return db.prepare(sql).bind(...clean(args)).first();
}

export async function all(db, sql, ...args) {
  const result = await db.prepare(sql).bind(...clean(args)).all();
  return result.results || [];
}

export async function run(db, sql, ...args) {
  return db.prepare(sql).bind(...clean(args)).run();
}

export function stmt(db, sql, ...args) {
  return db.prepare(sql).bind(...clean(args));
}

export async function batch(db, statements) {
  if (!statements.length) return [];
  return db.batch(statements);
}
