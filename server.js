'use strict';

const http = require('node:http');
const config = require('./src/config');
const { createApp } = require('./src/app');

const app = createApp(config);

const server = http.createServer((req, res) => {
  app.handler(req, res);
});

server.keepAliveTimeout = 65_000;

server.listen(config.port, config.host, () => {
  const mode = config.env === 'production' ? 'production' : 'development';
  console.log('');
  console.log('  ANIME ARENA · backend');
  console.log('  ─────────────────────────────────────────');
  console.log(`  Mode      ${mode}`);
  console.log(`  Game      http://${config.host}:${config.port}/`);
  console.log(`  API       http://${config.host}:${config.port}/api`);
  console.log(`  Console   http://${config.host}:${config.port}/console.html`);
  console.log(`  Database  ${config.dbPath}`);
  console.log(`  Catalog   ${app.catalog.meta.counts.heroes} heroes · ${app.catalog.meta.counts.maps} maps`);
  console.log(`  Admin     ${config.admin.email}`);
  console.log(`  Live cup  every ${Math.round(config.live.cycleMs / 60000)} min · ${config.live.size} seats`);
  console.log('');
});

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down…`);
  server.close(() => {
    app.close();
    process.exit(0);
  });
  // Do not hang forever on keep-alive sockets.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
