// Recommendation engine (content-based).
//
// Pipeline:
//   1. Build a weighted taste-vector from the liked games' tags + genres.
//      Each tag is weighted by IDF (rare tags in RAWG's catalog = more
//      distinctive), and summed across liked games (shared tags grow stronger).
//   2. RETRIEVE a broad candidate pool by querying RAWG once per top tag and
//      unioning the results (per-tag queries sidestep RAWG's ambiguous
//      multi-tag AND/OR behavior and give predictable recall).
//   3. PRE-SCORE candidates with their (truncated) list tags to pick finalists.
//   4. RERANK finalists on their FULL tags (fetched via details, cached) using
//      cosine similarity × a quality prior × franchise/developer penalties.
//   5. SELECT with MMR so results span your taste clusters instead of piling
//      onto the dominant one. An "adventure" knob trades relevance for variety.
const Recommender = (() => {
  const GENRE_WEIGHT = 0.7; // how much a shared genre counts vs a tag

  /* ---------- vector math ---------- */
  function idf(gamesCount) {
    return 1 / Math.log10((gamesCount || 1000) + 10);
  }

  // A game -> Map of feature -> weight. Tags weighted by IDF, genres flat.
  function vectorFromGame(g) {
    const v = new Map();
    for (const t of g.tags || []) {
      v.set(t.slug, (v.get(t.slug) || 0) + idf(t.games_count));
    }
    for (const ge of g.genres || []) {
      const k = "genre:" + ge.slug;
      v.set(k, (v.get(k) || 0) + GENRE_WEIGHT);
    }
    return v;
  }

  function profileVector(likedGames) {
    const v = new Map();
    for (const g of likedGames) {
      for (const [k, w] of vectorFromGame(g)) v.set(k, (v.get(k) || 0) + w);
    }
    return v;
  }

  function dot(a, b) {
    const [small, big] = a.size < b.size ? [a, b] : [b, a];
    let s = 0;
    for (const [k, v] of small) {
      const w = big.get(k);
      if (w) s += v * w;
    }
    return s;
  }
  function magnitude(a) {
    let s = 0;
    for (const v of a.values()) s += v * v;
    return Math.sqrt(s);
  }
  function cosine(a, b) {
    const m = magnitude(a) * magnitude(b);
    return m ? dot(a, b) / m : 0;
  }

  /* ---------- priors & penalties ---------- */
  // Mild quality multiplier (~0.6..1.25). Bayesian shrink on rating count so a
  // 5.0 from 3 votes doesn't beat a 4.3 from 5000.
  function qualityPrior(g) {
    const r = g.rating || 0; // 0..5
    const n = g.ratings_count || 0;
    const conf = n / (n + 30);
    let q = 0.6 + 0.5 * (r / 5) * conf;
    if (g.metacritic) q *= 0.85 + 0.3 * (g.metacritic / 100);
    return q;
  }

  function normName(s) {
    return String(s)
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function firstWords(s, n) {
    return normName(s).split(" ").slice(0, n).join(" ");
  }
  // Penalize same-developer (0.6) and same-series-by-name (0.5) so a soulslike
  // pick doesn't return five entries from the same franchise/studio.
  function franchisePenalty(g, likedDevs, likedNames) {
    let p = 1;
    if ((g.developers || []).some((d) => likedDevs.has(d))) p *= 0.6;
    const c2 = firstWords(g.name, 2);
    if (c2 && likedNames.some((n) => firstWords(n, 2) === c2)) p *= 0.5;
    return p;
  }

  /* ---------- explanations ---------- */
  function explain(game, likedGames) {
    let best = null;
    let bestShared = [];
    for (const lg of likedGames) {
      const likedSlugs = new Set(lg.tags.map((t) => t.slug));
      const shared = (game.tags || []).filter((t) => likedSlugs.has(t.slug));
      if (shared.length > bestShared.length) {
        best = lg;
        bestShared = shared;
      }
    }
    return best
      ? { game: best.name, tags: bestShared.slice(0, 3).map((t) => t.name) }
      : null;
  }

  function augment(game, score, likedGames) {
    const likedSlugs = new Set(likedGames.flatMap((g) => g.tags.map((t) => t.slug)));
    const overlap = (game.tags || []).filter((t) => likedSlugs.has(t.slug)).length;
    return { ...game, score, overlap, because: explain(game, likedGames) };
  }

  /* ---------- selection (MMR diversification) ---------- */
  // adventure in [0,1]: 0 = safest/closest matches, 1 = most varied.
  function select(scored, likedGames, { adventure = 0.35, limit = 14 } = {}) {
    if (!scored.length) return [];
    const a = Math.max(0, Math.min(1, adventure));
    const lambda = 1 - 0.6 * a; // weight on relevance vs diversity
    const maxScore = scored[0].score || 1;

    const pool = scored.slice();
    const chosen = [];
    while (chosen.length < limit && pool.length) {
      let bestIdx = 0;
      let bestVal = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const relNorm = pool[i].score / maxScore;
        let div = 0;
        for (const c of chosen) div = Math.max(div, cosine(pool[i].vec, c.vec));
        const val = lambda * relNorm - (1 - lambda) * div;
        if (val > bestVal) {
          bestVal = val;
          bestIdx = i;
        }
      }
      chosen.push(pool.splice(bestIdx, 1)[0]);
    }
    return chosen.map((c) => augment(c.game, c.score, likedGames));
  }

  /* ---------- main entry ---------- */
  async function recommend(likedGames, { adventure = 0.35, limit = 14 } = {}) {
    const profile = profileVector(likedGames);
    const likedIds = new Set(likedGames.map((g) => g.id));

    // Top tags drive retrieval.
    const topSlugs = [...profile.entries()]
      .filter(([k]) => !k.startsWith("genre:"))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k]) => k);
    if (!topSlugs.length) return { profile, recommendations: [], scored: [] };

    // 2. Retrieve: one query per top tag, unioned.
    const lists = await Promise.all(
      topSlugs.map((slug) =>
        RAWG.gamesByTag(slug, { ordering: "-rating", pageSize: 30 }).catch(() => [])
      )
    );
    const seen = new Set(likedIds);
    const pool = [];
    for (const list of lists) {
      for (const g of list) {
        if (seen.has(g.id)) continue;
        seen.add(g.id);
        pool.push(g);
      }
    }

    // 3. Pre-score on truncated list tags; keep finalists worth fetching.
    const finalists = pool
      .map((g) => ({ g, pre: cosine(profile, vectorFromGame(g)) * qualityPrior(g) }))
      .filter((x) => x.pre > 0)
      .sort((a, b) => b.pre - a.pre)
      .slice(0, 20);

    // 4. Rerank on FULL tags (details are cached in localStorage).
    const detailed = await Promise.all(
      finalists.map((x) => RAWG.details(x.g.id).catch(() => null))
    );
    const likedDevs = new Set(likedGames.flatMap((g) => g.developers || []));
    const likedNames = likedGames.map((g) => g.name);

    const scored = [];
    for (const g of detailed) {
      if (!g || !g.tags || !g.tags.length) continue;
      const vec = vectorFromGame(g);
      const rel =
        cosine(profile, vec) *
        qualityPrior(g) *
        franchisePenalty(g, likedDevs, likedNames);
      if (rel > 0) scored.push({ game: g, vec, score: rel });
    }
    scored.sort((a, b) => b.score - a.score);

    // 5. Select with MMR.
    const recommendations = select(scored, likedGames, { adventure, limit });
    return { profile, recommendations, scored };
  }

  // Re-run selection on an existing scored pool (instant, no API) — used when
  // the adventure slider changes.
  function reselect(scored, likedGames, opts) {
    return select(scored, likedGames, opts);
  }

  return { recommend, reselect, _cosine: cosine, _vectorFromGame: vectorFromGame };
})();
