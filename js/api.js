// Thin wrapper around the RAWG.io API.
// Docs: https://api.rawg.io/docs/
const RAWG = (() => {
  const BASE = "https://api.rawg.io/api";
  const KEY_STORAGE = "gg_rawg_key";

  // Cache full game details in localStorage so reranking and repeat builds
  // don't re-hit RAWG. Keyed by app id; entries expire after a week.
  const DETAIL_CACHE_KEY = "gg_details_v1";
  const DETAIL_TTL = 7 * 24 * 60 * 60 * 1000;
  let detailMem = null;
  function detailCache() {
    if (detailMem) return detailMem;
    try {
      detailMem = JSON.parse(localStorage.getItem(DETAIL_CACHE_KEY) || "{}");
    } catch (e) {
      detailMem = {};
    }
    return detailMem;
  }
  function saveDetailCache() {
    try {
      localStorage.setItem(DETAIL_CACHE_KEY, JSON.stringify(detailMem));
    } catch (e) {
      /* storage full — drop the cache rather than crash */
      detailMem = {};
    }
  }

  function getKey() {
    const local = localStorage.getItem(KEY_STORAGE);
    if (local) return local;
    return (window.GG_CONFIG && window.GG_CONFIG.RAWG_KEY) || "";
  }

  function setKey(key) {
    localStorage.setItem(KEY_STORAGE, key.trim());
  }

  function hasKey() {
    return !!getKey();
  }

  async function request(path, params = {}) {
    const key = getKey();
    if (!key) throw new Error("NO_KEY");
    const url = new URL(`${BASE}${path}`);
    url.searchParams.set("key", key);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString());
    if (res.status === 401) throw new Error("BAD_KEY");
    if (!res.ok) throw new Error(`RAWG ${res.status}`);
    return res.json();
  }

  // RAWG tags are user-generated and noisy. We only want tags that describe how
  // a game PLAYS (Open World, Sandbox, Roguelike, Crafting…) — not store/engine
  // features, input methods, camera perspective, player count, or pure vibe.
  // These two lists drop that noise. Edit them to taste.
  //
  // Substring match: drop a tag if its slug CONTAINS any of these fragments.
  // (Fragments are chosen to be distinctive so they don't catch gameplay tags —
  // e.g. "steam-" with the hyphen avoids nuking "steampunk".)
  const STOP_SUBSTRINGS = [
    "controller", "steam-", "split-screen", "co-op", "multiplayer",
    "achievements", "captions", "subtitle", "remote-play", "in-app",
    "leaderboard", "trading-card", "anti-cheat", "workshop", "cross-platform"
  ];
  // Exact match: drop a tag if its slug equals one of these.
  const STOP_EXACT = new Set([
    // camera / perspective / dimension (kept narrow so "third-person-shooter" survives)
    "first-person", "third-person", "top-down", "isometric", "side-scroller",
    "2d", "3d", "2-5d", "vr", "vr-only", "vr-supported",
    // player-count structure
    "singleplayer", "pvp", "pve", "mmo", "massively-multiplayer",
    // storefront / engine / status
    "early-access", "free-to-play", "demo", "e-sports", "kickstarter",
    "cloud-saves", "downloadable-content", "stats", "soundtrack",
    "includes-soundtrack", "includes-level-editor", "level-editor",
    "valve-anti-cheat-enabled", "exclusive",
    // mood / aesthetic (not a mechanic)
    "atmospheric", "great-soundtrack", "funny", "cute", "colorful",
    "relaxing", "beautiful", "masterpiece", "classic", "memes", "cinematic",
    "stylized", "epic", "addictive",
    // content descriptors
    "gore", "blood", "violent", "nudity", "sexual-content", "mature",
    "nsfw", "partial-nudity"
  ]);

  function isGameplayTag(slug) {
    if (STOP_EXACT.has(slug)) return false;
    return !STOP_SUBSTRINGS.some((frag) => slug.includes(frag));
  }

  // Keep meaningful English GAMEPLAY tags, in RAWG's relevance order, then cap.
  // We filter noise BEFORE slicing so we keep up to `limit` real gameplay tags
  // instead of mostly store/engine flags (which RAWG often ranks at the top).
  function cleanTags(tags = [], limit = 12) {
    return tags
      .filter((t) => !t.language || t.language === "eng")
      .filter((t) => t.slug && t.name)
      .filter((t) => isGameplayTag(t.slug))
      .slice(0, limit)
      .map((t) => ({
        slug: t.slug,
        name: t.name,
        games_count: t.games_count || 1000
      }));
  }

  return {
    getKey,
    setKey,
    hasKey,

    // Autocomplete search.
    async search(query) {
      if (!query.trim()) return [];
      const data = await request("/games", {
        search: query,
        search_precise: true,
        page_size: 8
      });
      return (data.results || []).map((g) => ({
        id: g.id,
        name: g.name,
        released: g.released,
        image: g.background_image,
        rating: g.rating
      }));
    },

    // Full detail for a game (full tags + the fields the scorer needs).
    // Cached in localStorage.
    async details(id) {
      const cache = detailCache();
      const hit = cache[id];
      if (hit && Date.now() - hit.t < DETAIL_TTL) return hit.v;

      const g = await request(`/games/${id}`);
      const v = {
        id: g.id,
        name: g.name,
        released: g.released,
        image: g.background_image,
        rating: g.rating,
        ratings_count: g.ratings_count,
        metacritic: g.metacritic,
        developers: (g.developers || []).map((d) => d.slug || d.name),
        genres: (g.genres || []).map((x) => ({ slug: x.slug, name: x.name })),
        tags: cleanTags(g.tags, 12)
      };
      cache[id] = { t: Date.now(), v };
      saveDetailCache();
      return v;
    },

    // Candidate games carrying a single tag. We query one tag at a time and let
    // the recommender union the results (predictable recall, no AND/OR guessing).
    async gamesByTag(slug, { ordering = "-rating", pageSize = 30 } = {}) {
      const data = await request("/games", {
        tags: slug,
        ordering,
        page_size: pageSize
      });
      return (data.results || [])
        .filter((g) => g.background_image)
        .map((g) => ({
          id: g.id,
          name: g.name,
          released: g.released,
          image: g.background_image,
          rating: g.rating,
          ratings_count: g.ratings_count,
          metacritic: g.metacritic,
          genres: (g.genres || []).map((x) => ({ slug: x.slug, name: x.name })),
          tags: cleanTags(g.tags, 10)
        }));
    }
  };
})();
