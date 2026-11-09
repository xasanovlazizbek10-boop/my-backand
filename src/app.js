'use strict';

const fs = require('node:fs');
const path = require('node:path');

const defaultConfig = require('./config');
const { openDatabase } = require('./db');
const { loadCatalog } = require('./catalog');
const { RateLimiter } = require('./util/rate-limit');
const {
  HttpError,
  errors,
  sendJson,
  sendNoContent,
  readJson,
  clientIp,
  applySecurityHeaders,
} = require('./util/http');
const { authenticate } = require('./services/session');
const { tickLive } = require('./services/live');

const authApi = require('./api/auth');
const playerApi = require('./api/player');
const catalogApi = require('./api/catalog');
const shopApi = require('./api/shop');
const progressApi = require('./api/progress');
const leaderboardApi = require('./api/leaderboard');
const stateApi = require('./api/state');
const liveApi = require('./api/live');
const adminApi = require('./api/admin');

// The game is a single self-contained file with inline styles/handlers and
// Google Fonts, so it needs a slightly wider CSP than the API console.
const GAME_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https:; " +
  "connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const CONSOLE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/* ---------- route table ---------- */
const ROUTES = [
  { method: 'GET', path: '/api/health', handler: health, public: true },
  { method: 'GET', path: '/api/config', handler: publicConfig, public: true },

  { method: 'POST', path: '/api/auth/register', handler: authApi.register, public: true, authLimit: true },
  { method: 'POST', path: '/api/auth/login', handler: authApi.login, public: true, authLimit: true },
  { method: 'POST', path: '/api/auth/logout', handler: authApi.logout, public: true },
  { method: 'GET', path: '/api/auth/me', handler: authApi.me },

  { method: 'GET', path: '/api/player', handler: playerApi.getPlayer },
  { method: 'PATCH', path: '/api/player', handler: playerApi.patchPlayer },
  { method: 'POST', path: '/api/player/tokens/refresh', handler: playerApi.refresh },
  { method: 'GET', path: '/api/player/transactions', handler: playerApi.transactions },
  { method: 'GET', path: '/api/player/tournaments', handler: playerApi.tournaments },
  { method: 'GET', path: '/api/player/state', handler: stateApi.getState },
  { method: 'PUT', path: '/api/player/state', handler: stateApi.putState },

  { method: 'GET', path: '/api/live/state', handler: liveApi.state },
  { method: 'GET', path: '/api/live/history', handler: liveApi.history },
  { method: 'POST', path: '/api/live/enter', handler: liveApi.enter },
  { method: 'POST', path: '/api/live/leave', handler: liveApi.leave },

  { method: 'GET', path: '/api/admin/users', handler: adminApi.listUsers },
  { method: 'GET', path: '/api/admin/audit', handler: adminApi.audit },
  { method: 'POST', path: '/api/admin/diamonds', handler: adminApi.transferDiamonds },

  { method: 'GET', path: '/api/catalog', handler: catalogApi.overview, public: true },
  { method: 'GET', path: '/api/catalog/heroes', handler: catalogApi.heroes, public: true },
  { method: 'GET', path: '/api/catalog/heroes/:id', handler: catalogApi.hero, public: true },
  { method: 'GET', path: '/api/catalog/tiers', handler: catalogApi.tiers, public: true },
  { method: 'GET', path: '/api/catalog/ranks', handler: catalogApi.ranks, public: true },
  { method: 'GET', path: '/api/catalog/maps', handler: catalogApi.maps, public: true },
  { method: 'GET', path: '/api/catalog/monsters', handler: catalogApi.monsters, public: true },

  { method: 'GET', path: '/api/shop/heroes', handler: shopApi.listHeroes },
  { method: 'POST', path: '/api/shop/heroes/buy', handler: shopApi.purchaseHero },
  { method: 'POST', path: '/api/shop/maps/buy', handler: shopApi.purchaseMap },
  { method: 'POST', path: '/api/shop/maps/select', handler: shopApi.select },

  { method: 'POST', path: '/api/progress/levels/complete', handler: progressApi.levelComplete },
  { method: 'POST', path: '/api/progress/tournaments/start', handler: progressApi.tournamentStart },
  { method: 'POST', path: '/api/progress/tournaments/complete', handler: progressApi.tournamentComplete },

  { method: 'GET', path: '/api/leaderboard', handler: leaderboardApi.leaderboard, public: true },
];

const COMPILED = ROUTES.map((route) => {
  const keys = [];
  const pattern = route.path
    .split('/')
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith(':')) {
        keys.push(part.slice(1));
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { ...route, regex: new RegExp(`^/${pattern}/?$`), keys };
});

