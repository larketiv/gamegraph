// Recommendation engine.
//
// Idea: each liked game contributes its tags to a weighted "taste profile".
// A tag shared by several of your games matters more; a niche tag (few games
// in RAWG's catalog) is more distinctive, so we up-weight it (an IDF-style
// term). We then pull candidate games matching your strongest tags and score
// each by how much it overlaps your profile.
const Recommender = (() => {
  // Distinctiveness: rare tags carry more signal than ubiquitous ones.
  function idf(gamesCount) {
    return 1 / Math.log10((gamesCount || 1000) + 10);
  }

  // Build a tag profile from detailed liked games.
  function buildProfile(likedGames) {
    const profile = {}; // slug -> { slug, name, count, weight }
    for (const g of likedGames) {
      for (const t of g.tags) {
        const e = profile[t.slug] || {
          slug: t.slug,
          name: t.name,
          count: 0,
          idf: idf(t.games_count)
        };
        e.count += 1;
        profile[t.slug] = e;
      }
    }
    for (const e of Object.values(profile)) {
      e.weight = e.count * e.idf;
    }
    return profile;
  }

  function topTagSlugs(profile, n) {
    return Object.values(profile)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, n)
      .map((t) => t.slug);
  }

  // Score a candidate game against the taste profile.
  function scoreCandidate(candidate, profile, likedGenreSlugs) {
    let score = 0;
    let overlap = 0;
    for (const t of candidate.tags) {
      if (profile[t.slug]) {
        score += profile[t.slug].weight;
        overlap += 1;
      }
    }
    // Small bonus for genre alignment.
    for (const g of candidate.genres) {
      if (likedGenreSlugs.has(g.slug)) score += 0.4;
    }
    return { score, overlap };
  }

  // Main entry: liked detailed games -> { profile, recommendations }.
  async function recommend(likedGames, { limit = 14 } = {}) {
    const profile = buildProfile(likedGames);
    const likedIds = likedGames.map((g) => g.id);
    const likedGenreSlugs = new Set(
      likedGames.flatMap((g) => g.genres.map((x) => x.slug))
    );

    const seedTags = topTagSlugs(profile, 6);
    if (seedTags.length === 0) return { profile, recommendations: [] };

    const candidates = await RAWG.byTags(seedTags, {
      exclude: likedIds,
      pageSize: 40
    });

    const scored = candidates
      .map((c) => ({ ...c, ...scoreCandidate(c, profile, likedGenreSlugs) }))
      .filter((c) => c.overlap > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return { profile, recommendations: scored };
  }

  return { recommend, buildProfile };
})();
