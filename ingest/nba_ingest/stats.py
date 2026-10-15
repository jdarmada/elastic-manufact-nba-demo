"""Players, season averages and per-game box scores from balldontlie -> Elasticsearch."""
from collections import defaultdict
from typing import Any, Iterator

from elasticsearch import Elasticsearch, helpers

from . import config
from .bdl import BallDontLie
from .es import SEASON_NUMERIC_FIELDS, SEASON_TOTAL_FIELDS, bulk

# balldontlie mirrors NBA.com column names; list fallbacks in case a key differs.
FIELD_ALIASES: dict[str, list[str]] = {
    "gp": ["gp", "games_played"],
    "tov": ["tov", "turnover", "turnovers"],
    "min": ["min", "minutes"],
    "dd2": ["dd2", "double_doubles"],
    "td3": ["td3", "triple_doubles"],
    "ts_pct": ["ts_pct", "true_shooting_percentage"],
    "efg_pct": ["efg_pct", "effective_field_goal_percentage"],
    "usg_pct": ["usg_pct", "usage_percentage"],
    "off_rating": ["off_rating", "offensive_rating", "e_off_rating"],
    "def_rating": ["def_rating", "defensive_rating", "e_def_rating"],
    "net_rating": ["net_rating", "e_net_rating"],
    "ast_pct": ["ast_pct", "assist_percentage"],
    "reb_pct": ["reb_pct", "rebound_percentage"],
}