/* ---------- built-in handlers ---------- */
function health(ctx) {
  const { db, catalog, res } = ctx;
  const users = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  sendJson(res, 200, {
    ok: true,
    service: 'anime-arena-server',
    version: '1.1.0',
    uptimeSec: Math.round(process.uptime()),
    clock: Date.now(),
    catalog: catalog.meta.counts,
    registeredPlayers: users,
  });
}

function publicConfig(ctx) {
  const { config, catalog, res } = ctx;
  sendJson(res, 200, {
    economy: config.economy,
    catalog: {
      heroes: catalog.meta.counts.heroes,
      purchasableHeroes: catalog.meta.counts.purchasableHeroes,
      tiers: catalog.tiers,
    },
    sessionTtlMs: config.sessionTtlMs,
  });
}

/* ---------- static files ---------- */
function serveStatic(req, res, config, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  let relative;
  try {
    relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  const filePath = path.normalize(path.join(config.publicDir, relative));
  const inside = filePath === config.publicDir || filePath.startsWith(config.publicDir + path.sep);
  if (!inside || relative.split(/[\\/]/).some((part) => part.startsWith('.'))) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    };
    if (ext === '.html') {
      const isGame = filePath === path.join(config.publicDir, 'index.html');
      headers['Content-Security-Policy'] = isGame ? GAME_CSP : CONSOLE_CSP;
    }

    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
      return;
    }

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------- app factory ---------- */
function createApp(options = {}) {
  const config = { ...defaultConfig, ...options };
  const db = openDatabase(config.dbPath);
  const catalog = loadCatalog(config.catalogPath);
  const limiter = new RateLimiter({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
  });
  const log = config.silent ? () => {} : config.logger || ((line) => console.log(line));

  // Server-side clock for live people-tournaments. One process is assumed;
  // with several processes this would need a leader election / Redis lock.
  const liveTimer = setInterval(() => {
    try {
      tickLive(db, catalog, config);
    } catch (error) {
      log(`LIVE ERROR: ${error?.stack || error}`);
    }
  }, Math.max(250, config.live.tickerMs));
  liveTimer.unref?.();

  async function handler(req, res) {
    const started = process.hrtime.bigint();
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    applySecurityHeaders(res);

    // CORS
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
      sendNoContent(res);
      return;
    }

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      log(`${req.method} ${pathname} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });

    try {
      if (!pathname.startsWith('/api')) {
        if (pathname === '/console' || pathname === '/console/') {
          res.writeHead(302, { Location: '/console.html' });
          res.end();
          return;
        }
        serveStatic(req, res, config, pathname);
        return;
      }

      const route = COMPILED.find(
        (candidate) => candidate.method === req.method && candidate.regex.test(pathname)
      );
      if (!route) {
        throw errors.notFound(`Endpoint topilmadi: ${req.method} ${pathname}`);
      }

      const ip = clientIp(req, config.trustProxy);
      const bucket = route.authLimit ? 'auth' : 'api';
      const limit = route.authLimit ? config.rateLimit.authMax : config.rateLimit.max;
      const verdict = limiter.hit(`${bucket}:${ip}`, limit);
      if (!verdict.allowed) throw errors.tooManyRequests(verdict.retryAfterMs);

      const match = pathname.match(route.regex);
      const params = {};
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(match[index + 1]);
      });

      let user = null;
      if (!route.public) {
        const auth = authenticate(db, req);
        if (!auth) throw errors.unauthorized();
        user = auth.user;
      }

      const needsBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE';
      const bodyLimit = pathname === '/api/player/state' ? config.stateLimit : config.bodyLimit;
      const body = needsBody ? await readJson(req, bodyLimit) : {};

      await route.handler({
        req,
        res,
        db,
        config,
        catalog,
        body,
        params,
        query: url.searchParams,
        user,
        ip,
      });
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }

      const status = Number(error?.status) || 500;
      const code = error?.code || (status === 500 ? 'INTERNAL' : 'ERROR');
      if (status >= 500) {
        log(`ERROR ${req.method} ${pathname}: ${error?.stack || error}`);
      }

      sendJson(res, status, {
        error: {
          code,
          message:
            status >= 500 && config.env === 'production'
              ? 'Ichki xatolik.'
              : error?.message || 'Ichki xatolik.',
          ...(error?.details ? { details: error.details } : {}),
        },
      });
    }
  }

  return {
    handler,
    db,
    catalog,
    config,
    close() {
      limiter.stop();
      clearInterval(liveTimer);
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}

module.exports = { createApp, ROUTES, HttpError };
