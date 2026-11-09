'use strict';

const fs = require('node:fs');

const TIER_ORDER = ['E', 'D', 'C', 'B', 'A', 'S', 'Z'];

class Catalog {
  constructor(filePath) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    this.meta = raw.meta;
    this.tiers = raw.tiers;
    this.tierRoster = raw.tierRoster;
    this.ranks = raw.ranks;
    this.maps = raw.maps;
    this.monsters = raw.monsters;
    this.heroes = raw.heroes;
    this.heroesById = raw.heroesById;
    this.limited = raw.limited || {};

    this.tierById = new Map(this.tiers.map((tier) => [tier.id, tier]));
    this.mapById = new Map(this.maps.map((map) => [map.id, map]));
    this.tierIndex = new Map(TIER_ORDER.map((tier, index) => [tier, index]));
  }

  getHero(id) {
    return this.heroesById[id] || null;
  }

  getMap(id) {
    return this.mapById.get(id) || null;
  }

  getTier(id) {
    return this.tierById.get(id) || null;
  }

  tierRank(tier) {
    return this.tierIndex.get(tier) ?? 0;
  }

  /** Public hero shape: no raw skill timelines (keeps list payloads small). */
  heroSummary(hero) {
    if (!hero) return null;
    return {
      id: hero.id,
      name: hero.name,
      tier: hero.tier,
      tierName: hero.tierName,
      tierColor: hero.tierColor,
      weapon: hero.weapon,
      hue: hero.hue,
      test: hero.test,
      purchasable: hero.purchasable,
      diamondOnly: hero.diamondOnly,
      prices: hero.prices,
      stats: hero.stats,
      skillCount: hero.skills.length,
      skills: hero.skills.map(({ name, kind, cooldown, mana, passive, icon }) => ({
        name,
        kind,
        cooldown,
        mana,
        passive,
        icon,
      })),
    };
  }

  /** Full hero shape including skill mechanics, for the detail endpoint. */
  heroDetail(hero) {
    if (!hero) return null;
    return { ...this.heroSummary(hero), traits: hero.traits, weaponSpec: hero.weaponSpec, skills: hero.skills };
  }

  summaryList() {
    return this.heroes.map((hero) => this.heroSummary(hero));
  }

  publicTiers() {
    return this.tiers;
  }

  publicRanks() {
    return this.ranks;
  }

  publicMaps() {
    return this.maps;
  }

  publicMonsters() {
    return this.monsters;
  }
}

let instance = null;

function loadCatalog(filePath) {
  if (!instance) instance = new Catalog(filePath);
  return instance;
}

module.exports = { Catalog, loadCatalog, TIER_ORDER };