def _num(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and ":" in value:  # "34:12"
        mins, secs = value.split(":", 1)
        try:
            return int(mins) + int(secs) / 60
        except ValueError:
            return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _pick(stats: dict, field: str) -> float | None:
    for key in FIELD_ALIASES.get(field, [field]):
        if key in stats:
            return _num(stats[key])
    return None


def season_label(season: int) -> str:
    return f"{season}-{str(season + 1)[-2:]}"


# ---------------------------------------------------------------- players


def ingest_players(es: Elasticsearch, api: BallDontLie) -> None:
    print("Fetching active players...")
    active_ids = {p["id"] for p in api.paginate("/players/active")}
    print(f"  {len(active_ids)} active players")

    def actions() -> Iterator[dict]:
        for n, p in enumerate(api.paginate("/players"), 1):
            if n % 1000 == 0:
                print(f"  ...{n} players")
            team = p.get("team") or {}
            yield {
                "_index": config.PLAYERS_INDEX,
                "_id": p["id"],
                "_source": {
                    "player_id": p["id"],
                    "full_name": f"{p.get('first_name', '')} {p.get('last_name', '')}".strip(),
                    "first_name": p.get("first_name"),
                    "last_name": p.get("last_name"),
                    "position": p.get("position") or None,
                    "height": p.get("height") or None,
                    "weight": p.get("weight") or None,
                    "jersey_number": p.get("jersey_number") or None,
                    "college": p.get("college") or None,
                    "country": p.get("country") or None,
                    "draft_year": p.get("draft_year"),
                    "draft_round": p.get("draft_round"),
                    "draft_number": p.get("draft_number"),
                    "team_abbreviation": team.get("abbreviation"),
                    "team_name": team.get("full_name"),
                    "is_active": p["id"] in active_ids,
                },
            }

    print("Fetching all players...")
    bulk(es, actions(), "players")


def _player_names(es: Elasticsearch) -> dict[int, str]:
    names = {}
    for hit in helpers.scan(es, index=config.PLAYERS_INDEX, _source=["player_id", "full_name"]):
        names[hit["_source"]["player_id"]] = hit["_source"]["full_name"]
    return names


# ---------------------------------------------------------- season averages


def _season_doc(player_id: int, season: int, season_type: str, base: dict, adv: dict,
                name: str | None, team: str | None) -> dict:
    merged = {**adv, **base}
    doc: dict[str, Any] = {
        "player_id": player_id,
        "player_name": name,
        "team_abbreviation": team,
        "season": season,
        "season_label": season_label(season),
        "season_type": season_type,
        "base": {k: v for k, v in base.items() if not k.endswith("_rank")},
        "advanced": {k: v for k, v in adv.items() if not k.endswith("_rank")},
    }
    for field in SEASON_NUMERIC_FIELDS:
        doc[field] = _pick(merged, field)
    gp = doc.get("gp") or 0
    for field in SEASON_TOTAL_FIELDS:
        value = doc.get(field)
        doc[f"{field}_total"] = round(value * gp, 2) if value is not None and gp else None
    return doc


def ingest_season_stats(es: Elasticsearch, api: BallDontLie, start: int, end: int,
                        season_types: list[str]) -> None:
    names = _player_names(es)
    seasons_by_player: dict[int, set[int]] = defaultdict(set)

    def actions() -> Iterator[dict]:
        for season in range(start, end + 1):
            for season_type in season_types:
                rows: dict[int, dict[str, dict]] = defaultdict(dict)
                meta: dict[int, dict] = {}
                for stat_type in ("base", "advanced"):
                    for row in api.paginate(
                        "/season_averages/general",
                        {"season": season, "season_type": season_type, "type": stat_type},
                    ):
                        pid = row.get("player_id") or (row.get("player") or {}).get("id")
                        if not pid:
                            continue
                        rows[pid][stat_type] = row.get("stats") or {}
                        meta.setdefault(pid, row)
                print(f"  {season_label(season)} {season_type}: {len(rows)} players")
                for pid, parts in rows.items():
                    base, adv = parts.get("base", {}), parts.get("advanced", {})
                    player = meta[pid].get("player") or {}
                    name = names.get(pid) or base.get("player_name") or (
                        f"{player.get('first_name', '')} {player.get('last_name', '')}".strip() or None)
                    team = base.get("team_abbreviation") or adv.get("team_abbreviation")
                    if season_type == "regular":
                        seasons_by_player[pid].add(season)
                    yield {
                        "_index": config.SEASON_STATS_INDEX,
                        "_id": f"{pid}-{season}-{season_type}",
                        "_source": _season_doc(pid, season, season_type, base, adv, name, team),
                    }

    print(f"Fetching season averages {start}..{end} ({', '.join(season_types)})...")
    bulk(es, actions(), "season stats")

    # Denormalize career span onto player docs for quick lookups.
    def updates() -> Iterator[dict]:
        for pid, seasons in seasons_by_player.items():
            yield {
                "_op_type": "update",
                "_index": config.PLAYERS_INDEX,
                "_id": pid,
                "script": {
                    "source": """
                        Set s = new HashSet();
                        if (ctx._source.seasons != null) { s.addAll(ctx._source.seasons); }
                        s.addAll(params.seasons);
                        List l = new ArrayList(s); Collections.sort(l);
                        ctx._source.seasons = l;
                        ctx._source.first_season = l.get(0);
                        ctx._source.last_season = l.get(l.size() - 1);
                    """,
                    "params": {"seasons": sorted(seasons)},
                },
            }

    bulk(es, updates(), "player career spans")


# ---------------------------------------------------------------- box scores


def _game_doc(s: dict) -> dict | None:
    minutes = _num(s.get("min"))
    if not minutes:  # DNP rows
        return None
    game, team, player = s.get("game") or {}, s.get("team") or {}, s.get("player") or {}
    team_id = team.get("id")
    home_id = (game.get("home_team") or {}).get("id") or game.get("home_team_id")
    visitor_id = (game.get("visitor_team") or {}).get("id") or game.get("visitor_team_id")
    is_home = team_id == home_id
    opp = (game.get("visitor_team") if is_home else game.get("home_team")) or {}

    home_score, visitor_score = game.get("home_team_score"), game.get("visitor_team_score")
    team_score = home_score if is_home else visitor_score
    opp_score = visitor_score if is_home else home_score
    result = None
    if str(game.get("status", "")).lower().startswith("final") and team_score is not None and opp_score is not None:
        result = "W" if team_score > opp_score else "L"

    v = {f: int(s.get(f) or 0) for f in ["pts", "reb", "oreb", "dreb", "ast", "stl", "blk",
                                          "pf", "fgm", "fga", "fg3m", "fg3a", "ftm", "fta"]}
    v["tov"] = int(s.get("turnover") or 0)
    tens = sum(1 for f in ("pts", "reb", "ast", "stl", "blk") if v[f] >= 10)
    game_score = (v["pts"] + 0.4 * v["fgm"] - 0.7 * v["fga"] - 0.4 * (v["fta"] - v["ftm"])
                  + 0.7 * v["oreb"] + 0.3 * v["dreb"] + v["stl"] + 0.7 * v["ast"] + 0.7 * v["blk"]
                  - 0.4 * v["pf"] - v["tov"])

    doc = {
        "player_id": player.get("id"),
        "player_name": f"{player.get('first_name', '')} {player.get('last_name', '')}".strip(),
        "team_abbreviation": team.get("abbreviation"),
        "opponent_abbreviation": opp.get("abbreviation") if opp else None,
        "game_id": game.get("id"),
        "game_date": (game.get("date") or "")[:10] or None,
        "season": game.get("season"),
        "postseason": bool(game.get("postseason")),
        "season_type": "playoffs" if game.get("postseason") else "regular",
        "is_home": is_home if home_id else None,
        "result": result,
        "min": round(minutes, 2),
        **v,
        "plus_minus": s.get("plus_minus"),
        "team_score": team_score,
        "opp_score": opp_score,
        "fg_pct": round(v["fgm"] / v["fga"], 3) if v["fga"] else None,
        "fg3_pct": round(v["fg3m"] / v["fg3a"], 3) if v["fg3a"] else None,
        "ft_pct": round(v["ftm"] / v["fta"], 3) if v["fta"] else None,
        "game_score": round(game_score, 1),
        "double_double": tens >= 2,
        "triple_double": tens >= 3,
    }
    return doc


def ingest_game_stats(es: Elasticsearch, api: BallDontLie, start: int, end: int) -> None:
    teams = {t["id"]: t for t in api.get("/teams").get("data", [])}

    def actions() -> Iterator[dict]:
        for season in range(start, end + 1):
            n = 0
            for s in api.paginate("/stats", {"seasons[]": [season]}):
                game = s.get("game") or {}
                # Some payloads only carry team ids on the game object; hydrate them.
                for side in ("home", "visitor"):
                    if not game.get(f"{side}_team") and game.get(f"{side}_team_id") in teams:
                        game[f"{side}_team"] = teams[game[f"{side}_team_id"]]
                doc = _game_doc(s)
                if not doc or not doc["player_id"] or not doc["game_id"]:
                    continue
                n += 1
                yield {"_index": config.GAME_STATS_INDEX, "_id": f"{doc['game_id']}-{doc['player_id']}", "_source": doc}
            print(f"  {season_label(season)}: {n} player-games")

    print(f"Fetching box scores {start}..{end}...")
    bulk(es, actions(), "game stats")
    backfill_season_teams(es)


def backfill_season_teams(es: Elasticsearch) -> None:
    """Season averages carry no team; use the team each player logged the most games for."""
    es.indices.refresh(index=config.GAME_STATS_INDEX)

    def updates() -> Iterator[dict]:
        after = None
        while True:
            composite: dict[str, Any] = {
                "size": 1000,
                "sources": [{"p": {"terms": {"field": "player_id"}}},
                            {"s": {"terms": {"field": "season"}}},
                            {"t": {"terms": {"field": "season_type"}}}],
            }
            if after:
                composite["after"] = after
            resp = es.search(index=config.GAME_STATS_INDEX, size=0, aggs={
                "ps": {"composite": composite, "aggs": {"team": {"terms": {"field": "team_abbreviation", "size": 1}}}}})
            agg = resp["aggregations"]["ps"]
            for b in agg["buckets"]:
                teams = b["team"]["buckets"]
                if teams:
                    k = b["key"]
                    yield {"_op_type": "update", "_index": config.SEASON_STATS_INDEX,
                           "_id": f"{k['p']}-{k['s']}-{k['t']}", "doc": {"team_abbreviation": teams[0]["key"]}}
            after = agg.get("after_key")
            if not agg["buckets"] or not after:
                return

    # Missing season docs (e.g. play-in only) show up as 404s; that's expected.
    bulk(es, updates(), "season team backfill")
