# NBA Player Compare — Elastic × Manufact (mcp-use)

Compare any two NBA players from an AI assistant. Stats and news live in **Elasticsearch Serverless**; custom tools run aggregations and hybrid search; the tools are exposed as an **MCP server built with mcp-use and hosted on Manufact Cloud**, so event attendees can plug it into Claude, ChatGPT, Cursor, VS Code, etc.

```
balldontlie API ─┐                                    ┌─ compare_players (+ React card)
                 ├─ ingest/ (Python) ─► Elasticsearch ─┤  game_splits · milestone_games · head_to_head
NBA RSS feeds ───┘   semantic_text        Serverless   │  player_seasons · league_leaders · find_player
                                                        └─ search_nba_news · compare_player_news (hybrid RRF)
                                                               ▲
                                    mcp-server/ (mcp-use, TypeScript) ── deployed on Manufact ── attendees
```

## What's in Elasticsearch

| Index | Source | Docs | Used for |
|---|---|---|---|
| `nba-players` | balldontlie `/players` | ~7.5k | fuzzy name resolution (`search_as_you_type`, fuzzy + prefix) |
| `nba-season-stats` | balldontlie `/season_averages/general` base + advanced, 1996-97 → now, regular + playoffs | ~20k | career aggregations (`sum`, `weighted_avg`, `top_hits`), leaderboards |
| `nba-game-stats` | balldontlie `/stats` box scores, last 10 seasons | ~280k | splits (terms / runtime-field month), milestones (`filter` aggs), head-to-head (`terms` on `game_id` with `min_doc_count: 2`) |
| `nba-articles` | ESPN, CBS, Yahoo, RealGM, Sporting News, SB Nation + 19 team blogs (RSS + full text) | grows on each run | hybrid search: BM25 `multi_match` + `semantic` on a `semantic_text` field, fused with an `rrf` retriever; semantic highlighting |

Articles are tagged at ingest with `players_mentioned` / `teams_mentioned` so searches can be filtered to a player and coverage can be aggregated. `semantic_text` uses the project's default inference endpoint (currently `.jina-embeddings-v5-text-small` via EIS); set `SEMANTIC_INFERENCE_ID` to pin another (e.g. `.elser-2-elastic`).

Career numbers are computed correctly from per-season data: per-game averages × games are stored as `*_total`, and the tools compute `sum(total) / sum(gp)` and shooting % from makes/attempts rather than averaging averages.

## Setup

```bash
cp .env.example .env   # ES_URL, ES_API_KEY (ingest key), BALLDONTLIE_API_KEY (GOAT tier)
cd ingest && uv sync
uv run nba-ingest setup                 # create indices (--recreate to rebuild)
uv run nba-ingest players               # ~20s
uv run nba-ingest season-stats          # ~5 min
uv run nba-ingest game-stats            # last 10 seasons, ~60-90 min; backfills season teams at the end
uv run nba-ingest articles              # re-run any time; only new URLs are fetched + embedded
```

Other commands: `nba-ingest probe` (print a raw balldontlie row), `nba-ingest backfill-teams`, `nba-ingest all`.

### Read-only key for the public MCP server

The MCP server is public, so give it a key that can only read `nba-*`. An API key can't mint a privileged child key, so create it in Kibana (**Stack Management → API keys → Create**, enable *Control security privileges*):

```json
{ "nba_readonly": { "indices": [ { "names": ["nba-*"], "privileges": ["read", "view_index_metadata"] } ] } }
```

## Run the MCP server locally

```bash
cd mcp-server
printf 'ES_URL=...\nES_API_KEY=<read-only key>\n' > .env
npm install
npm run dev          # MCP: http://localhost:3000/mcp   Inspector: http://localhost:3000/mcp/inspector
```

## Deploy to Manufact Cloud

```bash
cd mcp-server
npx mcp-use login --api-key "$MCP_USE_API_KEY" --org <your-org>
npx mcp-use deploy --name nba-player-compare \
  --env ES_URL=https://<project>.es.<region>.elastic.cloud:443 \
  --env ES_API_KEY=<read-only key>
```

Deploys from the GitHub repo set as `origin` (install the Manufact GitHub App on it; use `--root-dir mcp-server` if the repo root is this folder) or pass `--no-github` to upload directly. Copy the public MCP URL from the Manufact dashboard.

## For attendees: connect & try it

**Claude (web/desktop):** Settings → Connectors → Add custom connector → paste the MCP URL.
**ChatGPT:** Settings → Apps & Connectors → Advanced → Developer mode → Create → paste the MCP URL.
**Cursor / VS Code / Claude Code:**

```json
{ "mcpServers": { "nba-compare": { "url": "https://<your-manufact-url>/mcp" } } }
```

Prompts to try:

- *Compare Steph Curry and Damian Lillard.* (renders the comparison card)
- *Who has more 40-point games, Harden or Westbrook? Show their best ones.*
- *LeBron vs Steph head-to-head — who won more of their matchups?*
- *Compare Jokic and Embiid in the playoffs since 2020.*
- *How does Luka play at home vs on the road? Compare to SGA.*
- *What's the latest injury news on Joel Embiid?*
- *Which players are getting more media buzz right now, Wembanyama or Cooper Flagg? Any trade rumors?*
- Use the **scouting_report** prompt for a full multi-tool breakdown.

## Keep news fresh

`.github/workflows/refresh-articles.yml` runs `nba-ingest articles` every 2 hours (add `ES_URL` and `ES_API_KEY` repo secrets). Or run it from cron on any machine.

## Notes & limits

- balldontlie season averages start in 1996-97, so pre-1996 careers (Jordan, Magic, Bird) are partial. Box scores cover the last 10 seasons.
- Season teams come from box scores (team with most games), so seasons before the box-score window show no team.
- Articles are indexed for search; tools return title, summary, URL and short highlights, not full article text.
