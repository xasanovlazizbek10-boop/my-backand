'use strict';

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function getConfig(env) {
  return {
    admin: {
      email: String(env.ADMIN_EMAIL || 'xasanovlazizbek10@gmail.com').toLowerCase(),
      password: String(env.ADMIN_PASSWORD || ''),
    },
    sessionTtlMs: int(env.SESSION_TTL_HOURS, 720) * 3_600_000,
    bodyLimit: 64 * 1024,
    stateLimit: 512 * 1024,
    corsOrigins: String(env.CORS_ORIGINS || 'null')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    economy: {
      startingCoins: 15_000,
      startingDiamonds: 0,
      startingTokens: 8,
      maxTokens: 8,
      tokenIntervalMs: 2 * 3_600_000,
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
    live: {
      size: int(env.LIVE_TOURNAMENT_SIZE, 16),
      prizeCoins: int(env.LIVE_PRIZE_COINS, 30_000),
      prizeDiamonds: int(env.LIVE_PRIZE_DIAMONDS, 10),
      restMs: int(env.LIVE_REST_MS, 60_000),
      fightMinMs: int(env.LIVE_FIGHT_MIN_MS, 18_000),
      fightMaxMs: int(env.LIVE_FIGHT_MAX_MS, 28_000),
      cycleMs: int(env.LIVE_CYCLE_MS, 3_600_000),
      registrationMs: int(env.LIVE_REGISTRATION_MS, 3_600_000),
      minParticipants: int(env.LIVE_MIN_PARTICIPANTS, 2),
      historyLimit: 30,
      lockTtlMs: 30_000,
    },
  };
}
