'use strict';

/**
 * Global “people” tournaments.
 *
 * Players register; when the cup is full (or the registration window closes)
 * the server builds a single-elimination bracket. Every participant is
 * represented by a bot driven by the server — users cannot control fights and
 * cannot talk to each other. Matches run strictly one after another with a
 * one-minute break, so every client polling `/api/live/state` sees the same
 * fight at the same moment.
 */

const crypto = require('node:crypto');
const { transaction } = require('../db');
const { errors } = require('../util/http');
const { applyWalletDelta } = require('./state');
const { recordTransaction } = require('./player');

const MIN_HERO_TIER = new Set(['E', 'D', 'C', 'B', 'A', 'S', 'Z']);

/* ---------- deterministic RNG (fight results survive server restarts) ---------- */
function hashSeed(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
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

function heroPower(hero) {
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

/* ---------- fight simulation ---------- */
function simulateFight(seedText, heroA, heroB, config) {
  const rng = mulberry32(hashSeed(seedText));
  const powerA = heroPower(heroA);
  const powerB = heroPower(heroB);
  const scoreA = powerA * (0.72 + rng() * 0.56);
  const scoreB = powerB * (0.72 + rng() * 0.56);
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

    timeline.push({
      t,
      actor,
      skill,
      damage,
      hpA: round2(hpA),
      hpB: round2(hpB),
    });
  }

  return { winner, durationMs, timeline };
}

/* ---------- tournament lifecycle ---------- */
function latestTournament(db) {
  return db
    .prepare(
      "SELECT * FROM live_tournaments WHERE status IN ('registration','scheduled','running') ORDER BY created_at DESC LIMIT 1"
    )
    .get();
}

function ensureOpenTournament(db, config) {
  let tournament = latestTournament(db);
  if (tournament) return tournament;

  const now = Date.now();
  const lastNumber = db.prepare('SELECT MAX(number) AS number FROM live_tournaments').get()?.number || 0;
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO live_tournaments
       (id, number, size, status, opens_at, deadline_at, start_at, created_at)
     VALUES (?, ?, ?, 'registration', ?, ?, ?, ?)`
  ).run(
    id,
    Number(lastNumber) + 1,
    config.live.size,
    now,
    now + config.live.registrationMs,
    now + config.live.registrationMs,
    now
  );
  return db.prepare('SELECT * FROM live_tournaments WHERE id = ?').get(id);
}

function countEntries(db, tournamentId) {
  return db
    .prepare('SELECT COUNT(*) AS count FROM live_entries WHERE tournament_id = ?')
    .get(tournamentId).count;
}

function scheduleTournament(db, tournament, config, now = Date.now()) {
  const previous = db
    .prepare('SELECT MAX(started_at) AS started FROM live_tournaments WHERE started_at IS NOT NULL AND id <> ?')
    .get(tournament.id);
  const earliest = (Number(previous?.started) || 0) + config.live.cycleMs;
  const startAt = Math.max(now, earliest);
  db.prepare("UPDATE live_tournaments SET status = 'scheduled', start_at = ? WHERE id = ?").run(
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

function isPowerOfTwo(value) {
  return value >= 2 && (value & (value - 1)) === 0;
}

function startTournament(db, tournament, catalog, config, now = Date.now()) {
  const entries = db
    .prepare('SELECT * FROM live_entries WHERE tournament_id = ? ORDER BY seed')
    .all(tournament.id);
  if (entries.length < 2) {
    db.prepare('UPDATE live_tournaments SET deadline_at = ? WHERE id = ?').run(
      now + config.live.registrationMs,
      tournament.id
    );
    return false;
  }

  const rng = mulberry32(hashSeed(`${tournament.id}:bracket`));
  const seeded = shuffle(entries, rng);
  // Use the smallest power-of-two bracket that fits everyone, but never more
  // than the advertised capacity. This avoids a 2-player final played in a
  // 16-slot skeleton full of empty byes.
  const bracketSize = 2 ** Math.ceil(Math.log2(Math.max(2, seeded.length)));
  const size = Math.min(isPowerOfTwo(tournament.size) ? tournament.size : bracketSize, bracketSize);
  const slots = new Array(size).fill(null);
  seeded.forEach((entry, index) => {
    slots[index] = entry.user_id;
  });

  const insertMatch = db.prepare(
    `INSERT INTO live_matches (tournament_id, id, round, slot, a, b, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const rounds = Math.log2(size);
  for (let round = 0; round < rounds; round += 1) {
    const matches = size / 2 ** (round + 1);
    for (let slot = 0; slot < matches; slot += 1) {
      const a = round === 0 ? slots[slot * 2] : null;
      const b = round === 0 ? slots[slot * 2 + 1] : null;
      insertMatch.run(
        tournament.id,
        `r${round}m${slot}`,
        round,
        slot,
        a,
        b,
        round === 0 ? 'pending' : 'pending'
      );
    }
  }

  db.prepare(
    `UPDATE live_tournaments
        SET status = 'running', started_at = ?, next_match_at = ?, size = ?
      WHERE id = ?`
  ).run(now, now, size, tournament.id);

  propagateByes(db, tournament.id, size, now);
  return true;
}

function parentSlot(slot) {
  return Math.floor(slot / 2);
}

function propagateWinner(db, tournamentId, round, slot, winner) {
  db.prepare(
    'UPDATE live_matches SET a = CASE WHEN slot % 2 = 0 THEN ? ELSE a END, b = CASE WHEN slot % 2 = 1 THEN ? ELSE b END WHERE tournament_id = ? AND round = ? AND slot = ?'
  ).run(winner, winner, tournamentId, round + 1, parentSlot(slot));
}

/**
 * A match with a missing side is a bye: advance the present player, or mark the
 * match done when both sides are empty. Runs until stable.
 */
function propagateByes(db, tournamentId, size, now = Date.now()) {
  const rounds = Math.log2(size);
  for (let round = 0; round < rounds; round += 1) {
    // Re-read each round after the previous one was resolved: winners are
    // written into the next round by propagateWinner().
    const matches = db
      .prepare('SELECT * FROM live_matches WHERE tournament_id = ? AND round = ? ORDER BY slot')
      .all(tournamentId, round);
    for (const match of matches) {
      if (match.status !== 'pending') continue;

      // A later-round match may only be judged once both feeder matches ended.
      if (round > 0) {
        const feeders = db
          .prepare(
            'SELECT status FROM live_matches WHERE tournament_id = ? AND round = ? AND slot IN (?, ?)'
          )
          .all(tournamentId, round - 1, match.slot * 2, match.slot * 2 + 1);
        if (feeders.length < 2 || feeders.some((feeder) => feeder.status !== 'done')) continue;
      }

      if (match.a && match.b) continue;
      const winner = match.a || match.b || null;
      db.prepare(
        "UPDATE live_matches SET status = 'done', winner = ?, ended_at = ?, starts_at = ?, ends_at = ? WHERE tournament_id = ? AND id = ?"
      ).run(winner, now, now, now, tournamentId, match.id);
      if (winner && round + 1 < rounds) propagateWinner(db, tournamentId, round, match.slot, winner);
    }
  }
}

function findPlayableMatch(db, tournamentId, size) {
  const rounds = Math.log2(size);
  for (let round = 0; round < rounds; round += 1) {
    const matches = db
      .prepare(
        "SELECT * FROM live_matches WHERE tournament_id = ? AND round = ? AND status = 'pending' ORDER BY slot"
      )
      .all(tournamentId, round);
    for (const match of matches) {
      if (match.a && match.b) return match;
    }
  }
  return null;
}

function finishMatch(db, tournament, match, size, config, now) {
  db.prepare(
    "UPDATE live_matches SET status = 'done', ended_at = ? WHERE tournament_id = ? AND id = ?"
  ).run(match.ends_at, tournament.id, match.id);
  if (match.winner) propagateWinner(db, tournament.id, match.round, match.slot, match.winner);
  const nextAt = match.ends_at + config.live.restMs;
  db.prepare('UPDATE live_tournaments SET next_match_at = ? WHERE id = ?').run(nextAt, tournament.id);
  propagateByes(db, tournament.id, size, now);

  const remaining = db
    .prepare("SELECT COUNT(*) AS count FROM live_matches WHERE tournament_id = ? AND status <> 'done'")
    .get(tournament.id).count;
  if (remaining === 0) finalizeTournament(db, tournament.id, size, config, now);
}

function startMatch(db, tournament, match, catalog, config, now) {
  const heroA = catalog.getHero(entryHero(db, tournament.id, match.a));
  const heroB = catalog.getHero(entryHero(db, tournament.id, match.b));
  const simulation = simulateFight(`${tournament.id}:${match.id}`, heroA, heroB, config);
  const endsAt = now + simulation.durationMs;
  const winnerId = simulation.winner === 'a' ? match.a : match.b;
  db.prepare(
    `UPDATE live_matches
        SET status = 'live', starts_at = ?, ends_at = ?, winner = ?, timeline = ?
      WHERE tournament_id = ? AND id = ?`
  ).run(now, endsAt, winnerId, JSON.stringify(simulation.timeline), tournament.id, match.id);
  db.prepare('UPDATE live_tournaments SET next_match_at = ? WHERE id = ?').run(endsAt, tournament.id);
}

function entryHero(db, tournamentId, userId) {
  return db
    .prepare('SELECT hero_id FROM live_entries WHERE tournament_id = ? AND user_id = ?')
    .get(tournamentId, userId)?.hero_id || null;
}

function placeForLoss(size, round) {
  return Math.floor(size / 2 ** (round + 1)) + 1;
}

function finalizeTournament(db, tournamentId, size, config, now = Date.now()) {
  const tournament = db.prepare('SELECT * FROM live_tournaments WHERE id = ?').get(tournamentId);
  if (!tournament || tournament.status === 'complete') return;

  const entries = db
    .prepare('SELECT * FROM live_entries WHERE tournament_id = ? ORDER BY seed')
    .all(tournamentId);
  const matches = db
    .prepare("SELECT * FROM live_matches WHERE tournament_id = ? AND status = 'done'")
    .all(tournamentId);
  const final = matches.find((match) => match.round === Math.log2(size) - 1);
  const championId = final?.winner || null;

  const standings = entries.map((entry) => {
    const won = matches.filter((match) => match.winner === entry.user_id).length;
    if (entry.user_id === championId) {
      return { userId: entry.user_id, name: entry.name, heroId: entry.hero_id, place: 1, wins: won };
    }
    const loss = matches.find((match) => match.winner && match.winner !== entry.user_id && [match.a, match.b].includes(entry.user_id));
    return {
      userId: entry.user_id,
      name: entry.name,
      heroId: entry.hero_id,
      place: loss ? placeForLoss(size, loss.round) : 1,
      wins: won,
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

  transaction(db, () => {
    db.prepare(
      "UPDATE live_tournaments SET status = 'complete', completed_at = ?, champion_user_id = ?, payload = ? WHERE id = ?"
    ).run(now, championId, JSON.stringify(payload), tournamentId);

    const championPlayer = championId
      ? db.prepare('SELECT 1 AS present FROM players WHERE user_id = ?').get(championId)
      : null;

    if (championId && championPlayer) {
      applyWalletDelta(db, championId, {
        coins: config.live.prizeCoins,
        diamonds: config.live.prizeDiamonds,
      });
      const coins = db.prepare('SELECT coins FROM players WHERE user_id = ?').get(championId)?.coins || 0;
      const diamonds = db.prepare('SELECT diamonds FROM players WHERE user_id = ?').get(championId)?.diamonds || 0;
      recordTransaction(db, {
        userId: championId,
        type: 'live_tournament_reward',
        currency: 'coin',
        amount: config.live.prizeCoins,
        balanceAfter: coins,
        ref: tournamentId,
        meta: { tournament: tournament.number },
        at: now,
      });
      recordTransaction(db, {
        userId: championId,
        type: 'live_tournament_reward',
        currency: 'diamond',
        amount: config.live.prizeDiamonds,
        balanceAfter: diamonds,
        ref: tournamentId,
        meta: { tournament: tournament.number },
        at: now,
      });
    }
  });
}

function processRunning(db, tournament, catalog, config, now) {
  const size = tournament.size;
  const live = db
    .prepare(
      "SELECT * FROM live_matches WHERE tournament_id = ? AND status = 'live' ORDER BY starts_at LIMIT 1"
    )
    .get(tournament.id);

  if (live) {
    if (now < live.ends_at) return;
    finishMatch(db, tournament, live, size, config, now);
    return;
  }

  propagateByes(db, tournament.id, size, now);
  if (now < (Number(tournament.next_match_at) || 0)) return;

  const match = findPlayableMatch(db, tournament.id, size);
  if (!match) {
    const remaining = db
      .prepare("SELECT COUNT(*) AS count FROM live_matches WHERE tournament_id = ? AND status <> 'done'")
      .get(tournament.id).count;
    if (remaining === 0) finalizeTournament(db, tournament.id, size, config, now);
    return;
  }
  startMatch(db, tournament, match, catalog, config, now);
}

/**
 * Advance the global tournament clock. Safe to call every second.
 */
function tickLive(db, catalog, config) {
  const now = Date.now();
  const tournament = ensureOpenTournament(db, config);

  if (tournament.status === 'registration') {
    const count = countEntries(db, tournament.id);
    if (count >= tournament.size) {
      scheduleTournament(db, tournament, config, now);
      return;
    }
    if (now >= tournament.deadline_at) {
      if (count >= config.live.minParticipants) {
        scheduleTournament(db, tournament, config, now);
      } else {
        db.prepare('UPDATE live_tournaments SET deadline_at = ? WHERE id = ?').run(
          now + config.live.registrationMs,
          tournament.id
        );
      }
    }
    return;
  }

  if (tournament.status === 'scheduled') {
    if (now >= tournament.start_at) startTournament(db, tournament, catalog, config, now);
    return;
  }

  if (tournament.status === 'running') processRunning(db, tournament, catalog, config, now);
}

/* ---------- API-facing helpers ---------- */
function joinLive(db, { userId, heroId, catalog, config }) {
  const hero = catalog.getHero(heroId);
  if (!hero) throw errors.notFound('Bunday jangchi topilmadi.');
  if (hero.test) throw errors.unprocessable('INVALID_HERO', 'Sinov jangchisi bilan turnirga kirilmaydi.');
  if (!MIN_HERO_TIER.has(hero.tier)) throw errors.unprocessable('INVALID_HERO', 'Jangchi darajasi noto‘g‘ri.');

  return transaction(db, () => {
    let tournament = ensureOpenTournament(db, config);
    if (tournament.status !== 'registration') {
      throw errors.conflict('LIVE_CLOSED', 'Bu turnirga ro‘yxatdan o‘tish yopilgan. Keyingisini kuting.');
    }

    const existing = db
      .prepare('SELECT 1 AS joined FROM live_entries WHERE tournament_id = ? AND user_id = ?')
      .get(tournament.id, userId);
    if (existing) throw errors.conflict('LIVE_ALREADY_ENTERED', 'Siz allaqachon bu turnirda qatnashyapsiz.');

    const count = countEntries(db, tournament.id);
    if (count >= tournament.size) {
      scheduleTournament(db, tournament, config);
      throw errors.conflict('LIVE_FULL', 'Turnir to‘ldi. Keyingisini kuting.');
    }

    const user = db.prepare('SELECT nickname FROM users WHERE id = ?').get(userId);
    if (!user) throw errors.unauthorized();

    db.prepare(
      `INSERT INTO live_entries (tournament_id, user_id, name, hero_id, hero_tier, seed, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(tournament.id, userId, user.nickname, hero.id, hero.tier, count + 1, Date.now());

    if (count + 1 >= tournament.size) {
      scheduleTournament(db, tournament, config);
    }

    return { tournamentId: tournament.id };
  });
}

function leaveLive(db, { userId, config }) {
  const tournament = latestTournament(db);
  if (!tournament || tournament.status !== 'registration') {
    throw errors.conflict('LIVE_LOCKED', 'Ro‘yxatdan chiqish uchun vaqt o‘tib ketdi.');
  }
  const result = db
    .prepare('DELETE FROM live_entries WHERE tournament_id = ? AND user_id = ?')
    .run(tournament.id, userId);
  if (result.changes === 0) throw errors.notFound('Siz bu turnirda qatnashmayapsiz.');
  return { tournamentId: tournament.id };
}

function heroInfo(catalog, heroId) {
  const hero = catalog.getHero(heroId);
  if (!hero) return { id: heroId, name: heroId, tier: 'E', tierName: 'Boshlang‘ich', color: '#8999ab', hue: 220 };
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

function buildTournamentView(db, tournament, { userId, catalog, config }) {
  const now = Date.now();
  const entries = db
    .prepare('SELECT * FROM live_entries WHERE tournament_id = ? ORDER BY seed')
    .all(tournament.id);
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

  const matches = db
    .prepare('SELECT * FROM live_matches WHERE tournament_id = ? ORDER BY round, slot')
    .all(tournament.id);
  const rounds = [];
  const roundsCount = matches.length ? Math.max(...matches.map((match) => match.round)) + 1 : 0;
  for (let round = 0; round < roundsCount; round += 1) {
    rounds.push({
      round,
      name: roundName(tournament.size, round),
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
    ? rounds
        .flatMap((round) => round.matches)
        .find((match) => match.id === liveMatch.id) || null
    : null;
  const final = matches.find((match) => match.round === roundsCount - 1 && match.status === 'done');
  const championId = tournament.champion_user_id || (tournament.status === 'complete' ? final?.winner : null) || null;
  const myEntry = entryMap.get(userId) || null;
  const nextMatch = matches
    .filter((match) => match.status === 'pending' && match.a && match.b)
    .sort((a, b) => a.round - b.round || a.slot - b.slot)[0];

  return {
    id: tournament.id,
    number: tournament.number,
    size: tournament.size,
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
    capacity: tournament.size,
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
          name: roundName(tournament.size, nextMatch.round),
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

function getLiveState(db, { userId, catalog, config }) {
  const tournament = ensureOpenTournament(db, config);
  return {
    tournament: buildTournamentView(db, tournament, { userId, catalog, config }),
    history: getLiveHistory(db, { userId, catalog, config }),
  };
}

function getLiveHistory(db, { userId, catalog, config }) {
  const rows = db
    .prepare(
      "SELECT id, number, completed_at, payload FROM live_tournaments WHERE status = 'complete' ORDER BY completed_at DESC LIMIT ?"
    )
    .all(config.live.historyLimit);

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

module.exports = {
  tickLive,
  joinLive,
  leaveLive,
  getLiveState,
  getLiveHistory,
  ensureOpenTournament,
  simulateFight,
  heroPower,
};
