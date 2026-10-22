"""Register ES|QL tools, an index search tool and an "NBA Analyst" agent in Elastic Agent Builder."""
import httpx

from . import config

ESQL_TOOLS = [
    {
        "id": "nba.season_scoring_leaders",
        "description": "Top 10 scorers (points per game) for an NBA regular season, with rebounds, assists and true shooting. Seasons are identified by start year (2025 = the 2025-26 season).",
        "query": """FROM nba-season-stats
| WHERE season == ?season AND season_type == "regular" AND gp >= ?min_games
| EVAL pts = ROUND(pts, 1), reb = ROUND(reb, 1), ast = ROUND(ast, 1), ts_pct = ROUND(ts_pct, 3)
| KEEP player_name, team_abbreviation, gp, pts, reb, ast, ts_pct
| SORT pts DESC
| LIMIT 10""",
        "params": {
            "season": {"type": "integer", "description": "Season start year, e.g. 2025 for 2025-26"},
            "min_games": {"type": "integer", "description": "Minimum games played to qualify (use 40 for a full season, lower early in a season)"},
        },
    },
    {
        "id": "nba.player_career_averages",
        "description": "Career per-game averages and totals for one NBA player (season averages from 1996-97 onward), computed from per-season totals. Requires the player's full name.",
        "query": """FROM nba-season-stats
| WHERE TO_LOWER(player_name.keyword) == TO_LOWER(?player_name) AND season_type == ?season_type
| STATS games = SUM(gp), pts = SUM(pts_total), reb = SUM(reb_total), ast = SUM(ast_total), fgm = SUM(fgm_total), fga = SUM(fga_total), fg3m = SUM(fg3m_total), fg3a = SUM(fg3a_total), seasons = COUNT(*), first_season = MIN(season), last_season = MAX(season) BY player = player_name.keyword
| EVAL ppg = ROUND(pts / games, 1), rpg = ROUND(reb / games, 1), apg = ROUND(ast / games, 1), fg_pct = ROUND(fgm / fga, 3), fg3_pct = ROUND(fg3m / fg3a, 3), total_points = ROUND(pts)
| KEEP player, seasons, first_season, last_season, games, ppg, rpg, apg, fg_pct, fg3_pct, total_points""",
        "params": {
            "player_name": {"type": "string", "description": "Player's full name, e.g. 'Stephen Curry'"},
            "season_type": {"type": "string", "description": "'regular' or 'playoffs'"},
        },
    },
    {
        "id": "nba.player_vs_team",
        "description": "How one NBA player has performed against a specific team, season by season (box scores from 2016-17 onward): games, wins, points/rebounds/assists per game, best scoring game and FG%.",
        "query": """FROM nba-game-stats
| WHERE TO_LOWER(player_name.keyword) == TO_LOWER(?player_name) AND opponent_abbreviation == TO_UPPER(?team)
| STATS games = COUNT(*), wins = SUM(CASE(result == "W", 1, 0)), ppg = ROUND(AVG(pts), 1), rpg = ROUND(AVG(reb), 1), apg = ROUND(AVG(ast), 1), best_game_pts = MAX(pts), fgm = SUM(fgm), fga = SUM(fga) BY season
| EVAL fg_pct = ROUND(TO_DOUBLE(fgm) / fga, 3)
| DROP fgm, fga
| SORT season DESC""",
        "params": {
            "player_name": {"type": "string", "description": "Player's full name, e.g. 'Stephen Curry'"},
            "team": {"type": "string", "description": "Opponent team abbreviation, e.g. MEM, BOS, LAL"},
        },
    },
    {
        "id": "nba.big_scoring_games",
        "description": "Which NBA players have the most games scoring at least N points since a given season, with their career-high in that window. Use for '40-point games' or '50-point games' questions.",
        "query": """FROM nba-game-stats
| WHERE pts >= ?min_points AND season >= ?from_season
| STATS games = COUNT(*), best = MAX(pts), last_time = MAX(game_date) BY player = player_name.keyword
| SORT games DESC, best DESC
| LIMIT 15""",
        "params": {
            "min_points": {"type": "integer", "description": "Points threshold, e.g. 40"},
            "from_season": {"type": "integer", "description": "First season start year to include (box scores start at 2016)"},
        },
    },
    {
        "id": "nba.team_defense_rankings",
        "description": "All 30 NBA teams ranked by points allowed per game (to opposing players) in a regular season, best defense first.",
        "query": """FROM nba-game-stats
| WHERE season == ?season AND season_type == "regular"
| STATS points_allowed = SUM(pts), games = COUNT_DISTINCT(game_id) BY team = opponent_abbreviation
| EVAL points_allowed_per_game = ROUND(TO_DOUBLE(points_allowed) / games, 1)
| SORT points_allowed_per_game ASC
| KEEP team, games, points_allowed_per_game""",
        "params": {"season": {"type": "integer", "description": "Season start year, e.g. 2025 for 2025-26"}},
    },
    {
        "id": "nba.team_upcoming_games",
        "description": "A team's next 5 scheduled NBA games (date, tip-off time in UTC, home and visitor).",
        "query": """FROM nba-schedule
| WHERE (home_team == TO_UPPER(?team) OR visitor_team == TO_UPPER(?team)) AND status_state != "final" AND date >= NOW() - 1 day
| SORT datetime ASC
| LIMIT 5
| KEEP date, datetime, home_team, visitor_team""",
        "params": {"team": {"type": "string", "description": "Team abbreviation, e.g. GSW, LAL, BOS"}},
    },
    {
        "id": "nba.team_injury_report",
        "description": "Current injury report for an NBA team: player, status (Out, Day-To-Day...), expected return date and notes.",
        "query": """FROM nba-injuries
| WHERE team_abbreviation == TO_UPPER(?team)
| KEEP player_name, status, return_date, description
| SORT status""",
        "params": {"team": {"type": "string", "description": "Team abbreviation, e.g. GSW, LAL, BOS"}},
    },
]

