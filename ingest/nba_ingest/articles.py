"""Recent NBA news from public RSS feeds -> Elasticsearch (semantic_text + BM25 fields)."""
import hashlib
import html
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from time import mktime

import feedparser
import httpx
import trafilatura
from elasticsearch import Elasticsearch

from . import config
from .es import bulk

USER_AGENT = "elastic-nba-demo/1.0 (RSS reader)"
# Some "NBA" feeds mix in other sports.
OTHER_SPORTS_RE = re.compile(r"/(mlb|nfl|nhl|wnba|college-football|college-basketball|ncaab|ncaaf|soccer|golf|tennis|boxing|mma)/")

TEAM_NICKNAMES = {
    "Hawks": "ATL", "Celtics": "BOS", "Nets": "BKN", "Hornets": "CHA", "Bulls": "CHI", "Cavaliers": "CLE",
    "Mavericks": "DAL", "Nuggets": "DEN", "Pistons": "DET", "Warriors": "GSW", "Rockets": "HOU", "Pacers": "IND",
    "Clippers": "LAC", "Lakers": "LAL", "Grizzlies": "MEM", "Heat": "MIA", "Bucks": "MIL", "Timberwolves": "MIN",
    "Pelicans": "NOP", "Knicks": "NYK", "Thunder": "OKC", "Magic": "ORL", "76ers": "PHI", "Suns": "PHX",
    "Trail Blazers": "POR", "Kings": "SAC", "Spurs": "SAS", "Raptors": "TOR", "Jazz": "UTA", "Wizards": "WAS",
}
TEAM_RE = re.compile(r"\b(" + "|".join(re.escape(n) for n in TEAM_NICKNAMES) + r")\b")


def _clean(text: str | None) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def _player_matcher(es: Elasticsearch):
    """Regex over names of current/recent players so we can tag articles with who they mention."""
    resp = es.search(
        index=config.PLAYERS_INDEX,
        size=5000,
        _source=["player_id", "full_name"],
        query={"bool": {"should": [
            {"term": {"is_active": True}},
            {"range": {"last_season": {"gte": config.current_season() - 5}}},
        ]}},
    )
    by_name = {h["_source"]["full_name"]: h["_source"]["player_id"] for h in resp["hits"]["hits"]
               if len(h["_source"].get("full_name") or "") > 5}
    if not by_name:
        print("  ! no players found in ES - run `nba-ingest players` first to enable player tagging")
        return None, {}
    names = sorted(by_name, key=len, reverse=True)
    # Lookarounds instead of \b so names ending in "Jr." still match.
    return re.compile(r"(?<!\w)(" + "|".join(re.escape(n) for n in names) + r")(?!\w)"), by_name


def _fetch_feed(source: str, url: str) -> list[dict]:
    try:
        resp = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=20, follow_redirects=True)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        print(f"  ! {source}: {exc}")
        return []
    items = []
    for e in feedparser.parse(resp.content).entries:
        link = e.get("link")
        if not link or OTHER_SPORTS_RE.search(link):
            continue
        ts = e.get("published_parsed") or e.get("updated_parsed")
        published = datetime.fromtimestamp(mktime(ts), tz=timezone.utc) if ts else datetime.now(timezone.utc)
        items.append({
            "url": link.split("?")[0] if "espn.com" in link else link,
            "source": source,
            "title": _clean(e.get("title")),
            "summary": _clean(e.get("summary") or e.get("description"))[:1500],
            "published_at": published.isoformat(),
        })
    print(f"  {source}: {len(items)} items")
    return items


def _full_text(url: str) -> str:
    try:
        resp = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=20, follow_redirects=True)
        if resp.status_code != 200:
            return ""
        return trafilatura.extract(resp.text, include_comments=False, include_tables=False) or ""
    except Exception:
        return ""


def ingest_articles(es: Elasticsearch, full_text: bool = True) -> None:
    print("Fetching RSS feeds...")
    items: dict[str, dict] = {}
    for source, url in config.NEWS_FEEDS.items():
        for item in _fetch_feed(source, url):
            items[hashlib.sha1(item["url"].encode()).hexdigest()] = item

    existing = set()
    if items:
        resp = es.mget(index=config.ARTICLES_INDEX, ids=list(items), _source=False)
        existing = {d["_id"] for d in resp["docs"] if d.get("found")}
    new = {k: v for k, v in items.items() if k not in existing}
    print(f"  {len(items)} unique articles, {len(new)} new")
    if not new:
        return

    if full_text:
        print("Extracting article text...")
        with ThreadPoolExecutor(max_workers=8) as pool:
            for item, body in zip(new.values(), pool.map(_full_text, [i["url"] for i in new.values()])):
                item["body"] = body
        print(f"  got full text for {sum(1 for i in new.values() if i.get('body'))}/{len(new)}")

    player_re, player_ids = _player_matcher(es)
    now = datetime.now(timezone.utc).isoformat()

    def actions():
        for _id, item in new.items():
            body = item.get("body") or ""
            text = f"{item['title']}\n{item['summary']}\n{body}"
            players = sorted(set(player_re.findall(text))) if player_re else []
            teams = sorted({TEAM_NICKNAMES[t] for t in TEAM_RE.findall(text)})
            yield {
                "_index": config.ARTICLES_INDEX,
                "_id": _id,
                "_source": {
                    **item,
                    "body": body,
                    "semantic_content": f"{item['title']}\n\n{item['summary']}\n\n{body[:8000]}".strip(),
                    "players_mentioned": players,
                    "player_ids": [player_ids[p] for p in players],
                    "teams_mentioned": teams,
                    "ingested_at": now,
                },
            }

    print("Indexing articles (semantic_text inference runs at ingest)...")
    bulk(es, actions(), "articles", chunk_size=20)
