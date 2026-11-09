'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const defaultConfig = require('../src/config');
const { createApp } = require('../src/app');

/* ---------- test harness ---------- */
async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-arena-test-'));
  const app = createApp({
    ...defaultConfig,
    dbPath: path.join(dir, 'test.db'),
    silent: true,
    corsOrigins: ['null', 'http://localhost'],
    rateLimit: { windowMs: 60_000, max: 10_000, authMax: 10_000 },
    economy: {
      ...defaultConfig.economy,
      levelCooldownMs: 0,
      tournamentCooldownMs: 0,
      levelDailyLimit: 10_000,
      tournamentDailyLimit: 10_000,
    },
    live: {
      ...defaultConfig.live,
      size: 4,
      restMs: 15,
      fightMinMs: 50,
      fightMaxMs: 80,
      cycleMs: 0,
      registrationMs: 120,
      minParticipants: 2,
      tickerMs: 30,
      historyLimit: 10,
    },
  });

  const server = http.createServer((req, res) => app.handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const api = async (method, route, { body, token } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + route, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = text;
    }
    return { status: response.status, payload, headers: response.headers };
  };

  return {
    app,
    base,
    api,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const ACCOUNT = {
  firstName: 'Aziz',
  lastName: 'Karimov',
  nickname: 'ShadowFox',
  age: 18,
  email: 'shadowfox@gmail.com',
  password: 'Test123!abc',
};

/* ---------- suite ---------- */
test('Anime Arena backend', async (t) => {
  const env = await boot();
  let token = '';
  let player;
  let shadowUserId = '';
  let liveHistoryLength = 0;

  t.after(() => env.close());

  await t.test('health and catalogue are public', async () => {
    const health = await env.api('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.payload.ok, true);
    assert.equal(health.payload.catalog.heroes, 124);

    const catalog = await env.api('GET', '/api/catalog');
    assert.equal(catalog.status, 200);
    assert.equal(catalog.payload.heroes.length, 124);
    assert.equal(catalog.payload.tiers.length, 7);
    assert.equal(catalog.payload.meta.counts.purchasableHeroes, 122);

    const hero = await env.api('GET', '/api/catalog/heroes/gojo');
    assert.equal(hero.status, 200);
    assert.equal(hero.payload.id, 'gojo');
    assert.ok(hero.payload.skills.length >= 4);

    const missing = await env.api('GET', '/api/catalog/heroes/nope');
    assert.equal(missing.status, 404);
  });

  await t.test('registration validates input', async () => {
    const bad = await env.api('POST', '/api/auth/register', {
      body: { ...ACCOUNT, email: 'not-an-email', password: 'weak' },
    });
    assert.equal(bad.status, 422);
    assert.equal(bad.payload.error.code, 'VALIDATION_FAILED');
    assert.ok(bad.payload.error.details.email);
    assert.ok(bad.payload.error.details.password);
  });

  await t.test('registration creates a player with the starting kit', async () => {
    const result = await env.api('POST', '/api/auth/register', { body: ACCOUNT });
    assert.equal(result.status, 201);
    assert.ok(result.payload.token);
    token = result.payload.token;
    player = result.payload.player;
    shadowUserId = player.user.id;

    assert.equal(player.user.nickname, 'ShadowFox');
    assert.equal(player.wallet.coins, 15000);
    assert.equal(player.wallet.diamonds, 0);
    assert.equal(player.wallet.tokens, 8);
    assert.equal(player.progress.level, 0);
    assert.deepEqual(player.heroes.owned.sort(), ['t1', 't2']);
    assert.ok(player.maps.owned.includes('std'));
    assert.equal(player.settings.theme, 'system');
  });

  await t.test('nickname and email uniqueness are enforced', async () => {
    const dupe = await env.api('POST', '/api/auth/register', {
      body: { ...ACCOUNT, email: 'another@gmail.com' },
    });
    assert.equal(dupe.status, 409);
    assert.equal(dupe.payload.error.code, 'NICKNAME_TAKEN');

    const dupeEmail = await env.api('POST', '/api/auth/register', {
      body: { ...ACCOUNT, nickname: 'Different' },
    });
    assert.equal(dupeEmail.status, 409);
    assert.equal(dupeEmail.payload.error.code, 'EMAIL_TAKEN');
  });

  await t.test('login rejects wrong password and accepts the right one', async () => {
    const bad = await env.api('POST', '/api/auth/login', {
      body: { login: 'ShadowFox', password: 'Wrong123!x' },
    });
    assert.equal(bad.status, 401);

    const ok = await env.api('POST', '/api/auth/login', {
      body: { login: 'shadowfox@gmail.com', password: ACCOUNT.password },
    });
    assert.equal(ok.status, 200);
    assert.ok(ok.payload.token);
    token = ok.payload.token;
  });

  await t.test('protected routes require a session', async () => {
    const anonymous = await env.api('GET', '/api/player');
    assert.equal(anonymous.status, 401);

    const me = await env.api('GET', '/api/auth/me', { token });
    assert.equal(me.status, 200);
    assert.equal(me.payload.player.user.nickname, 'ShadowFox');
  });

  await t.test('shop lists heroes with ownership flags', async () => {
    const shop = await env.api('GET', '/api/shop/heroes', { token });
    assert.equal(shop.status, 200);
    assert.ok(shop.payload.heroes.length >= 50);

    const subaru = shop.payload.heroes.find((hero) => hero.id === 'subaru');
    assert.equal(subaru.owned, false);
    assert.equal(subaru.prices.coins, 1500);
    assert.equal(subaru.tier, 'E');
  });

  await t.test('buying a hero deducts coins server-side', async () => {
    const bought = await env.api('POST', '/api/shop/heroes/buy', {
      token,
      body: { heroId: 'subaru', currency: 'coin' },
    });
    assert.equal(bought.status, 200);
    assert.equal(bought.payload.wallet.coins, 13500);
    assert.equal(bought.payload.paid.amount, 1500);

    const again = await env.api('POST', '/api/shop/heroes/buy', {
      token,
      body: { heroId: 'subaru', currency: 'coin' },
    });
    assert.equal(again.status, 409);
    assert.equal(again.payload.error.code, 'HERO_ALREADY_OWNED');
  });

  await t.test('tier rules and balances are enforced', async () => {
    const diamondOnly = await env.api('POST', '/api/shop/heroes/buy', {
      token,
      body: { heroId: 'saitama', currency: 'coin' },
    });
    assert.equal(diamondOnly.status, 422);
    assert.equal(diamondOnly.payload.error.code, 'DIAMOND_ONLY');

    const insufficient = await env.api('POST', '/api/shop/heroes/buy', {
      token,
      body: { heroId: 'zeno', currency: 'diamond' },
    });
    assert.equal(insufficient.status, 422);
    assert.equal(insufficient.payload.error.code, 'INSUFFICIENT_FUNDS');
    assert.equal(insufficient.payload.error.details.required, 500);

    const negative = await env.api('POST', '/api/shop/heroes/buy', {
      token,
      body: { heroId: 'levi', currency: 'gold' },
    });
    assert.equal(negative.status, 422);
    assert.equal(negative.payload.error.code, 'INVALID_CURRENCY');
  });

  await t.test('player settings and favourite hero update', async () => {
    const patched = await env.api('PATCH', '/api/player', {
      token,
      body: { favoriteHeroId: 'subaru', settings: { theme: 'dark', quality: 'low', bogus: 1 } },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.payload.player.heroes.favorite, 'subaru');
    assert.equal(patched.payload.player.settings.theme, 'dark');
    assert.equal(patched.payload.player.settings.quality, 'low');
    assert.equal(patched.payload.player.settings.bogus, undefined);

    const notOwned = await env.api('PATCH', '/api/player', {
      token,
      body: { favoriteHeroId: 'zeno' },
    });
    assert.equal(notOwned.status, 422);
  });

  await t.test('maps respect rank locks and balances', async () => {
    const bought = await env.api('POST', '/api/shop/maps/buy', {
      token,
      body: { mapId: 'fire' },
    });
    assert.equal(bought.status, 200);
    assert.equal(bought.payload.wallet.coins, 11500);
    assert.equal(bought.payload.map.id, 'fire');

    const locked = await env.api('POST', '/api/shop/maps/buy', {
      token,
      body: { mapId: 'rank-1' },
    });
    assert.equal(locked.status, 403);

    const selected = await env.api('POST', '/api/shop/maps/select', {
      token,
      body: { mapId: 'std' },
    });
    assert.equal(selected.status, 200);
    assert.equal(selected.payload.selected, 'std');
  });

  await t.test('level battles award coins once and enforce progression', async () => {
    const win = await env.api('POST', '/api/progress/levels/complete', {
      token,
      body: { level: 1, won: true },
    });
    assert.equal(win.status, 200);
    assert.equal(win.payload.reward, 50); // (20 + 5) * 2
    assert.equal(win.payload.progress.level, 1);
    assert.equal(win.payload.wallet.coins, 11550);

    const skip = await env.api('POST', '/api/progress/levels/complete', {
      token,
      body: { level: 3, won: true },
    });
    assert.equal(skip.status, 409);
    assert.equal(skip.payload.error.code, 'LEVEL_LOCKED');

    const next = await env.api('POST', '/api/progress/levels/complete', {
      token,
      body: { level: 2, won: true },
    });
    assert.equal(next.status, 200);
    assert.equal(next.payload.reward, 60); // (20 + 10) * 2
  });

  await t.test('tournament start and settlement are server-authoritative', async () => {
    const started = await env.api('POST', '/api/progress/tournaments/start', {
      token,
      body: { heroId: 'subaru', paidSelection: false },
    });
    assert.equal(started.status, 201);
    assert.ok(started.payload.runId.startsWith('cup-'));

    const duplicateStart = await env.api('POST', '/api/progress/tournaments/start', {
      token,
      body: { heroId: 'subaru', paidSelection: false },
    });
    assert.equal(duplicateStart.status, 409);
    assert.equal(duplicateStart.payload.error.code, 'TOURNAMENT_IN_PROGRESS');

    const settled = await env.api('POST', '/api/progress/tournaments/complete', {
      token,
      body: {
        runId: started.payload.runId,
        champion: true,
        forfeit: false,
        placement: '1',
        wins: Array.from({ length: 5 }, () => ({ opponentTier: 'A', won: true })),
      },
    });
    assert.equal(settled.status, 200);
    assert.equal(settled.payload.champion, true);
    assert.equal(settled.payload.rewards.coins, 30000);
    assert.equal(settled.payload.rewards.diamonds, 10);
    assert.equal(settled.payload.rewards.total, 10);
    assert.equal(settled.payload.progress.accountLevel, 1);

    const again = await env.api('POST', '/api/progress/tournaments/complete', {
      token,
      body: { runId: started.payload.runId, champion: true, forfeit: false, wins: [] },
    });
    assert.equal(again.status, 404);
  });

  await t.test('diamond purchases work after tournament rewards', async () => {
    const me = await env.api('GET', '/api/player', { token });
    assert.equal(me.payload.wallet.diamonds, 10);

    const levi = await env.api('POST', '/api/shop/heroes/buy', {
      token,
      body: { heroId: 'levi', currency: 'diamond' },
    });
    assert.equal(levi.status, 200);
    assert.equal(levi.payload.wallet.diamonds, 2);
  });

  await t.test('history endpoints expose ledger and tournaments', async () => {
    const transactions = await env.api('GET', '/api/player/transactions?limit=50', { token });
    assert.equal(transactions.status, 200);
    const types = transactions.payload.transactions.map((entry) => entry.type);
    assert.ok(types.includes('hero_purchase'));
    assert.ok(types.includes('level_reward'));
    assert.ok(types.includes('tournament_reward'));
    assert.ok(types.includes('total_award'));

    const tournaments = await env.api('GET', '/api/player/tournaments', { token });
    assert.equal(tournaments.payload.tournaments.length, 1);
    assert.equal(tournaments.payload.tournaments[0].champion, true);
  });

  await t.test('token regeneration endpoint responds', async () => {
    const refreshed = await env.api('POST', '/api/player/tokens/refresh', { token });
    assert.equal(refreshed.status, 200);
    assert.ok(Number.isInteger(refreshed.payload.tokens));
  });

  await t.test('leaderboard ranks players', async () => {
    const board = await env.api('GET', '/api/leaderboard?sort=total&limit=10');
    assert.equal(board.status, 200);
    assert.equal(board.payload.leaders[0].nickname, 'ShadowFox');
    assert.equal(board.payload.leaders[0].total, 10);
  });

  await t.test('full game state saves and restores', async () => {
    const state = {
      own: ['t1', 't2', 'subaru'],
      tok: 3,
      tokT: Date.now(),
      lv: 5,
      coin: 4321,
      diamonds: 6,
      b10: 1,
      maps: ['std', 'fire'],
      map: 'std',
      fav: 'subaru',
      w: 3,
      l: 1,
      hs: { subaru: { w: 3, l: 1 } },
      sel: { st: 'a', pt: 'p' },
      total: 12,
      diamondHistory: [{ delta: 6, label: 'Test', ref: 'x', at: Date.now() }],
      diamondClaims: {},
      tournamentHistory: [],
      pinnedTournaments: [],
      tours: {},
      totalClaims: {},
      totalHistory: [],
      unknownField: 'dropped',
    };

    const saved = await env.api('PUT', '/api/player/state', { token, body: { state } });
    assert.equal(saved.status, 200);
    assert.equal(saved.payload.version, 1);

    const loaded = await env.api('GET', '/api/player/state', { token });
    assert.equal(loaded.status, 200);
    assert.equal(loaded.payload.state.coin, 4321);
    assert.equal(loaded.payload.state.diamonds, 6);
    assert.equal(loaded.payload.state.lv, 5);
    assert.deepEqual(loaded.payload.state.own.sort(), ['subaru', 't1', 't2']);
    assert.equal(loaded.payload.state.unknownField, undefined);

    const snapshot = await env.api('GET', '/api/player', { token });
    assert.equal(snapshot.payload.wallet.coins, 4321);
    assert.equal(snapshot.payload.wallet.diamonds, 6);
    assert.equal(snapshot.payload.wallet.tokens, 3);
    assert.equal(snapshot.payload.progress.level, 5);
    assert.equal(snapshot.payload.progress.total, 12);
    assert.ok(snapshot.payload.heroes.owned.includes('subaru'));
  });

  await t.test('admin account can search players and grant diamonds', async () => {
    const adminAccount = {
      firstName: 'Laziz',
      lastName: 'Xasanov',
      nickname: 'AdminBoss',
      age: 25,
      email: defaultConfig.admin.email,
      password: defaultConfig.admin.password,
    };

    const registered = await env.api('POST', '/api/auth/register', { body: adminAccount });
    assert.equal(registered.status, 201);
    assert.equal(registered.payload.user.role, 'admin');
    const adminToken = registered.payload.token;

    const login = await env.api('POST', '/api/auth/login', {
      body: { login: adminAccount.email, password: adminAccount.password },
    });
    assert.equal(login.status, 200);
    assert.equal(login.payload.user.role, 'admin');

    const forbidden = await env.api('GET', '/api/admin/users', { token });
    assert.equal(forbidden.status, 403);

    const search = await env.api('GET', '/api/admin/users?q=ShadowFox', { token: adminToken });
    assert.equal(search.status, 200);
    assert.equal(search.payload.users.length, 1);
    assert.equal(search.payload.users[0].id, shadowUserId);

    const granted = await env.api('POST', '/api/admin/diamonds', {
      token: adminToken,
      body: { userId: shadowUserId, amount: 25, note: 'test transfer' },
    });
    assert.equal(granted.status, 200);
    assert.equal(granted.payload.wallet.diamonds, 31);

    const state = await env.api('GET', '/api/player/state', { token });
    assert.equal(state.payload.state.diamonds, 31);

    const audit = await env.api('GET', '/api/admin/audit', { token: adminToken });
    assert.equal(audit.status, 200);
    assert.equal(audit.payload.audit[0].amount, 25);
    assert.equal(audit.payload.audit[0].target, 'ShadowFox');

    // The reserved admin Gmail cannot be squatted with another password.
    const squatted = await env.api('POST', '/api/auth/register', {
      body: { ...adminAccount, nickname: 'OtherBoss', password: 'Wrong123!abc' },
    });
    assert.equal(squatted.status, 409);
    assert.equal(squatted.payload.error.code, 'ADMIN_EMAIL_RESERVED');
  });

  await t.test('live people tournament runs on the server', async () => {
    const registerLive = async (nickname, email) => {
      const result = await env.api('POST', '/api/auth/register', {
        body: { ...ACCOUNT, nickname, email },
      });
      assert.equal(result.status, 201);
      return result.payload.token;
    };

    const tokenA = await registerLive('LiveA', 'live.a@gmail.com');
    const tokenB = await registerLive('LiveB', 'live.b@gmail.com');

    const before = await env.api('GET', '/api/live/history', { token: tokenA });
    const baseline = before.payload.history.length;

    const joinedA = await env.api('POST', '/api/live/enter', {
      token: tokenA,
      body: { heroId: 'subaru' },
    });
    assert.equal(joinedA.status, 200);
    assert.equal(joinedA.payload.tournament.myEntry.heroId, 'subaru');

    const joinedB = await env.api('POST', '/api/live/enter', {
      token: tokenB,
      body: { heroId: 'guts' },
    });
    assert.equal(joinedB.status, 200);

    const deadline = Date.now() + 8000;
    let result = null;
    while (Date.now() < deadline) {
      const history = await env.api('GET', '/api/live/history', { token: tokenA });
      if (history.payload.history.length > baseline) {
        result = history.payload.history[0];
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    assert.ok(result, 'live tournament should finish');
    assert.equal(result.entrants, 2);
    assert.ok(['LiveA', 'LiveB'].includes(result.champion.name));

    const winnerToken = result.champion.name === 'LiveA' ? tokenA : tokenB;
    const loserToken = result.champion.name === 'LiveA' ? tokenB : tokenA;

    const winner = await env.api('GET', '/api/player', { token: winnerToken });
    assert.equal(winner.payload.wallet.coins, 45000);
    assert.equal(winner.payload.wallet.diamonds, 10);

    const loser = await env.api('GET', '/api/player', { token: loserToken });
    assert.equal(loser.payload.wallet.coins, 15000);
    assert.equal(loser.payload.wallet.diamonds, 0);

    const loserHistory = await env.api('GET', '/api/live/history', { token: loserToken });
    assert.equal(loserHistory.payload.history[0].mine.place, 2);
  });

  await t.test('game page and API console are served', async () => {
    const game = await fetch(env.base + '/');
    assert.equal(game.status, 200);
    assert.match(game.headers.get('content-type'), /text\/html/);
    const gameCsp = game.headers.get('content-security-policy');
    assert.match(gameCsp, /default-src 'self'/);
    assert.match(gameCsp, /unsafe-inline/);
    const gameHtml = await game.text();
    assert.match(gameHtml, /Anime Arena/);
    assert.match(gameHtml, /game-integration\.js/);

    const consolePage = await fetch(env.base + '/console.html');
    assert.equal(consolePage.status, 200);
    assert.match(consolePage.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await consolePage.text(), /API console/);

    const manifest = await fetch(env.base + '/manifest.webmanifest');
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type'), /manifest\+json/);
  });

  await t.test('unknown API routes return a structured 404', async () => {
    const missing = await env.api('GET', '/api/does-not-exist');
    assert.equal(missing.status, 404);
    assert.equal(missing.payload.error.code, 'NOT_FOUND');
  });

  await t.test('logout invalidates the bearer token', async () => {
    const out = await env.api('POST', '/api/auth/logout', { token });
    assert.equal(out.status, 200);

    const after = await env.api('GET', '/api/player', { token });
    assert.equal(after.status, 401);
  });
});
