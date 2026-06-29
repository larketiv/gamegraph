// UI glue: search/autocomplete, selected-game chips, build action,
// recommendation list, and the API-key modal.
(() => {
  const $ = (sel) => document.querySelector(sel);

  const searchEl = $("#search");
  const suggestionsEl = $("#suggestions");
  const chipsEl = $("#chips");
  const buildBtn = $("#buildBtn");
  const recsEl = $("#recs");
  const graphEl = $("#graph");
  const overlayEl = $("#graphOverlay");
  const loadingEl = $("#loading");

  const keyModal = $("#keyModal");
  const keyInput = $("#keyInput");
  const clearBtn = $("#clearBtn");

  // selected games: id -> { id, name, image, released }
  const selected = new Map();
  let searchTimer = null;
  let lastGraph = null; // { liked: [...detailed games], recs: [...] } of the last build
  const STATE_KEY = "gg_state_v1"; // localStorage slot for saved games + graph

  /* ---------- API key modal ---------- */
  function openKeyModal() {
    keyInput.value = RAWG.getKey() || "";
    keyModal.hidden = false;
    keyInput.focus();
  }
  function closeKeyModal() {
    keyModal.hidden = true;
  }
  $("#settingsBtn").addEventListener("click", openKeyModal);
  $("#keyCancel").addEventListener("click", closeKeyModal);
  $("#keySave").addEventListener("click", () => {
    const v = keyInput.value.trim();
    if (v) RAWG.setKey(v);
    closeKeyModal();
  });
  keyModal.addEventListener("click", (e) => {
    if (e.target === keyModal) closeKeyModal();
  });

  function ensureKey() {
    if (!RAWG.hasKey()) {
      openKeyModal();
      return false;
    }
    return true;
  }

  /* ---------- Search + autocomplete ---------- */
  searchEl.addEventListener("input", () => {
    const q = searchEl.value.trim();
    clearTimeout(searchTimer);
    if (!q) {
      hideSuggestions();
      return;
    }
    searchTimer = setTimeout(() => runSearch(q), 250);
  });

  async function runSearch(q) {
    if (!ensureKey()) return;
    try {
      const results = await RAWG.search(q);
      renderSuggestions(results);
    } catch (err) {
      handleApiError(err);
    }
  }

  function renderSuggestions(results) {
    suggestionsEl.innerHTML = "";
    if (!results.length) {
      hideSuggestions();
      return;
    }
    for (const g of results) {
      if (selected.has(g.id)) continue;
      const item = document.createElement("button");
      item.className = "suggestion";
      const year = g.released ? ` (${g.released.slice(0, 4)})` : "";
      item.innerHTML = `
        <span class="thumb" style="background-image:url('${g.image || ""}')"></span>
        <span class="s-name">${escapeHtml(g.name)}${year}</span>`;
      item.addEventListener("click", () => addGame(g));
      suggestionsEl.appendChild(item);
    }
    suggestionsEl.hidden = suggestionsEl.children.length === 0;
  }

  function hideSuggestions() {
    suggestionsEl.hidden = true;
    suggestionsEl.innerHTML = "";
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) hideSuggestions();
  });

  /* ---------- Selected game chips ---------- */
  function addGame(g) {
    if (selected.has(g.id)) return;
    selected.set(g.id, g);
    searchEl.value = "";
    hideSuggestions();
    renderChips();
    persistState();
  }

  function removeGame(id) {
    selected.delete(id);
    renderChips();
    persistState();
  }

  function renderChips() {
    chipsEl.innerHTML = "";
    for (const g of selected.values()) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.innerHTML = `${escapeHtml(g.name)} <button title="Remove">×</button>`;
      chip.querySelector("button").addEventListener("click", () => removeGame(g.id));
      chipsEl.appendChild(chip);
    }
    buildBtn.disabled = selected.size < 1;
    updateClearBtn();
  }

  function updateClearBtn() {
    clearBtn.hidden = selected.size === 0 && !lastGraph;
  }

  /* ---------- Build the graph ---------- */
  buildBtn.addEventListener("click", build);

  async function build() {
    if (!ensureKey()) return;
    if (selected.size < 1) return;

    setLoading(true);
    try {
      // Fetch full details (tags) for each liked game in parallel.
      const liked = await Promise.all(
        [...selected.keys()].map((id) => RAWG.details(id))
      );
      const { recommendations } = await Recommender.recommend(liked);

      overlayEl.hidden = true;
      GameGraphView.render(graphEl, liked, recommendations, focusRec);
      renderRecs(recommendations);

      lastGraph = { liked, recs: recommendations };
      persistState();
      updateClearBtn();
    } catch (err) {
      handleApiError(err);
    } finally {
      setLoading(false);
    }
  }

  function setLoading(on) {
    loadingEl.hidden = !on;
    buildBtn.disabled = on || selected.size < 1;
    buildBtn.textContent = on ? "Building…" : "Build my graph";
  }

  /* ---------- Recommendations list ---------- */
  function renderRecs(recs) {
    recsEl.innerHTML = "";
    if (!recs.length) {
      recsEl.innerHTML = `<p class="empty">No strong matches found — try adding another game or two.</p>`;
      return;
    }
    for (const g of recs) {
      const card = document.createElement("article");
      card.className = "rec-card";
      card.id = `rec-${g.id}`;
      const year = g.released ? g.released.slice(0, 4) : "";
      const shared = g.tags
        .slice(0, 4)
        .map((t) => `<span class="tag">${escapeHtml(t.name)}</span>`)
        .join("");
      card.innerHTML = `
        <span class="rec-thumb" style="background-image:url('${g.image || ""}')"></span>
        <div class="rec-body">
          <h3>${escapeHtml(g.name)} ${year ? `<span class="year">${year}</span>` : ""}</h3>
          <div class="rec-tags">${shared}</div>
          <div class="rec-meta">★ ${g.rating || "–"} · match ${g.overlap} tag${g.overlap === 1 ? "" : "s"}</div>
        </div>
        <a class="rec-link" href="https://rawg.io/games/${g.id}" target="_blank" rel="noopener" title="View on RAWG">↗</a>`;
      recsEl.appendChild(card);
    }
  }

  function focusRec(meta) {
    const card = document.getElementById(`rec-${meta.id}`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 1200);
    }
  }

  /* ---------- Errors ---------- */
  function handleApiError(err) {
    if (err.message === "NO_KEY" || err.message === "BAD_KEY") {
      openKeyModal();
      if (err.message === "BAD_KEY") {
        keyInput.classList.add("error");
        setTimeout(() => keyInput.classList.remove("error"), 1500);
      }
    } else {
      console.error(err);
      alert("Something went wrong talking to RAWG. Check your connection and try again.");
    }
  }

  /* ---------- Utils ---------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  /* ---------- Local persistence ---------- */
  // Saves the selected games and the last built graph to localStorage so a
  // reload restores everything without hitting the API again.
  function persistState() {
    try {
      localStorage.setItem(
        STATE_KEY,
        JSON.stringify({ selected: [...selected.values()], graph: lastGraph })
      );
    } catch (e) {
      /* storage disabled or full — saving is best-effort */
    }
  }

  function restoreState() {
    let data;
    try {
      data = JSON.parse(localStorage.getItem(STATE_KEY) || "null");
    } catch (e) {
      data = null;
    }
    if (!data) return;

    if (Array.isArray(data.selected)) {
      for (const g of data.selected) selected.set(g.id, g);
      renderChips();
    }
    if (data.graph && data.graph.liked && data.graph.recs) {
      lastGraph = data.graph;
      overlayEl.hidden = true;
      GameGraphView.render(graphEl, lastGraph.liked, lastGraph.recs, focusRec);
      renderRecs(lastGraph.recs);
    }
    updateClearBtn();
  }

  function clearAll() {
    selected.clear();
    lastGraph = null;
    try {
      localStorage.removeItem(STATE_KEY);
    } catch (e) {
      /* ignore */
    }
    renderChips();
    recsEl.innerHTML =
      '<p class="empty">Your recommendations will appear here once you build a graph.</p>';
    GameGraphView.clear();
    overlayEl.hidden = false;
    updateClearBtn();
  }

  clearBtn.addEventListener("click", clearAll);

  window.addEventListener("resize", () => GameGraphView.resize(graphEl));

  // Restore any saved graph, then prompt for a key on first visit if needed.
  restoreState();
  if (!RAWG.hasKey()) openKeyModal();
})();
