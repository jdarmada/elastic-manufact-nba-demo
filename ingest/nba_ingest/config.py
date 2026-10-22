import os
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

# Shared .env lives at the repo root (one level above ingest/)
load_dotenv(Path(__file__).resolve().parents[2] / ".env")
load_dotenv()


def _require(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise SystemExit(f"Missing required env var {name} (see .env.example)")
    return value


ES_URL = os.getenv("ES_URL", "")
ES_API_KEY = os.getenv("ES_API_KEY", "")
BALLDONTLIE_API_KEY = os.getenv("BALLDONTLIE_API_KEY", "")

INDEX_PREFIX = os.getenv("INDEX_PREFIX", "nba")
PLAYERS_INDEX = f"{INDEX_PREFIX}-players"
SEASON_STATS_INDEX = f"{INDEX_PREFIX}-season-stats"
GAME_STATS_INDEX = f"{INDEX_PREFIX}-game-stats"
ARTICLES_INDEX = f"{INDEX_PREFIX}-articles"
SCHEDULE_INDEX = f"{INDEX_PREFIX}-schedule"
INJURIES_INDEX = f"{INDEX_PREFIX}-injuries"

# Leave empty to use the cluster's default semantic_text endpoint (ELSER on Serverless/EIS).
SEMANTIC_INFERENCE_ID = os.getenv("SEMANTIC_INFERENCE_ID", "")


def current_season() -> int:
    """balldontlie labels seasons by start year: the 2025-26 season is 2025."""
    today = date.today()
    return today.year if today.month >= 10 else today.year - 1


NEWS_FEEDS = {
    "ESPN": "https://www.espn.com/espn/rss/nba/news",
    "CBS Sports": "https://www.cbssports.com/rss/headlines/nba/",
    "Yahoo Sports": "https://sports.yahoo.com/nba/rss.xml",
    "RealGM": "https://basketball.realgm.com/rss/wiretap/0/0.xml",
    "SB Nation": "https://www.sbnation.com/rss/nba/index.xml",
    "Sporting News": "https://www.sportingnews.com/us/rss/nba",
}

# SB Nation team blogs (only the ones with live feeds as of Oct 2026)
_TEAM_BLOGS = {
    "Peachtree Hoops": "peachtreehoops", "CelticsBlog": "celticsblog", "NetsDaily": "netsdaily",
    "Fear The Sword": "fearthesword", "Mavs Moneyball": "mavsmoneyball", "Detroit Bad Boys": "detroitbadboys",
    "Golden State of Mind": "goldenstateofmind", "The Dream Shake": "thedreamshake",
    "Silver Screen and Roll": "silverscreenandroll", "Brew Hoop": "brewhoop", "Canis Hoopus": "canishoopus",
    "Posting and Toasting": "postingandtoasting", "Liberty Ballers": "libertyballers",
    "Bright Side of the Sun": "brightsideofthesun", "Blazer's Edge": "blazersedge",
    "Pounding The Rock": "poundingtherock", "Raptors HQ": "raptorshq", "SLC Dunk": "slcdunk",
    "Bullets Forever": "bulletsforever",
}
NEWS_FEEDS.update({name: f"https://www.{domain}.com/rss/index.xml" for name, domain in _TEAM_BLOGS.items()})
