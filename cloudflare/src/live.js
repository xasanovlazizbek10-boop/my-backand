'use strict';

import { one, all, run, stmt, batch } from './db.js';

/* ---------- deterministic simulation ---------- */
function hashSeed(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

function skillWeight(skill) {
  let damage = 0;
  for (const event of skill.raw?.ev || []) {
    if (Number.isFinite(event.tot)) damage += event.tot;
    if (Number.isFinite(event.atk)) damage += event.atk * Math.min(6, event.hits || 1);
  }
  return damage / Math.max(5, Math.min(120, Number(skill.cooldown) || 90));
}

export function heroPower(hero) {
  if (!hero) return 1;
  const stats = hero.stats || {};
  const base =
    (stats.atk || 0) * (0.7 + (stats.spd || 0) / 24) +
    (hero.skills || []).reduce((sum, skill) => sum + skillWeight(skill) * 4, 0);
  return Math.max(
    1,
    base *
      ((stats.hp || 0) + (stats.reg || 0) * 30) *
      (1 + (stats.def || 0) / 800) *
      (1 + (stats.per || 0) / 150)
  );
}

export function simulateFight(seedText, heroA, heroB, config) {
  const rng = mulberry32(hashSeed(seedText));
  const scoreA = heroPower(heroA) * (0.72 + rng() * 0.56);
  const scoreB = heroPower(heroB) * (0.72 + rng() * 0.56);
  const winner = scoreA >= scoreB ? 'a' : 'b';
  const durationMs = Math.max(
    250,
    Math.round(
      config.live.fightMinMs + rng() * Math.max(1, config.live.fightMaxMs - config.live.fightMinMs)
    )
  );
  const skillsOf = (hero) => (hero?.skills || []).filter((skill) => !skill.passive);
  const skillsA = skillsOf(heroA);
  const skillsB = skillsOf(heroB);
  const eventCount = 14 + Math.floor(rng() * 5);
  const timeline = [];
  let hpA = 100;
  let hpB = 100;

  for (let index = 0; index < eventCount; index += 1) {
    const t = Math.round((durationMs * (index + 1)) / eventCount);
    const final = index === eventCount - 1;
    const actor = final ? winner : rng() < (winner === 'a' ? 0.58 : 0.42) ? 'a' : 'b';
    const defender = actor === 'a' ? 'b' : 'a';
    const pool = actor === 'a' ? skillsA : skillsB;
    const skill = pool.length ? pool[index % pool.length].name : 'Zarba';
    const damage = round2(3 + rng() * 7);
    if (final) {
      if (actor === 'a') {
        hpB = 0;
        hpA = Math.max(20, hpA);
      } else {
        hpA = 0;
        hpB = Math.max(20, hpB);
      }
    } else if (defender === 'a') {
      hpA = Math.max(12, hpA - damage);
    } else {
      hpB = Math.max(12, hpB - damage);
    }
    timeline.push({ t, actor, skill, damage, hpA: round2(hpA), hpB: round2(hpB) });
  }

  return { winner, durationMs, timeline };
}

/* ---------- tournament lifecycle ---------- */
export async function latestTournament(db) {
  return one(
    db,
    "SELECT * FROM live_tournaments WHERE status IN ('registration','scheduled','running') ORDER BY created_at DESC LIMIT 1"
  );
}

export async function ensureOpenTournament(db, config, now = Date.now()) {
  const current = await latestTournament(db);
  if (current) return current;
  const last = await one(db, 'SELECT MAX(number) AS number FROM live_tournaments');
  const number = (Number(last?.number) || 0) + 1;
  const id = crypto.randomUUID();
  await run(
    db,
    `INSERT INTO live_tournaments (id, number, size, status, opens_at, deadline_at, start_at, created_at)
     VALUES (?, ?, ?, 'registration', ?, ?, ?, ?)`,
    id,
    number,
    config.live.size,
    now,
    now + config.live.registrationMs,
    now + config.live.registrationMs,
    now
  );
  return one(db, 'SELECT * FROM live_tournaments WHERE id = ?', id);
}

async function countEntries(db, tournamentId) {
  const row = await one(db, 'SELECT COUNT(*) AS count FROM live_entries WHERE tournament_id = ?', tournamentId);
  return Number(row?.count) || 0;
}

async function scheduleTournament(db, tournament, config, now = Date.now()) {
  const previous = await one(
    db,
    'SELECT MAX(started_at) AS started FROM live_tournaments WHERE started_at IS NOT NULL AND id <> ?',
    tournament.id
  );
  const earliest = (Number(previous?.started) || 0) + config.live.cycleMs;
  const startAt = Math.max(now, earliest);
  await run(
    db,
    "UPDATE live_tournaments SET status = 'scheduled', start_at = ? WHERE id = ? AND status = 'registration'",
    startAt,
    tournament.id
  );
}

function shuffle(list, rng) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(rng() * (index + 1));
    [copy[index], copy[pick]] = [copy[pick], copy[index]];
  }
  return copy;
}

