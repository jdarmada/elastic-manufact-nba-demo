"""Season schedule (played + upcoming games) and current injury report -> Elasticsearch."""
from datetime import datetime, timezone
from typing import Iterator

from elasticsearch import Elasticsearch

from . import config
from .bdl import BallDontLie
from .es import bulk


def ingest_schedule(es: Elasticsearch, api: BallDontLie, season: int) -> None:
    def actions() -> Iterator[dict]:
        for g in api.paginate("/games", {"seasons[]": [season]}):
            home, visitor = g.get("home_team") or {}, g.get("visitor_team") or {}
            yield {
                "_index": config.SCHEDULE_INDEX,
                "_id": g["id"],
                "_source": {
                    "game_id": g["id"],
                    "date": g.get("date"),
                    "datetime": g.get("datetime"),
                    "season": g.get("season"),
                    "status_state": g.get("status_state") or ("final" if g.get("status") == "Final" else "scheduled"),
                    "postseason": bool(g.get("postseason")),
                    "postponed": bool(g.get("postponed")),
                    "home_team": home.get("abbreviation"),
                    "home_team_name": home.get("full_name"),
                    "visitor_team": visitor.get("abbreviation"),
                    "visitor_team_name": visitor.get("full_name"),
                    "teams": [home.get("abbreviation"), visitor.get("abbreviation")],
                    "home_team_score": g.get("home_team_score"),
                    "visitor_team_score": g.get("visitor_team_score"),
                },
            }

    print(f"Fetching {season} schedule...")
    bulk(es, actions(), "schedule")


def ingest_injuries(es: Elasticsearch, api: BallDontLie) -> None:
    teams = {t["id"]: t["abbreviation"] for t in api.get("/teams").get("data", [])}
    run_started = datetime.now(timezone.utc).isoformat()

    def actions() -> Iterator[dict]:
        for row in api.paginate("/player_injuries"):
            p = row.get("player") or {}
            if not p.get("id"):
                continue
            yield {
                "_index": config.INJURIES_INDEX,
                "_id": p["id"],
                "_source": {
                    "player_id": p["id"],
                    "player_name": f"{p.get('first_name', '')} {p.get('last_name', '')}".strip(),
                    "team_abbreviation": teams.get(p.get("team_id")),
                    "status": row.get("status"),
                    "return_date": row.get("return_date") or None,
                    "description": row.get("description"),
                    "updated_at": run_started,
                },
            }

    print("Fetching injury report...")
    bulk(es, actions(), "injuries")
    # Players no longer on the report are healthy again: drop their stale entries.
    es.indices.refresh(index=config.INJURIES_INDEX)
    resp = es.delete_by_query(index=config.INJURIES_INDEX, query={"range": {"updated_at": {"lt": run_started}}})
    print(f"  removed {resp.get('deleted', 0)} resolved injuries")
