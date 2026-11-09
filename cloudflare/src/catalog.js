'use strict';

const TIER_ORDER = ['E', 'D', 'C', 'B', 'A', 'S', 'Z'];

class Catalog {
  constructor(raw) {
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

  tierRank(tier) {
    return this.tierIndex.get(tier) ?? 0;
  }

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

  heroDetail(hero) {
    if (!hero) return null;
    return {
      ...this.heroSummary(hero),
      traits: hero.traits,
      weaponSpec: hero.weaponSpec,
      skills: hero.skills,
    };
  }

  summaryList() {
    return this.heroes.map((hero) => this.heroSummary(hero));
  }
}

let cachedCatalog = null;

export async function loadCatalog(env, request) {
  if (cachedCatalog) return cachedCatalog;
  const base = request?.url || 'https://anime-arena-top.local/';
  const assetRequest = new Request(new URL('/catalog.json', base).toString());
  const response = await env.ASSETS.fetch(assetRequest);
  if (!response.ok) throw new Error('catalog.json asset not found');
  const raw = await response.json();
  cachedCatalog = new Catalog(raw);
  return cachedCatalog;
}

export { Catalog, TIER_ORDER };
