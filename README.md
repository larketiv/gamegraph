# GameGraph

An Obsidian-style recommendation engine for video games. Add a few games you
love, and GameGraph pulls their tags from the live [RAWG.io](https://rawg.io)
catalog, builds a force-directed web of the tags your games share, and grows new
recommendations out of those overlapping hubs.

- **Gold nodes** — games you added
- **Blue nodes** — tags two or more of your games share (the hubs)
- **Green nodes** — games GameGraph recommends, pulled in by shared tags

Drag nodes around, zoom/pan, hover to highlight a node's connections, and click a
green node to jump to it in the recommendations list.

## Run it locally

It's a static site — no build step. Because browsers block `fetch` from
`file://`, serve it over a tiny local HTTP server:

```bash
# from the gamegraph/ folder
python -m http.server 8000
# then open http://localhost:8000
```

## Get a RAWG API key

GameGraph needs a free RAWG key for live game data.

1. Sign up at <https://rawg.io/apidocs> and copy your API key.
2. Open the site, click the ⚙ button, paste the key, and save. It's stored only
   in your browser's `localStorage` — nothing is committed or sent anywhere else.

Prefer the site to "just work" for every visitor without prompting? Paste the key
into `js/config.js` instead — but note that file is **public** once pushed, so
anyone can read (and use up) that key. For a personal project on RAWG's free tier
(20k requests/month) that's usually fine.

## Deploy to GitHub Pages

1. Create a repo and push this folder's contents to it:
   ```bash
   git init
   git add .
   git commit -m "Initial GameGraph"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a
   branch**, branch `main`, folder `/ (root)`. Save.
3. Your site goes live at `https://<you>.github.io/<repo>/` in a minute or two.

The included `.nojekyll` file tells Pages to serve everything as-is.

## How recommendations work

Each liked game contributes its tags to a weighted taste profile. Tags shared by
several of your games count more, and rarer tags (fewer games in RAWG's catalog)
are treated as more distinctive (an IDF-style weight). GameGraph then fetches a
candidate pool matching your strongest tags and scores each candidate by how much
it overlaps your profile, with a small bonus for matching genres.

## Project layout

```
index.html        markup + script includes
css/style.css     dark, Obsidian-inspired theme
js/config.js      optional hardcoded API key
js/api.js         RAWG API wrapper
js/recommend.js   taste profile + scoring
js/graph.js       force-graph rendering
js/app.js         UI glue (search, chips, recs, modal)
```
