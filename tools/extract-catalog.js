#!/usr/bin/env node
'use strict';

/**
 * Extracts the game catalogue (heroes, tiers, ranks, maps, monsters) from the
 * original single-file anime-arena.html into standalone JSON files.
 *
 * The source file is only read; the data-definition blocks are evaluated inside
 * a bare vm context (no require, no process, no network) so the extraction is
 * deterministic and side-effect free.
 *
 * Usage:
 *   node tools/extract-catalog.js [path-to-anime-arena2.html]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const DEFAULT_SOURCE = path.join(os.homedir(), 'OneDrive', 'Desktop', 'anime-arena2.html');
const sourcePath = path.resolve(process.argv[2] || process.env.ANIME_ARENA_SOURCE || DEFAULT_SOURCE);
const outDir = path.join(__dirname, '..', 'data');

if (!fs.existsSync(sourcePath)) {
  console.error(`Source file not found: ${sourcePath}`);
  process.exit(1);
}

const raw = fs.readFileSync(sourcePath, 'utf8');
const lines = raw.split(/\r?\n/);
const slice = (from, to) => lines.slice(from - 1, to).join('\n');

/* Line ranges in anime-arena2.html (verified against the 4472-line source):
 *   602–800   EVR, JW, LIMBO, H, helpers, FAST_CD / Madara-Aizen patches
 *   801–1082  skill helpers + EXPANSION_HEROES + PSK/PH + PREMIUM_HEROES + patches
 *  1083–1654  LANDMARK_HEROES (legend() roster, own tiers/stats)
 *  1682–1717  mkU, HERO_TIERS, HERO_TIER_ROSTER, tier assignment, ACCOUNT_RANKS
 *  1799       RANK_MAPS (built from ACCOUNT_RANKS)
 *  2107–2112  base MAPS (+ rank maps)
 *  2126–2141  WN + monster table (CT)
 */
const code = `
${slice(602, 800)}
${slice(801, 1082)}
${slice(1083, 1654)}
${slice(1682, 1717)}
${slice(1799, 1799)}
${slice(2107, 2112)}
${slice(2126, 2141)}
globalThis.__EXTRACT__ = {
  H, EXPANSION_HEROES, PREMIUM_HEROES, LANDMARK_HEROES, HERO_TIERS, HERO_TIER_ROSTER,
  ACCOUNT_RANKS, MAPS, CT, WN, LIMBO, JW
};
`;

const context = vm.createContext({ console });
let extracted;
try {
  vm.runInContext(code, context, { timeout: 5000, filename: 'anime-arena:data' });
  extracted = context.__EXTRACT__;
} catch (error) {
  console.error('Failed to evaluate the catalogue blocks:', error.message);
  process.exit(1);
}

const {
  H, EXPANSION_HEROES, PREMIUM_HEROES, LANDMARK_HEROES, HERO_TIERS, HERO_TIER_ROSTER,
  ACCOUNT_RANKS, MAPS, CT, WN, LIMBO, JW,
} = extracted;

/* ---------- constants mirrored from the game ---------- */
const DIAMOND_PRICES = { E: 1, D: 4, C: 8, B: 16, A: 25, S: 99, Z: 500 };
const TIER_BY_ID = new Map(HERO_TIERS.map((t) => [t.id, t]));

/* ---------- normalisation ---------- */
const byId = new Map();
for (const hero of [...H, ...EXPANSION_HEROES, ...PREMIUM_HEROES, ...LANDMARK_HEROES]) {
  if (hero && hero.id) byId.set(hero.id, hero);
}

const heroList = [...byId.values()].map((h) => {
  const tier = TIER_BY_ID.has(h.tier) ? h.tier : 'E';
  const tierDef = TIER_BY_ID.get(tier);
  const isTest = Boolean(h.test);
  const diamondOnly = tier === 'S' || tier === 'Z';

  return {
    id: h.id,
    name: h.n,
    tier,
    tierName: tierDef ? tierDef.n : 'Boshlang‘ich',
    tierColor: tierDef ? tierDef.c : '#8999ab',
    weapon: h.w || null,
    weaponSpec: h.wp || null,
    hue: h.hue ?? 220,
    test: isTest,
    purchasable: !isTest,
    diamondOnly,
    prices: {
      coins: isTest ? 0 : h.price ?? 0,
      diamonds: DIAMOND_PRICES[tier] ?? DIAMOND_PRICES.E,
    },
    stats: {
      pow: h.s?.pow ?? 0,
      atk: h.s?.atk ?? 0,
      hp: h.s?.hp ?? 0,
      spd: h.s?.spd ?? 0,
      def: h.s?.def ?? 0,
      reg: h.s?.reg ?? 0,
      mana: h.s?.mana ?? 0,
      per: h.s?.per ?? 0,
    },
    traits: h.traits || null,
    skills: (h.sks || []).map((s) => ({
      name: s.n,
      kind: s.k,
      cooldown: s.cd ?? 0,
      mana: s.mana ?? 0,
      passive: Boolean(s.pas),
      icon: s.ik || null,
      description: s.desc || null,
      raw: s,
    })),
  };
});

