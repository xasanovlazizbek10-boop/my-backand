/* ============================================================
   Anime Arena — browser SDK
   ------------------------------------------------------------
   Drop-in client for the backend. Works from http(s) pages and
   from file:// (Bearer auth is used, cookies are just a fallback).

   Usage:
     ArenaAPI.configure({ baseUrl: 'http://127.0.0.1:8787' });
     await ArenaAPI.login('ShadowFox', 'Test123!abc');
     const state = await ArenaAPI.player();
   ============================================================ */
(function (global) {
  'use strict';

  const TOKEN_KEY = 'aa_api_token';

  const state = {
    baseUrl: 'http://127.0.0.1:8787',
    token: null,
    timeoutMs: 12000,
  };

  function loadToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || null;
    } catch {
      return null;
    }
  }

  function saveToken(token) {
    state.token = token || null;
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private mode */
    }
  }

  class ArenaApiError extends Error {
    constructor(status, code, message, details) {
      super(message);
      this.name = 'ArenaApiError';
      this.status = status;
      this.code = code;
      this.details = details || null;
    }
  }

  async function request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), state.timeoutMs);

    const headers = {};
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetch(state.baseUrl + path, {
        method,
        headers,
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
        credentials: 'include',
        signal: controller.signal,
      });
    } catch (error) {
      throw new ArenaApiError(0, 'NETWORK', 'Serverga ulanib bo‘lmadi.', { cause: String(error) });
    } finally {
      clearTimeout(timer);
    }

    let payload = null;
    const text = await response.text();
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }

    if (!response.ok) {
      const error = payload && payload.error ? payload.error : {};
      if (response.status === 401) saveToken(null);
      throw new ArenaApiError(
        response.status,
        error.code || 'HTTP_' + response.status,
        error.message || 'So‘rov muvaffaqiyatsiz.',
        error.details
      );
    }

    return payload;
  }

  const ArenaAPI = {
    version: '1.0.0',

    configure(options = {}) {
      if (options.baseUrl) state.baseUrl = String(options.baseUrl).replace(/\/+$/, '');
      if (options.timeoutMs) state.timeoutMs = Number(options.timeoutMs) || state.timeoutMs;
      if (options.token) saveToken(options.token);
      return this;
    },

    get token() {
      return state.token;
    },

    isLoggedIn() {
      return Boolean(state.token);
    },

    /* ---------- auth ---------- */
    async register(account) {
      const data = await request('POST', '/api/auth/register', account);
      saveToken(data.token);
      return data;
    },

    async login(login, password) {
      const data = await request('POST', '/api/auth/login', { login, password });
      saveToken(data.token);
      return data;
    },

    async logout() {
      try {
        await request('POST', '/api/auth/logout');
      } finally {
        saveToken(null);
      }
    },

    async me() {
      return request('GET', '/api/auth/me');
    },

    /* ---------- catalog (public) ---------- */
    catalog() {
      return request('GET', '/api/catalog');
    },
    heroes(query = '') {
      return request('GET', '/api/catalog/heroes' + (query ? '?' + query : ''));
    },
    hero(id) {
      return request('GET', '/api/catalog/heroes/' + encodeURIComponent(id));
    },
    maps() {
      return request('GET', '/api/catalog/maps');
    },
    ranks() {
      return request('GET', '/api/catalog/ranks');
    },
    leaderboard(sort = 'total', limit = 25) {
      return request('GET', `/api/leaderboard?sort=${encodeURIComponent(sort)}&limit=${limit}`);
    },

    /* ---------- player ---------- */
    player() {
      return request('GET', '/api/player');
    },
    update(patch) {
      return request('PATCH', '/api/player', patch);
    },
    refreshTokens() {
      return request('POST', '/api/player/tokens/refresh');
    },
    transactions(limit = 30) {
      return request('GET', '/api/player/transactions?limit=' + limit);
    },
    tournaments(limit = 30) {
      return request('GET', '/api/player/tournaments?limit=' + limit);
    },

    /* ---------- shop ---------- */
    shopHeroes() {
      return request('GET', '/api/shop/heroes');
    },
    buyHero(heroId, currency = 'coin') {
      return request('POST', '/api/shop/heroes/buy', { heroId, currency });
    },
    buyMap(mapId) {
      return request('POST', '/api/shop/maps/buy', { mapId });
    },
    selectMap(mapId) {
      return request('POST', '/api/shop/maps/select', { mapId });
    },

    /* ---------- progress ---------- */
    completeLevel(level, won) {
      return request('POST', '/api/progress/levels/complete', { level, won });
    },
    startTournament(heroId, paidSelection = false) {
      return request('POST', '/api/progress/tournaments/start', { heroId, paidSelection });
    },
    completeTournament(runId, result) {
      return request('POST', '/api/progress/tournaments/complete', {
        runId,
        champion: Boolean(result.champion),
        forfeit: Boolean(result.forfeit),
        wins: Array.isArray(result.wins) ? result.wins : [],
        placement: result.placement || null,
      });
    },

    /* ---------- helpers ---------- */
    /**
     * Converts a backend player snapshot into the shape of the game's `D` object,
     * so existing views can keep reading D.coin / D.own / D.diamonds ... .
     */
    toGameState(snapshot) {
      return {
        coin: snapshot.wallet.coins,
        diamonds: snapshot.wallet.diamonds,
        tok: snapshot.wallet.tokens,
        tokT: Date.now() - snapshot.wallet.nextTokenInMs,
        lv: snapshot.progress.level,
        w: snapshot.progress.wins,
        l: snapshot.progress.losses,
        total: snapshot.progress.total,
        own: snapshot.heroes.owned.slice(),
        maps: snapshot.maps.owned.slice(),
        map: snapshot.maps.selected,
        fav: snapshot.heroes.favorite,
        sel: {},
        hs: {},
        _server: {
          accountLevel: snapshot.progress.accountLevel,
          accountRank: snapshot.progress.accountRank,
          settings: snapshot.settings,
        },
      };
    },
  };

  global.ArenaAPI = ArenaAPI;
  global.ArenaApiError = ArenaApiError;

  if (typeof module !== 'undefined' && module.exports) module.exports = ArenaAPI;
})(typeof window !== 'undefined' ? window : globalThis);
