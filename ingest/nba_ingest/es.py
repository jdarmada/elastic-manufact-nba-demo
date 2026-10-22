from typing import Iterable

from elasticsearch import Elasticsearch, helpers

from . import config

NAME_FIELD = {
    "type": "text",
    "fields": {
        "keyword": {"type": "keyword"},
        "suggest": {"type": "search_as_you_type"},
    },
}

# Raw balldontlie stat blobs are stored as-is; force numbers to double so a
# first value like `1` doesn't lock a percentage field to long.
RAW_STATS_TEMPLATES = [
    {"raw_numbers": {"path_match": ["base.*", "advanced.*"], "match_mapping_type": "long", "mapping": {"type": "double"}}},
    {"raw_strings": {"path_match": ["base.*", "advanced.*"], "match_mapping_type": "string", "mapping": {"type": "keyword"}}},
]

# Per-game numbers we normalize out of the season-average payloads.
SEASON_NUMERIC_FIELDS = [
    "gp", "w", "l", "min", "pts", "reb", "oreb", "dreb", "ast", "stl", "blk", "tov", "pf",
    "fgm", "fga", "fg_pct", "fg3m", "fg3a", "fg3_pct", "ftm", "fta", "ft_pct",
    "plus_minus", "dd2", "td3", "age",
    "ts_pct", "efg_pct", "usg_pct", "off_rating", "def_rating", "net_rating",
    "pie", "ast_pct", "reb_pct", "pace",
]
# Season totals (per-game average * games played) so career numbers can be
# aggregated correctly with sum()/sum(gp) instead of averaging averages.
SEASON_TOTAL_FIELDS = ["min", "pts", "reb", "oreb", "dreb", "ast", "stl", "blk", "tov", "pf",
                       "fgm", "fga", "fg3m", "fg3a", "ftm", "fta"]

GAME_INT_FIELDS = ["pts", "reb", "oreb", "dreb", "ast", "stl", "blk", "tov", "pf",
                   "fgm", "fga", "fg3m", "fg3a", "ftm", "fta", "plus_minus", "team_score", "opp_score"]