const tierOrder = HERO_TIERS.map((t) => t.id);
heroList.sort((a, b) => {
  const tierDelta = tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier);
  return tierDelta || a.name.localeCompare(b.name);
});

const heroesById = Object.fromEntries(heroList.map((h) => [h.id, h]));

const tierRoster = Object.fromEntries(
  tierOrder.map((tier) => [
    tier,
    heroList.filter((h) => h.tier === tier).map((h) => h.id),
  ])
);

const tiers = HERO_TIERS.map((t) => ({
  id: t.id,
  name: t.n,
  color: t.c,
  diamondPrice: DIAMOND_PRICES[t.id] ?? null,
  heroCount: tierRoster[t.id]?.length || 0,
}));

const ranks = ACCOUNT_RANKS.map((r) => ({
  level: r.level,
  totalRequired: r.at,
  name: r.n,
  color: r.c,
  mapName: r.map,
  palette: r.palette,
  totalMultiplier: Number((1 + Math.max(0, Math.min(6, r.level - 1)) * 0.025).toFixed(3)),
}));

const maps = MAPS.map((m) => ({
  id: m.id,
  name: m.n,
  description: m.d,
  price: m.price || 0,
  rankRequired: m.rankRequired || 0,
  rankReward: m.rankRequired > 0,
  preview: m.pv || null,
}));

const monsters = CT.map((c) => ({
  name: c[0],
  hue: c[1],
  stats: {
    hp: c[2],
    atk: c[3],
    def: c[4],
    spd: c[5],
    per: c[6],
    reg: c[7],
  },
  weapon: {
    type: WN[c[8]] || null,
    typeIndex: c[8],
    length: c[9],
    arc: c[10],
    swing: c[11],
  },
  abilities: String(c[12]).split(''),
}));

const meta = {
  name: 'Anime Arena catalogue',
  version: 1,
  extractedAt: new Date().toISOString(),
  source: sourcePath,
  sourceBytes: Buffer.byteLength(raw, 'utf8'),
  counts: {
    heroes: heroList.length,
    purchasableHeroes: heroList.filter((h) => h.purchasable).length,
    tiers: tiers.length,
    ranks: ranks.length,
    maps: maps.length,
    monsters: monsters.length,
  },
};

const catalog = {
  meta,
  tiers,
  tierRoster,
  ranks,
  maps,
  monsters,
  heroes: heroList,
  heroesById,
  limited: {
    summons: { limbo: LIMBO, shadows: JW },
  },
};

fs.mkdirSync(outDir, { recursive: true });

const write = (file, data) => {
  const target = path.join(outDir, file);
  fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n', 'utf8');
  const kb = (fs.statSync(target).size / 1024).toFixed(1);
  console.log(`  ${file.padEnd(18)} ${kb} KB`);
};

console.log('Writing catalogue to', outDir);
write('catalog.json', catalog);
write('heroes.json', { meta: { ...meta, kind: 'heroes' }, heroes: heroList });
write('tiers.json', { meta: { ...meta, kind: 'tiers' }, tiers, tierRoster });
write('ranks.json', { meta: { ...meta, kind: 'ranks' }, ranks });
write('maps.json', { meta: { ...meta, kind: 'maps' }, maps });
write('monsters.json', { meta: { ...meta, kind: 'monsters' }, monsters });

console.log(
  `Done: ${heroList.length} heroes ` +
  `(${heroList.filter((h) => h.purchasable).length} purchasable), ` +
  `${tiers.length} tiers, ${ranks.length} ranks, ${maps.length} maps, ${monsters.length} monsters.`
);
