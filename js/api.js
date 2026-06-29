// Thin wrapper around the RAWG.io API.
// Docs: https://api.rawg.io/docs/
const RAWG = (() => {
  const BASE = "https://api.rawg.io/api";
  const KEY_STORAGE = "gg_rawg_key";

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

  // Keep only meaningful English tags, capped, in RAWG's relevance order.
  function cleanTags(tags = [], limit = 12) {
    return tags
      .filter((t) => !t.language || t.language === "eng")
      .filter((t) => t.slug && t.name)
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

    // Full detail for a liked game (gives the ~10 tags we build a profile from).
    async details(id) {
      const g = await request(`/games/${id}`);
      return {
        id: g.id,
        name: g.name,
        released: g.released,
        image: g.background_image,
        rating: g.rating,
        genres: (g.genres || []).map((x) => ({ slug: x.slug, name: x.name })),
        tags: cleanTags(g.tags, 12)
      };
    },

    // Candidate pool for recommendations, filtered by a set of tag slugs.
    async byTags(slugs, { exclude = [], pageSize = 40 } = {}) {
      const data = await request("/games", {
        tags: slugs.join(","),
        ordering: "-added",
        page_size: pageSize,
        exclude_additions: true
      });
      const excludeSet = new Set(exclude);
      return (data.results || [])
        .filter((g) => !excludeSet.has(g.id) && g.background_image)
        .map((g) => ({
          id: g.id,
          name: g.name,
          released: g.released,
          image: g.background_image,
          rating: g.rating,
          genres: (g.genres || []).map((x) => ({ slug: x.slug, name: x.name })),
          tags: cleanTags(g.tags, 10)
        }));
    }
  };
})();