def mappings() -> dict[str, dict]:
    semantic = {"type": "semantic_text"}
    if config.SEMANTIC_INFERENCE_ID:
        semantic["inference_id"] = config.SEMANTIC_INFERENCE_ID

    season_props = {f: {"type": "float"} for f in SEASON_NUMERIC_FIELDS}
    season_props.update({f"{f}_total": {"type": "float"} for f in SEASON_TOTAL_FIELDS})

    return {
        config.PLAYERS_INDEX: {
            "properties": {
                "player_id": {"type": "integer"},
                "full_name": NAME_FIELD,
                "first_name": {"type": "text", "fields": {"keyword": {"type": "keyword"}}},
                "last_name": {"type": "text", "fields": {"keyword": {"type": "keyword"}}},
                "position": {"type": "keyword"},
                "height": {"type": "keyword"},
                "weight": {"type": "keyword"},
                "jersey_number": {"type": "keyword"},
                "college": {"type": "keyword"},
                "country": {"type": "keyword"},
                "draft_year": {"type": "integer"},
                "draft_round": {"type": "integer"},
                "draft_number": {"type": "integer"},
                "team_abbreviation": {"type": "keyword"},
                "team_name": {"type": "keyword"},
                "is_active": {"type": "boolean"},
                "seasons": {"type": "integer"},
                "first_season": {"type": "integer"},
                "last_season": {"type": "integer"},
            }
        },
        config.SEASON_STATS_INDEX: {
            "dynamic_templates": RAW_STATS_TEMPLATES,
            "properties": {
                "player_id": {"type": "integer"},
                "player_name": NAME_FIELD,
                "team_abbreviation": {"type": "keyword"},
                "season": {"type": "integer"},
                "season_label": {"type": "keyword"},
                "season_type": {"type": "keyword"},
                **season_props,
                "base": {"type": "object"},
                "advanced": {"type": "object"},
            },
        },
        config.GAME_STATS_INDEX: {
            "properties": {
                "player_id": {"type": "integer"},
                "player_name": NAME_FIELD,
                "team_abbreviation": {"type": "keyword"},
                "opponent_abbreviation": {"type": "keyword"},
                "game_id": {"type": "integer"},
                "game_date": {"type": "date"},
                "season": {"type": "integer"},
                "season_type": {"type": "keyword"},
                "postseason": {"type": "boolean"},
                "is_home": {"type": "boolean"},
                "result": {"type": "keyword"},
                "min": {"type": "float"},
                **{f: {"type": "integer"} for f in GAME_INT_FIELDS},
                "fg_pct": {"type": "float"},
                "fg3_pct": {"type": "float"},
                "ft_pct": {"type": "float"},
                "game_score": {"type": "float"},
                "double_double": {"type": "boolean"},
                "triple_double": {"type": "boolean"},
            }
        },
        config.ARTICLES_INDEX: {
            "properties": {
                "url": {"type": "keyword"},
                "source": {"type": "keyword"},
                "title": {"type": "text", "analyzer": "english"},
                "summary": {"type": "text", "analyzer": "english"},
                "body": {"type": "text", "analyzer": "english"},
                "semantic_content": semantic,
                "published_at": {"type": "date"},
                "ingested_at": {"type": "date"},
                "players_mentioned": {"type": "keyword"},
                "player_ids": {"type": "integer"},
                "teams_mentioned": {"type": "keyword"},
            }
        },
        config.SCHEDULE_INDEX: {
            "properties": {
                "game_id": {"type": "integer"},
                "date": {"type": "date"},
                "datetime": {"type": "date"},
                "season": {"type": "integer"},
                "status_state": {"type": "keyword"},
                "postseason": {"type": "boolean"},
                "postponed": {"type": "boolean"},
                "home_team": {"type": "keyword"},
                "home_team_name": {"type": "keyword"},
                "visitor_team": {"type": "keyword"},
                "visitor_team_name": {"type": "keyword"},
                "teams": {"type": "keyword"},
                "home_team_score": {"type": "integer"},
                "visitor_team_score": {"type": "integer"},
            }
        },
        config.INJURIES_INDEX: {
            "properties": {
                "player_id": {"type": "integer"},
                "player_name": NAME_FIELD,
                "team_abbreviation": {"type": "keyword"},
                "status": {"type": "keyword"},
                "return_date": {"type": "date", "ignore_malformed": True},
                "description": {"type": "text", "analyzer": "english"},
                "updated_at": {"type": "date"},
            }
        },
    }


def client() -> Elasticsearch:
    if not config.ES_URL or not config.ES_API_KEY:
        raise SystemExit("Set ES_URL and ES_API_KEY in .env")
    return Elasticsearch(config.ES_URL, api_key=config.ES_API_KEY, request_timeout=120)


def create_indices(es: Elasticsearch, recreate: bool = False, only: list[str] | None = None) -> None:
    for index, mapping in mappings().items():
        if only and index not in only:
            continue
        if es.indices.exists(index=index):
            if not recreate:
                print(f"  index {index} exists, keeping it")
                continue
            es.indices.delete(index=index)
            print(f"  deleted {index}")
        es.indices.create(index=index, mappings=mapping)
        print(f"  created {index}")


def bulk(es: Elasticsearch, actions: Iterable[dict], label: str, chunk_size: int = 500,
         ignore_missing: bool = False) -> int:
    ok, errors, missing = 0, 0, 0
    for success, info in helpers.streaming_bulk(
        es, actions, chunk_size=chunk_size, raise_on_error=False, raise_on_exception=False, max_retries=3
    ):
        if success:
            ok += 1
        elif ignore_missing and next(iter(info.values()), {}).get("status") == 404:
            missing += 1
        else:
            errors += 1
            if errors <= 5:
                print(f"  ! {label} bulk error: {info}")
    skipped = f", {missing} skipped (no matching doc)" if missing else ""
    print(f"  {label}: indexed {ok} docs ({errors} errors{skipped})")
    return ok
