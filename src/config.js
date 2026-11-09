'use strict';

const path = require('node:path');

const root = path.join(__dirname, '..');

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function envList(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

const config = {
  env: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '127.0.0.1',
  port: envInt('PORT', 8787),
  root,
  publicDir: path.join(root, '..', 'fronted'),
  dataDir: path.join(root, 'data'),
  catalogPath: path.join(root, 'data', 'catalog.json'),
  dbPath: path.resolve(process.env.DB_PATH || path.join(root, 'data', 'anime-arena.db')),

  // 30 days by default — the game is long-lived and sessions are revocable.
  sessionTtlMs: envInt('SESSION_TTL_HOURS', 24 * 30) * 3600_000,
  bodyLimit: envInt('BODY_LIMIT_BYTES', 64 * 1024),
  stateLimit: envInt('STATE_LIMIT_BYTES', 512 * 1024),
  trustProxy: process.env.TRUST_PROXY === '1',
  secureCookies: process.env.SECURE_COOKIES === '1' || process.env.NODE_ENV === 'production',

  // The admin account is reserved: it can only be registered with ADMIN_PASSWORD.
  admin: {
    email: (process.env.ADMIN_EMAIL || 'xasanovlazizbek10@gmail.com').toLowerCase(),
    password: process.env.ADMIN_PASSWORD || '',
  },

  // Live (people) tournament: sequential bot-driven fights, one at a time,
  // with a full-minute break between matches. The next cup starts at most
  // once per hour (LIVE_CYCLE_MS).
  live: {
    size: envInt('LIVE_TOURNAMENT_SIZE', 16),
    prizeCoins: envInt('LIVE_PRIZE_COINS', 30_000),
    prizeDiamonds: envInt('LIVE_PRIZE_DIAMONDS', 10),
    restMs: envInt('LIVE_REST_MS', 60_000),
    fightMinMs: envInt('LIVE_FIGHT_MIN_MS', 18_000),
    fightMaxMs: envInt('LIVE_FIGHT_MAX_MS', 28_000),
    cycleMs: envInt('LIVE_CYCLE_MS', 3_600_000),
    registrationMs: envInt('LIVE_REGISTRATION_MS', 3_600_000),
    minParticipants: envInt('LIVE_MIN_PARTICIPANTS', 2),
    tickerMs: envInt('LIVE_TICKER_MS', 1_000),
    historyLimit: 30,
  },

  corsOrigins: envList('CORS_ORIGINS', [
    'http://localhost:8787',
    'http://127.0.0.1:8787',
    'http://localhost:3000',
    'null',
  ]),

  rateLimit: {
    windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000),
    max: envInt('RATE_LIMIT_MAX', 180),
    authMax: envInt('RATE_LIMIT_AUTH_MAX', 12),
  },

  economy: {
    startingCoins: 15_000,
    startingDiamonds: 0,
    startingTokens: 8,
    maxTokens: 8,
    tokenIntervalMs: 2 * 3600_000, // one token every two hours
    tournamentPrizeCoins: 30_000,
    tournamentPrizeDiamonds: 10,
    tournamentSelectionCost: 15,
    tournamentSize: 32,
    tournamentCooldownMs: 2 * 60_000,
    levelCooldownMs: 3_000,
    levelDailyLimit: 300,
    tournamentDailyLimit: 20,
    maxLevel: 100,
  },
};

module.exports = config;