SEARCH_TOOLS = [
    {
        "id": "nba.news_search",
        "description": "Search recent NBA news articles (ESPN, CBS, Yahoo, team blogs and more) about players, teams, injuries, trades and storylines. The index uses semantic_text, so natural-language questions work.",
        "pattern": "nba-articles",
    },
]

AGENT = {
    "id": "nba-analyst",
    "name": "NBA Analyst",
    "description": "Answers NBA player and team questions with stats, schedules, injuries and news stored in Elasticsearch.",
    "labels": ["nba", "demo"],
    "avatar_color": "#0B64DD",
    "avatar_symbol": "🏀",
    "instructions": (
        "You are an NBA analyst. Answer with numbers from your tools, never from memory. "
        "Use full player names in tool parameters (e.g. 'Stephen Curry', not 'Steph'). "
        "Seasons are identified by start year: 2025 means the 2025-26 season; the current season is 2026. "
        "Season averages start in 1996-97 and box scores in 2016-17; say so if a question needs older data. "
        "Use nba.news_search for injuries, trades and storylines and cite article titles. "
        "Keep answers short, lead with the verdict, then the supporting numbers."
    ),
}


def kibana_url() -> str:
    url = config.KIBANA_URL or config.ES_URL.replace(".es.", ".kb.")
    return url.rstrip("/").removesuffix(":443")


def setup_agent_builder() -> None:
    kb = kibana_url()
    http = httpx.Client(
        base_url=kb,
        headers={"Authorization": f"ApiKey {config.ES_API_KEY}", "kbn-xsrf": "true", "Content-Type": "application/json"},
        timeout=60,
    )

    def upsert(kind: str, body: dict) -> None:
        _id = body["id"]
        if http.get(f"/api/agent_builder/{kind}/{_id}").status_code == 200:
            update = {k: v for k, v in body.items() if k not in ("id", "type")}
            resp = http.put(f"/api/agent_builder/{kind}/{_id}", json=update)
            action = "updated"
        else:
            resp = http.post(f"/api/agent_builder/{kind}", json=body)
            action = "created"
        if resp.status_code >= 300:
            raise SystemExit(f"  ! {kind} {_id}: {resp.status_code} {resp.text[:400]}")
        print(f"  {action} {kind[:-1]} {_id}")

    print(f"Agent Builder at {kb}")
    for t in ESQL_TOOLS:
        upsert("tools", {
            "id": t["id"], "type": "esql", "description": t["description"], "tags": ["nba"],
            "configuration": {"query": t["query"], "params": t["params"]},
        })
    for t in SEARCH_TOOLS:
        upsert("tools", {
            "id": t["id"], "type": "index_search", "description": t["description"], "tags": ["nba"],
            "configuration": {"pattern": t["pattern"]},
        })
    tool_ids = [t["id"] for t in ESQL_TOOLS + SEARCH_TOOLS]
    upsert("agents", {
        **{k: v for k, v in AGENT.items() if k != "instructions"},
        "configuration": {"instructions": AGENT["instructions"], "tools": [{"tool_ids": tool_ids}]},
    })
    print(f"  MCP endpoint: {kb}/api/agent_builder/mcp")
    print(f"  Chat UI:      {kb}/app/agent_builder")
