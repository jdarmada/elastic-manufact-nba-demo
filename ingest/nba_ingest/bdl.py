"""Minimal balldontlie NBA API client with cursor pagination, throttling and retries."""
import time
from typing import Any, Iterator

import httpx

from . import config

BASE_URL = "https://api.balldontlie.io/nba/v1"


class BallDontLie:
    def __init__(self, api_key: str | None = None, requests_per_minute: int = 550):
        key = api_key or config.BALLDONTLIE_API_KEY
        if not key:
            raise SystemExit("Set BALLDONTLIE_API_KEY in .env")
        self.http = httpx.Client(base_url=BASE_URL, headers={"Authorization": key}, timeout=60)
        self.min_interval = 60.0 / requests_per_minute
        self._last = 0.0

    def get(self, path: str, params: dict[str, Any] | None = None) -> dict:
        for attempt in range(6):
            wait = self.min_interval - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            try:
                resp = self.http.get(path, params=params)
            except httpx.TransportError as exc:
                print(f"  network error on {path} ({exc}), retrying")
                time.sleep(2**attempt)
                continue
            if resp.status_code == 429 or resp.status_code >= 500:
                time.sleep(min(60, 2 ** (attempt + 1)))
                continue
            if resp.status_code == 401:
                raise SystemExit(f"balldontlie 401 on {path}: invalid key or your tier lacks this endpoint")
            resp.raise_for_status()
            return resp.json()
        raise RuntimeError(f"Giving up on {path} {params}")

    def paginate(self, path: str, params: dict[str, Any] | None = None) -> Iterator[dict]:
        params = {**(params or {}), "per_page": 100}
        while True:
            body = self.get(path, params)
            yield from body.get("data", [])
            cursor = (body.get("meta") or {}).get("next_cursor")
            if not cursor:
                return
            params["cursor"] = cursor
