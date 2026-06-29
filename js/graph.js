// Builds the force-graph data and renders the Obsidian-style network.
const GameGraphView = (() => {
  const COLORS = {
    liked: "#f2b340", // amber: your games
    tag: "#7d97ff", // periwinkle: shared tags (hubs)
    rec: "#34e0a1" // spring green: recommendations
  };

  let Graph = null;
  let highlightNodes = new Set();
  let highlightLinks = new Set();
  let hoverNode = null;

  // Turn the recommendation result into { nodes, links }.
  // A tag becomes a node only if it links >= 2 displayed games, so the graph
  // shows genuine overlaps rather than every tag.
  function buildData(likedGames, recommendations) {
    const displayed = [
      ...likedGames.map((g) => ({ ...g, group: "liked" })),
      ...recommendations.map((g) => ({ ...g, group: "rec" }))
    ];

    // Count tag usage across displayed games.
    const tagCount = {}; // slug -> { slug, name, count }
    for (const g of displayed) {
      for (const t of g.tags) {
        const e = tagCount[t.slug] || { slug: t.slug, name: t.name, count: 0 };
        e.count += 1;
        tagCount[t.slug] = e;
      }
    }
    const sharedTags = Object.values(tagCount).filter((t) => t.count >= 2);
    const sharedSet = new Set(sharedTags.map((t) => t.slug));

    const nodes = [];
    const links = [];

    for (const g of displayed) {
      nodes.push({
        id: `game:${g.id}`,
        name: g.name,
        group: g.group,
        val: g.group === "liked" ? 9 : 5,
        meta: g
      });
    }
    for (const t of sharedTags) {
      nodes.push({
        id: `tag:${t.slug}`,
        name: t.name,
        group: "tag",
        val: 3 + t.count,
        meta: t
      });
    }
    for (const g of displayed) {
      for (const t of g.tags) {
        if (sharedSet.has(t.slug)) {
          links.push({ source: `game:${g.id}`, target: `tag:${t.slug}` });
        }
      }
    }

    // Drop recommendation nodes that ended up with no shared tag (isolated).
    const linked = new Set();
    links.forEach((l) => {
      linked.add(l.source);
      linked.add(l.target);
    });
    const filteredNodes = nodes.filter(
      (n) => n.group === "liked" || linked.has(n.id)
    );

    return { nodes: filteredNodes, links };
  }

  function neighbors(data) {
    const map = new Map();
    data.nodes.forEach((n) => map.set(n.id, new Set()));
    data.links.forEach((l) => {
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      map.get(s)?.add(t);
      map.get(t)?.add(s);
    });
    return map;
  }

  function render(el, likedGames, recommendations, onGameClick) {
    const data = buildData(likedGames, recommendations);
    const nbr = neighbors(data);

    if (!Graph) {
      Graph = ForceGraph()(el);
    }

    Graph.width(el.clientWidth)
      .height(el.clientHeight)
      .backgroundColor("#0a0c12")
      .graphData(data)
      .nodeId("id")
      .nodeRelSize(4)
      .nodeVal("val")
      .linkColor(() => "rgba(255,255,255,0.10)")
      .linkWidth((l) => (highlightLinks.has(l) ? 2 : 1))
      .linkDirectionalParticles(0)
      .onNodeHover((node) => {
        highlightNodes = new Set();
        highlightLinks = new Set();
        hoverNode = node || null;
        if (node) {
          highlightNodes.add(node.id);
          (nbr.get(node.id) || new Set()).forEach((id) => highlightNodes.add(id));
          data.links.forEach((l) => {
            const s = typeof l.source === "object" ? l.source.id : l.source;
            const t = typeof l.target === "object" ? l.target.id : l.target;
            if (s === node.id || t === node.id) highlightLinks.add(l);
          });
        }
        el.style.cursor = node ? "pointer" : "default";
      })
      .onNodeClick((node) => {
        if (node.group !== "tag" && node.meta && onGameClick) onGameClick(node.meta);
        Graph.centerAt(node.x, node.y, 600);
        Graph.zoom(2.2, 600);
      })
      .nodeCanvasObject((node, ctx, scale) => {
        const r = Math.sqrt(node.val) * 1.8;
        const base = COLORS[node.group] || "#888";
        const dim = hoverNode && !highlightNodes.has(node.id);

        ctx.globalAlpha = dim ? 0.18 : 1;
        // glow
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
        ctx.fillStyle = base;
        ctx.shadowColor = base;
        ctx.shadowBlur = dim ? 0 : 12;
        ctx.fill();
        ctx.shadowBlur = 0;

        // label — show when zoomed in, or always for liked games / hovered
        const showLabel =
          scale > 1.4 || node.group === "liked" || highlightNodes.has(node.id);
        if (showLabel) {
          const fontSize = Math.max(10 / scale, 3.5);
          ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = dim ? "rgba(232,237,246,0.25)" : "#e8edf6";
          ctx.fillText(node.name, node.x, node.y + r + 1.5);
        }
        ctx.globalAlpha = 1;
      })
      .nodePointerAreaPaint((node, color, ctx) => {
        const r = Math.sqrt(node.val) * 1.8 + 2;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
        ctx.fill();
      });

    // Force tuning for an airy, Obsidian-like spread.
    Graph.d3Force("charge").strength(-90).distanceMax(320);
    Graph.d3Force("link").distance((l) => {
      const s = typeof l.source === "object" ? l.source : null;
      return s && s.group === "liked" ? 55 : 40;
    });

    // Fit to view once the simulation settles a bit.
    setTimeout(() => Graph.zoomToFit(500, 60), 400);
  }

  function resize(el) {
    if (Graph) Graph.width(el.clientWidth).height(el.clientHeight);
  }

  function clear() {
    hoverNode = null;
    highlightNodes = new Set();
    highlightLinks = new Set();
    if (Graph) Graph.graphData({ nodes: [], links: [] });
  }

  return { render, resize, clear, COLORS };
})();