function propagateWinner(db, tournamentId, round, slot, winner) {
  return run(
    db,
    'UPDATE live_matches SET a = CASE WHEN slot % 2 = 0 THEN ? ELSE a END, b = CASE WHEN slot % 2 = 1 THEN ? ELSE b END WHERE tournament_id = ? AND round = ? AND slot = ?',
    winner,
    winner,
    tournamentId,
    round + 1,
    Math.floor(slot / 2)
  );
}

async function startTournament(db, tournament, catalog, config, now = Date.now()) {
  const entries = await all(db, 'SELECT * FROM live_entries WHERE tournament_id = ? ORDER BY seed', tournament.id);
  if (entries.length < 2) {
    await run(
      db,
      'UPDATE live_tournaments SET deadline_at = ? WHERE id = ?',
      now + config.live.registrationMs,
      tournament.id
    );
    return false;
  }

  const rng = mulberry32(hashSeed(`${tournament.id}:bracket`));
  const seeded = shuffle(entries, rng);
  const bracketSize = 2 ** Math.ceil(Math.log2(Math.max(2, seeded.length)));
  const size = Math.min(bracketSize, Number(tournament.size) || bracketSize);
  const slots = new Array(size).fill(null);
  seeded.forEach((entry, index) => {
    slots[index] = entry.user_id;
  });

  const rounds = Math.log2(size);
  const statements = [];
  for (let round = 0; round < rounds; round += 1) {
    const matches = size / 2 ** (round + 1);
    for (let slot = 0; slot < matches; slot += 1) {
      statements.push(
        stmt(
          db,
          `INSERT INTO live_matches (tournament_id, id, round, slot, a, b, status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
          tournament.id,
          `r${round}m${slot}`,
          round,
          slot,
          round === 0 ? slots[slot * 2] : null,
          round === 0 ? slots[slot * 2 + 1] : null
        )
      );
    }
  }
  statements.push(
    stmt(
      db,
      `UPDATE live_tournaments
          SET status = 'running', started_at = ?, next_match_at = ?, size = ?
        WHERE id = ? AND status = 'scheduled'`,
      now,
      now,
      size,
      tournament.id
    )
  );

  try {
    await batch(db, statements);
  } catch {
    return false;
  }
  await propagateByes(db, tournament.id, size, now);
  return true;
}

async function propagateByes(db, tournamentId, size, now = Date.now()) {
  const rounds = Math.log2(size);
  for (let round = 0; round < rounds; round += 1) {
    const matches = await all(
      db,
      'SELECT * FROM live_matches WHERE tournament_id = ? AND round = ? ORDER BY slot',
      tournamentId,
      round
    );
    for (const match of matches) {
      if (match.status !== 'pending') continue;
      if (round > 0) {
        const feeders = await all(
          db,
          'SELECT status FROM live_matches WHERE tournament_id = ? AND round = ? AND slot IN (?, ?)',
          tournamentId,
          round - 1,
          match.slot * 2,
          match.slot * 2 + 1
        );
        if (feeders.length < 2 || feeders.some((feeder) => feeder.status !== 'done')) continue;
      }
      if (match.a && match.b) continue;
      const winner = match.a || match.b || null;
      await run(
        db,
        "UPDATE live_matches SET status = 'done', winner = ?, ended_at = ?, starts_at = ?, ends_at = ? WHERE tournament_id = ? AND id = ?",
        winner,
        now,
        now,
        now,
        tournamentId,
        match.id
      );
      if (winner && round + 1 < rounds) {
        await propagateWinner(db, tournamentId, round, match.slot, winner);
      }
    }
  }
}

async function findPlayableMatch(db, tournamentId, size) {
  const rounds = Math.log2(size);
  for (let round = 0; round < rounds; round += 1) {
    const matches = await all(
      db,
      "SELECT * FROM live_matches WHERE tournament_id = ? AND round = ? AND status = 'pending' ORDER BY slot",
      tournamentId,
      round
    );
    for (const match of matches) if (match.a && match.b) return match;
  }
  return null;
}

async function startMatch(db, tournament, match, catalog, config, now) {
  const heroA = catalog.getHero(
    (await one(db, 'SELECT hero_id FROM live_entries WHERE tournament_id = ? AND user_id = ?', tournament.id, match.a))
      ?.hero_id
  );
  const heroB = catalog.getHero(
    (await one(db, 'SELECT hero_id FROM live_entries WHERE tournament_id = ? AND user_id = ?', tournament.id, match.b))
      ?.hero_id
  );
  const simulation = simulateFight(`${tournament.id}:${match.id}`, heroA, heroB, config);
  const endsAt = now + simulation.durationMs;
  const winnerId = simulation.winner === 'a' ? match.a : match.b;
  await run(
    db,
    `UPDATE live_matches
        SET status = 'live', starts_at = ?, ends_at = ?, winner = ?, timeline = ?
      WHERE tournament_id = ? AND id = ? AND status = 'pending'`,
    now,
    endsAt,
    winnerId,
    JSON.stringify(simulation.timeline),
    tournament.id,
    match.id
  );
  await run(db, 'UPDATE live_tournaments SET next_match_at = ? WHERE id = ?', endsAt, tournament.id);
}

function placeForLoss(size, round) {
  return Math.floor(size / 2 ** (round + 1)) + 1;
}

async function finalizeTournament(db, tournamentId, size, config, now = Date.now()) {
  const tournament = await one(db, 'SELECT * FROM live_tournaments WHERE id = ?', tournamentId);
  if (!tournament || tournament.status !== 'running') return false;

  const entries = await all(db, 'SELECT * FROM live_entries WHERE tournament_id = ? ORDER BY seed', tournamentId);
  const matches = await all(
    db,
    "SELECT * FROM live_matches WHERE tournament_id = ? AND status = 'done'",
    tournamentId
  );
  const final = matches.find((match) => match.round === Math.log2(size) - 1);
  const championId = final?.winner || null;

  const standings = entries.map((entry) => {
    const wins = matches.filter((match) => match.winner === entry.user_id).length;
    if (entry.user_id === championId) {
      return { userId: entry.user_id, name: entry.name, heroId: entry.hero_id, place: 1, wins };
    }
    const loss = matches.find(
      (match) => match.winner && match.winner !== entry.user_id && [match.a, match.b].includes(entry.user_id)
    );
    return {
      userId: entry.user_id,
      name: entry.name,
      heroId: entry.hero_id,
      place: loss ? placeForLoss(size, loss.round) : 1,
      wins,
    };
  });

  const champion = entries.find((entry) => entry.user_id === championId) || null;
  const payload = {
    size,
    champion: champion
      ? { userId: champion.user_id, name: champion.name, heroId: champion.hero_id }
      : null,
    standings,
    matches: matches.map((match) => ({
      id: match.id,
      round: match.round,
      winner: match.winner,
      endedAt: match.ended_at,
    })),
  };

  const statements = [];
  const championPlayer = championId
    ? await one(db, 'SELECT coins, diamonds FROM players WHERE user_id = ?', championId)
    : null;

  if (championId && championPlayer) {
    const balanceGuard = 'EXISTS (SELECT 1 FROM live_tournaments WHERE id = ? AND status = \'running\')';
    const nextCoins = Number(championPlayer.coins) + config.live.prizeCoins;
    const nextDiamonds = Number(championPlayer.diamonds) + config.live.prizeDiamonds;

    statements.push(
      stmt(
        db,
        `UPDATE players SET coins = coins + ?, diamonds = diamonds + ?, updated_at = ?
          WHERE user_id = ? AND ${balanceGuard}`,
        config.live.prizeCoins,
        config.live.prizeDiamonds,
        now,
        championId,
        tournamentId
      )
    );

    const stateRow = await one(db, 'SELECT state, version FROM player_states WHERE user_id = ?', championId);
    if (stateRow) {
      try {
        const state = JSON.parse(stateRow.state);
        state.coin = nextCoins;
        state.diamonds = nextDiamonds;
        statements.push(
          stmt(
            db,
            `UPDATE player_states SET state = ?, version = ?, updated_at = ?
              WHERE user_id = ? AND ${balanceGuard}`,
            JSON.stringify(state),
            Number(stateRow.version) + 1,
            now,
            championId,
            tournamentId
          )
        );
      } catch {
        /* corrupt snapshot is replaced by the next client save */
      }
    }

    const insertTransaction = (currency, amount, balanceAfter) =>
      stmt(
        db,
        `INSERT INTO transactions (id, user_id, type, currency, amount, balance_after, ref, meta, created_at)
         SELECT ?, ?, 'live_tournament_reward', ?, ?, ?, ?, ?, ?
          WHERE ${balanceGuard}`,
        crypto.randomUUID(),
        championId,
        currency,
        amount,
        balanceAfter,
        tournamentId,
        JSON.stringify({ tournament: tournament.number }),
        now,
        tournamentId
      );

    statements.push(insertTransaction('coin', config.live.prizeCoins, nextCoins));
    statements.push(insertTransaction('diamond', config.live.prizeDiamonds, nextDiamonds));
  }

  statements.push(
    stmt(
      db,
      `UPDATE live_tournaments
          SET status = 'complete', completed_at = ?, champion_user_id = ?, payload = ?
        WHERE id = ? AND status = 'running'`,
      now,
      championId,
      JSON.stringify(payload),
      tournamentId
    )
  );

  await batch(db, statements);
  return true;
}

async function processRunning(db, tournament, catalog, config, now) {
  const size = Number(tournament.size);
  const live = await one(
    db,
    "SELECT * FROM live_matches WHERE tournament_id = ? AND status = 'live' ORDER BY starts_at LIMIT 1",
    tournament.id
  );

  if (live) {
    if (now < Number(live.ends_at)) return false;
    const ended = await run(
      db,
      "UPDATE live_matches SET status = 'done', ended_at = ? WHERE tournament_id = ? AND id = ? AND status = 'live'",
      live.ends_at,
      tournament.id,
      live.id
    );
    if (!ended.meta?.changes) return true;
    if (live.winner) await propagateWinner(db, tournament.id, live.round, live.slot, live.winner);
    const nextAt = Number(live.ends_at) + config.live.restMs;
    await run(db, 'UPDATE live_tournaments SET next_match_at = ? WHERE id = ?', nextAt, tournament.id);
    await propagateByes(db, tournament.id, size, now);
    const remaining = await one(
      db,
      "SELECT COUNT(*) AS count FROM live_matches WHERE tournament_id = ? AND status <> 'done'",
      tournament.id
    );
    if (!Number(remaining?.count)) await finalizeTournament(db, tournament.id, size, config, now);
    return true;
  }

  await propagateByes(db, tournament.id, size, now);
  if (now < (Number(tournament.next_match_at) || 0)) return false;

  const match = await findPlayableMatch(db, tournament.id, size);
  if (!match) {
    const remaining = await one(
      db,
      "SELECT COUNT(*) AS count FROM live_matches WHERE tournament_id = ? AND status <> 'done'",
      tournament.id
    );
    if (!Number(remaining?.count)) {
      await finalizeTournament(db, tournament.id, size, config, now);
      return true;
    }
    return false;
  }
  await startMatch(db, tournament, match, catalog, config, now);
  return true;
}

async function tickOnce(db, catalog, config, now) {
  const tournament = await latestTournament(db);
  if (!tournament) return false;

  if (tournament.status === 'registration') {
    const count = await countEntries(db, tournament.id);
    if (count >= Number(tournament.size)) {
      await scheduleTournament(db, tournament, config, now);
      return true;
    }
    if (now >= Number(tournament.deadline_at)) {
      if (count >= config.live.minParticipants) {
        await scheduleTournament(db, tournament, config, now);
      } else {
        await run(
          db,
          'UPDATE live_tournaments SET deadline_at = ? WHERE id = ?',
          now + config.live.registrationMs,
          tournament.id
        );
      }
      return true;
    }
    return false;
  }

  if (tournament.status === 'scheduled') {
    if (now >= Number(tournament.start_at)) return startTournament(db, tournament, catalog, config, now);
    return false;
  }

  if (tournament.status === 'running') return processRunning(db, tournament, catalog, config, now);
  return false;
}

async function acquireTickLock(db, now, ttlMs) {
  await run(db, "INSERT OR IGNORE INTO meta(key, value) VALUES('live_lock', '0')");
  const result = await run(
    db,
    "UPDATE meta SET value = ? WHERE key = 'live_lock' AND CAST(value AS INTEGER) < ?",
    String(now + ttlMs),
    now
  );
  return Boolean(result.meta?.changes);
}

async function releaseTickLock(db) {
  await run(db, "UPDATE meta SET value = '0' WHERE key = 'live_lock'");
}

export async function tickLive(env, config, catalog, now = Date.now()) {
  const db = env.DB;
  if (!(await acquireTickLock(db, now, config.live.lockTtlMs))) return false;
  let changedAny = false;
  try {
    for (let index = 0; index < 10; index += 1) {
      const changed = await tickOnce(db, catalog, config, now);
      if (changed) changedAny = true;
      if (!changed) break;
    }
  } finally {
    await releaseTickLock(db);
  }
  return changedAny;
}

export async function maybeTick(env, config, catalog, now = Date.now()) {
  const db = env.DB;
  const tournament = await latestTournament(db);
  if (!tournament) {
    await tickLive(env, config, catalog, now);
    return;
  }
  if (tournament.status === 'registration') {
    const count = await countEntries(db, tournament.id);
    if (count >= Number(tournament.size) || now >= Number(tournament.deadline_at)) {
      await tickLive(env, config, catalog, now);
    }
    return;
  }
  if (tournament.status === 'scheduled') {
    if (now >= Number(tournament.start_at)) await tickLive(env, config, catalog, now);
    return;
  }
  if (tournament.status === 'running') {
    const live = await one(
      db,
      "SELECT ends_at FROM live_matches WHERE tournament_id = ? AND status = 'live' ORDER BY starts_at LIMIT 1",
      tournament.id
    );
    if (live) {
      if (now >= Number(live.ends_at)) await tickLive(env, config, catalog, now);
    } else if (now >= Number(tournament.next_match_at || 0)) {
      await tickLive(env, config, catalog, now);
    }
  }
}

/* ---------- entries ---------- */
export async function joinLive(env, config, catalog, userId, heroId) {
  const db = env.DB;
  const hero = catalog.getHero(heroId);
  if (!hero) throw Object.assign(new Error('Bunday jangchi topilmadi.'), { status: 404, code: 'NOT_FOUND' });
  if (hero.test) {
    throw Object.assign(new Error('Sinov jangchisi bilan turnirga kirilmaydi.'), {
      status: 422,
      code: 'INVALID_HERO',
    });
  }

  let tournament = await ensureOpenTournament(db, config);
  if (tournament.status !== 'registration') {
    throw Object.assign(new Error('Bu turnirga ro‘yxatdan o‘tish yopilgan.'), {
      status: 409,
      code: 'LIVE_CLOSED',
    });
  }
  const existing = await one(
    db,
    'SELECT 1 AS joined FROM live_entries WHERE tournament_id = ? AND user_id = ?',
    tournament.id,
    userId
  );
  if (existing) {
    throw Object.assign(new Error('Siz allaqachon bu turnirda qatnashyapsiz.'), {
      status: 409,
      code: 'LIVE_ALREADY_ENTERED',
    });
  }
  const count = await countEntries(db, tournament.id);
  if (count >= Number(tournament.size)) {
    await scheduleTournament(db, tournament, config);
    throw Object.assign(new Error('Turnir to‘ldi. Keyingisini kuting.'), { status: 409, code: 'LIVE_FULL' });
  }
  const user = await one(db, 'SELECT nickname FROM users WHERE id = ?', userId);
  if (!user) throw Object.assign(new Error('Avtorizatsiya talab qilinadi.'), { status: 401, code: 'UNAUTHORIZED' });
  await run(
    db,
    `INSERT INTO live_entries (tournament_id, user_id, name, hero_id, hero_tier, seed, joined_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    tournament.id,
    userId,
    user.nickname,
    hero.id,
    hero.tier,
    count + 1,
    Date.now()
  );
  if (count + 1 >= Number(tournament.size)) {
    await scheduleTournament(db, tournament, config);
  }
  return tournament.id;
}

export async function leaveLive(env, config, userId) {
  const db = env.DB;
  const tournament = await latestTournament(db);
  if (!tournament || tournament.status !== 'registration') {
    throw Object.assign(new Error('Ro‘yxatdan chiqish uchun vaqt o‘tib ketdi.'), {
      status: 409,
      code: 'LIVE_LOCKED',
    });
  }
  const result = await run(
    db,
    'DELETE FROM live_entries WHERE tournament_id = ? AND user_id = ?',
    tournament.id,
    userId
  );
  if (!result.meta?.changes) {
    throw Object.assign(new Error('Siz bu turnirda qatnashmayapsiz.'), { status: 404, code: 'NOT_FOUND' });
  }
}

/* ---------- state builders ---------- */
function heroInfo(catalog, heroId) {
  const hero = catalog.getHero(heroId);
  if (!hero) {
    return { id: heroId, name: heroId, tier: 'E', tierName: 'Boshlang‘ich', color: '#8999ab', hue: 220 };
  }
  return {
    id: hero.id,
    name: hero.name,
    tier: hero.tier,
    tierName: hero.tierName,
    color: hero.tierColor,
    hue: hero.hue,
  };
}

function roundName(size, round) {
  const left = size / 2 ** round;
  if (left === 2) return 'FINAL';
  if (left === 4) return 'YARIM FINAL';
  if (left === 8) return 'CHORAK FINAL';
  return `1/${left / 2} FINAL`;
}

async function buildTournamentView(db, tournament, userId, catalog, config) {
  const now = Date.now();
  const entries = await all(db, 'SELECT * FROM live_entries WHERE tournament_id = ? ORDER BY seed', tournament.id);
  const entryMap = new Map(entries.map((entry) => [entry.user_id, entry]));
  const person = (id) => {
    const entry = entryMap.get(id);
    if (!entry) return null;
    return {
      userId: entry.user_id,
      name: entry.name,
      heroId: entry.hero_id,
      hero: heroInfo(catalog, entry.hero_id),
      isMe: entry.user_id === userId,
    };
  };

  const matches = await all(
    db,
    'SELECT * FROM live_matches WHERE tournament_id = ? ORDER BY round, slot',
    tournament.id
  );
  const rounds = [];
  const roundsCount = matches.length ? Math.max(...matches.map((match) => match.round)) + 1 : 0;
  for (let round = 0; round < roundsCount; round += 1) {
    rounds.push({
      round,
      name: roundName(Number(tournament.size), round),
      matches: matches
        .filter((match) => match.round === round)
        .map((match) => {
          let timeline = null;
          if ((match.status === 'live' || match.status === 'done') && match.timeline) {
            try {
              timeline = JSON.parse(match.timeline);
            } catch {
              timeline = null;
            }
          }
          return {
            id: match.id,
            round: match.round,
            slot: match.slot,
            a: person(match.a),
            b: person(match.b),
            winner: match.status === 'done' ? match.winner : null,
            status: match.status,
            startsAt: match.starts_at,
            endsAt: match.ends_at,
            endedAt: match.ended_at,
            durationMs:
              match.starts_at && match.ends_at ? Math.max(0, match.ends_at - match.starts_at) : null,
            timeline,
          };
        }),
    });
  }

  const liveMatch = matches.find((match) => match.status === 'live') || null;
  const current = liveMatch
    ? rounds.flatMap((round) => round.matches).find((match) => match.id === liveMatch.id) || null
    : null;
  const championId = tournament.champion_user_id || null;
  const myEntry = entryMap.get(userId) || null;
  const nextMatch = matches
    .filter((match) => match.status === 'pending' && match.a && match.b)
    .sort((a, b) => a.round - b.round || a.slot - b.slot)[0];

  return {
    id: tournament.id,
    number: tournament.number,
    size: Number(tournament.size),
    status: tournament.status,
    opensAt: tournament.opens_at,
    deadlineAt: tournament.deadline_at,
    startAt: tournament.start_at,
    startedAt: tournament.started_at,
    completedAt: tournament.completed_at,
    nextAt:
      tournament.status === 'running'
        ? liveMatch?.ends_at || tournament.next_match_at
        : tournament.status === 'scheduled'
          ? tournament.start_at
          : tournament.deadline_at,
    serverNow: now,
    capacity: Number(tournament.size),
    filled: entries.length,
    entrants: entries.map((entry) => person(entry.user_id)),
    myEntry: myEntry
      ? { heroId: myEntry.hero_id, hero: heroInfo(catalog, myEntry.hero_id), name: myEntry.name }
      : null,
    bracket: { rounds },
    currentMatch: current,
    nextMatch: nextMatch
      ? {
          id: nextMatch.id,
          round: nextMatch.round,
          name: roundName(Number(tournament.size), nextMatch.round),
          a: person(nextMatch.a),
          b: person(nextMatch.b),
          at: tournament.next_match_at,
        }
      : null,
    restUntil:
      tournament.status === 'running' && !liveMatch && tournament.next_match_at
        ? tournament.next_match_at
        : null,
    champion: championId ? { ...person(championId), userId: championId } : null,
    prize: { coins: config.live.prizeCoins, diamonds: config.live.prizeDiamonds },
  };
}

export async function getLiveHistory(env, config, catalog, userId) {
  const rows = await all(
    env.DB,
    "SELECT id, number, completed_at, payload FROM live_tournaments WHERE status = 'complete' ORDER BY completed_at DESC LIMIT ?",
    config.live.historyLimit
  );
  return rows.map((row) => {
    let payload = null;
    try {
      payload = JSON.parse(row.payload || 'null');
    } catch {
      payload = null;
    }
    const standings = Array.isArray(payload?.standings) ? payload.standings : [];
    const mine = standings.find((entry) => entry.userId === userId) || null;
    const champion = payload?.champion || null;
    return {
      id: row.id,
      number: row.number,
      completedAt: row.completed_at,
      entrants: standings.length,
      champion: champion
        ? { name: champion.name, heroId: champion.heroId, hero: heroInfo(catalog, champion.heroId) }
        : null,
      mine: mine
        ? {
            place: mine.place,
            wins: mine.wins,
            heroId: mine.heroId,
            hero: heroInfo(catalog, mine.heroId),
          }
        : null,
      prize: { coins: config.live.prizeCoins, diamonds: config.live.prizeDiamonds },
    };
  });
}

export async function getLiveState(env, config, catalog, userId) {
  await maybeTick(env, config, catalog);
  const tournament = await ensureOpenTournament(env.DB, config);
  return {
    tournament: await buildTournamentView(env.DB, tournament, userId, catalog, config),
    history: await getLiveHistory(env, config, catalog, userId),
  };
}
