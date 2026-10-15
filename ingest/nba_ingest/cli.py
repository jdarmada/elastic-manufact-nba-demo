import argparse
import json

from . import config
from .es import client, create_indices


def main() -> None:
    cur = config.current_season()
    parser = argparse.ArgumentParser(prog="nba-ingest", description="Load NBA data into Elasticsearch")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("setup", help="Create indices (use --recreate to drop and rebuild)")
    p.add_argument("--recreate", action="store_true")

    sub.add_parser("players", help="All players (balldontlie /players)")

    p = sub.add_parser("season-stats", help="Season averages, base + advanced (1996+)")
    p.add_argument("--start", type=int, default=1996)
    p.add_argument("--end", type=int, default=cur)
    p.add_argument("--season-types", default="regular,playoffs")

    p = sub.add_parser("game-stats", help="Per-game box scores")
    p.add_argument("--start", type=int, default=cur - 9)
    p.add_argument("--end", type=int, default=cur)

    sub.add_parser("backfill-teams", help="Fill season-stat teams from box scores (runs after game-stats)")

    p = sub.add_parser("articles", help="Recent NBA news from RSS feeds")
    p.add_argument("--no-full-text", action="store_true", help="Index RSS title/summary only")

    p = sub.add_parser("all", help="setup + players + season-stats + game-stats + articles")
    p.add_argument("--game-seasons", type=int, default=10, help="How many recent seasons of box scores")

    p = sub.add_parser("probe", help="Print one raw season-average row (to verify field names)")
    p.add_argument("--season", type=int, default=cur - 1)

    p = sub.add_parser("readonly-key", help="Create a read-only ES API key for the MCP server")
    p.add_argument("--name", default="nba-mcp-readonly")

    args = parser.parse_args()

    if args.cmd == "probe":
        from .bdl import BallDontLie
        api = BallDontLie()
        for stat_type in ("base", "advanced"):
            body = api.get("/season_averages/general",
                           {"season": args.season, "season_type": "regular", "type": stat_type, "per_page": 1})
            print(f"--- {stat_type} ---")
            print(json.dumps(body.get("data", [])[:1], indent=2))
        return

    es = client()

    if args.cmd == "readonly-key":
        role = {"nba_readonly": {
            "indices": [{"names": [f"{config.INDEX_PREFIX}-*"], "privileges": ["read", "view_index_metadata"]}],
        }}
        try:
            resp = es.security.create_api_key(name=args.name, role_descriptors=role)
        except Exception as exc:
            # API keys can't mint child keys with privileges; create it in Kibana instead.
            print(f"Could not create key with this credential ({exc}).")
            print("In Kibana: Stack Management -> API keys -> Create API key -> 'Control security privileges', paste:")
            print(json.dumps(role, indent=2))
            return
        print("Add this to mcp-server/.env (and your Manufact deployment) as ES_API_KEY:")
        print(resp["encoded"])
        return

    if args.cmd in ("setup", "all"):
        print("Creating indices...")
        create_indices(es, recreate=getattr(args, "recreate", False))
        if args.cmd == "setup":
            return

    from .bdl import BallDontLie
    from .stats import backfill_season_teams, ingest_game_stats, ingest_players, ingest_season_stats

    if args.cmd == "backfill-teams":
        backfill_season_teams(es)
    elif args.cmd == "players":
        ingest_players(es, BallDontLie())
    elif args.cmd == "season-stats":
        ingest_season_stats(es, BallDontLie(), args.start, args.end, args.season_types.split(","))
    elif args.cmd == "game-stats":
        ingest_game_stats(es, BallDontLie(), args.start, args.end)
    elif args.cmd == "articles":
        from .articles import ingest_articles
        ingest_articles(es, full_text=not args.no_full_text)
    elif args.cmd == "all":
        from .articles import ingest_articles
        api = BallDontLie()
        ingest_players(es, api)
        ingest_season_stats(es, api, 1996, cur, ["regular", "playoffs"])
        ingest_game_stats(es, api, cur - args.game_seasons + 1, cur)
        ingest_articles(es)


if __name__ == "__main__":
    main()
