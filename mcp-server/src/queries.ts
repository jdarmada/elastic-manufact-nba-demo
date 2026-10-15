/**
 * Elasticsearch queries behind the MCP tools: aggregations over season averages
 * and box scores, plus hybrid (BM25 + semantic_text, fused with RRF) article search.
 */
import { es, INDEX, type PlayerProfile } from "./es.js";

type SeasonType = "regular" | "playoffs";
// Aggregation responses are deeply dynamic; keep them loosely typed.
type Agg = any;

const round = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
const ratio = (num: number, den: number, d = 3) => (den > 0 ? round(num / den, d) : null);

function seasonFilters(seasonType?: SeasonType, from?: number, to?: number) {
  const filters: object[] = [];
  if (seasonType) filters.push({ term: { season_type: seasonType } });
  if (from != null || to != null) filters.push({ range: { season: { gte: from, lte: to } } });
  return filters;
}

const label = (season: number) => `${season}-${String(season + 1).slice(-2)}`;

// ------------------------------------------------------------ career / span

const TOTALS = ["min", "pts", "reb", "oreb", "dreb", "ast", "stl", "blk", "tov", "fgm", "fga", "fg3m", "fg3a", "ftm", "fta"] as const;
const WEIGHTED = ["usg_pct", "net_rating", "off_rating", "def_rating", "pie"] as const;

export interface SeasonPoint {
  season: number;
  season_label: string;
  team: string | null;
  gp: number | null;
  pts: number | null;
  reb: number | null;
  ast: number | null;
  ts_pct: number | null;
}

export interface CareerLine {
  gp: number;
  seasons: number;
  span: string | null;
  mpg: number | null;
  ppg: number | null;
  rpg: number | null;
  apg: number | null;
  spg: number | null;
  bpg: number | null;
  tpg: number | null;
  fg_pct: number | null;
  fg3_pct: number | null;
  ft_pct: number | null;
  ts_pct: number | null;
  usg_pct: number | null;
  net_rating: number | null;
  off_rating: number | null;
  def_rating: number | null;
  pie: number | null;
  total_pts: number | null;
  total_reb: number | null;
  total_ast: number | null;
  best_season: { season_label: string; team: string | null; ppg: number | null; rpg: number | null; apg: number | null } | null;
}

export interface PlayerComparisonSide {
  profile: PlayerProfile;
  career: CareerLine | null;
  series: SeasonPoint[];
}

export async function compareCareers(
  a: PlayerProfile,
  b: PlayerProfile,
  seasonType: SeasonType,
  from?: number,
  to?: number,
): Promise<{ a: PlayerComparisonSide; b: PlayerComparisonSide; edges: Record<string, "a" | "b" | "tie"> }> {
  const sums = Object.fromEntries(TOTALS.map((f) => [f, { sum: { field: `${f}_total` } }]));
  const weighted = Object.fromEntries(
    WEIGHTED.map((f) => [f, { weighted_avg: { value: { field: f }, weight: { field: "gp" } } }]),
  );
  const res = await es().search({
    index: INDEX.seasons,
    size: 200,
    sort: [{ season: "asc" }],
    _source: ["player_id", "season", "season_label", "team_abbreviation", "gp", "pts", "reb", "ast", "ts_pct"],
    query: {
      bool: { filter: [{ terms: { player_id: [a.player_id, b.player_id] } }, ...seasonFilters(seasonType, from, to)] },
    },
    aggs: {
      players: {
        terms: { field: "player_id", size: 2 },
        aggs: {
          gp: { sum: { field: "gp" } },
          first: { min: { field: "season" } },
          last: { max: { field: "season" } },
          ...sums,
          ...weighted,
          best: {
            filter: { range: { gp: { gte: seasonType === "playoffs" ? 5 : 20 } } },
            aggs: {
              top: {
                top_hits: {
                  size: 1,
                  sort: [{ pts: "desc" }],
                  _source: ["season_label", "team_abbreviation", "pts", "reb", "ast"],
                },
              },
            },
          },
        },
      },
    } as Agg,
  });

  const buckets: Agg[] = (res.aggregations as Agg)?.players?.buckets ?? [];
  const career = (id: number): CareerLine | null => {
    const bkt = buckets.find((x) => x.key === id);
    if (!bkt) return null;
    const gp = bkt.gp.value as number;
    const t = (f: string) => bkt[f].value as number;
    const best = bkt.best.top.hits.hits[0]?._source;
    return {
      gp,
      seasons: bkt.doc_count,
      span: bkt.first.value != null ? `${label(bkt.first.value)} – ${label(bkt.last.value)}` : null,
      mpg: ratio(t("min"), gp, 1),
      ppg: ratio(t("pts"), gp, 1),
      rpg: ratio(t("reb"), gp, 1),
      apg: ratio(t("ast"), gp, 1),
      spg: ratio(t("stl"), gp, 1),
      bpg: ratio(t("blk"), gp, 1),
      tpg: ratio(t("tov"), gp, 1),
      fg_pct: ratio(t("fgm"), t("fga")),
      fg3_pct: ratio(t("fg3m"), t("fg3a")),
      ft_pct: ratio(t("ftm"), t("fta")),
      ts_pct: ratio(t("pts"), 2 * (t("fga") + 0.44 * t("fta"))),
      usg_pct: round(bkt.usg_pct.value, 3),
      net_rating: round(bkt.net_rating.value),
      off_rating: round(bkt.off_rating.value),
      def_rating: round(bkt.def_rating.value),
      pie: round(bkt.pie.value, 3),
      total_pts: round(t("pts"), 0),
      total_reb: round(t("reb"), 0),
      total_ast: round(t("ast"), 0),
      best_season: best
        ? { season_label: best.season_label, team: best.team_abbreviation ?? null, ppg: round(best.pts), rpg: round(best.reb), apg: round(best.ast) }
        : null,
    };
  };

  const series = (id: number): SeasonPoint[] =>
    res.hits.hits
      .map((h) => h._source as Agg)
      .filter((s) => s.player_id === id)
      .map((s) => ({
        season: s.season,
        season_label: s.season_label,
        team: s.team_abbreviation ?? null,
        gp: s.gp ?? null,
        pts: round(s.pts),
        reb: round(s.reb),
        ast: round(s.ast),
        ts_pct: round(s.ts_pct, 3),
      }));

  const ca = career(a.player_id);
  const cb = career(b.player_id);
  const edges: Record<string, "a" | "b" | "tie"> = {};
  if (ca && cb) {
    const higher = ["ppg", "rpg", "apg", "spg", "bpg", "fg_pct", "fg3_pct", "ft_pct", "ts_pct", "net_rating", "pie", "off_rating"] as const;
    const lower = ["tpg", "def_rating"] as const;
    for (const k of higher) {
      const [x, y] = [ca[k], cb[k]];
      if (x != null && y != null) edges[k] = x === y ? "tie" : x > y ? "a" : "b";
    }
    for (const k of lower) {
      const [x, y] = [ca[k], cb[k]];
      if (x != null && y != null) edges[k] = x === y ? "tie" : x < y ? "a" : "b";
    }
  }

  return {
    a: { profile: a, career: ca, series: series(a.player_id) },
    b: { profile: b, career: cb, series: series(b.player_id) },
    edges,
  };
}

// -------------------------------------------------------- season by season

export async function playerSeasons(p: PlayerProfile, seasonType: SeasonType) {
  const res = await es().search({
    index: INDEX.seasons,
    size: 100,
    sort: [{ season: "asc" }],
    _source: [
      "season_label", "team_abbreviation", "age", "gp", "min", "pts", "reb", "ast", "stl", "blk", "tov",
      "fg_pct", "fg3_pct", "ft_pct", "ts_pct", "usg_pct", "net_rating", "pie",
    ],
    query: { bool: { filter: [{ term: { player_id: p.player_id } }, ...seasonFilters(seasonType)] } },
  });
  return res.hits.hits.map((h) => {
    const s = h._source as Agg;
    return Object.fromEntries(
      Object.entries(s).map(([k, v]) => [k, typeof v === "number" ? round(v, k.endsWith("pct") || k === "pie" ? 3 : 1) : v]),
    );
  });
}

// --------------------------------------------------------- game-level splits

export type SplitBy = "home_away" | "result" | "opponent" | "month" | "season";

const GAME_METRICS = {
  pts: { avg: { field: "pts" } },
  reb: { avg: { field: "reb" } },
  ast: { avg: { field: "ast" } },
  stl: { avg: { field: "stl" } },
  blk: { avg: { field: "blk" } },
  tov: { avg: { field: "tov" } },
  min: { avg: { field: "min" } },
  plus_minus: { avg: { field: "plus_minus" } },
  game_score: { avg: { field: "game_score" } },
  fgm: { sum: { field: "fgm" } },
  fga: { sum: { field: "fga" } },
  fg3m: { sum: { field: "fg3m" } },
  fg3a: { sum: { field: "fg3a" } },
  ftm: { sum: { field: "ftm" } },
  fta: { sum: { field: "fta" } },
  sum_pts: { sum: { field: "pts" } },
  wins: { filter: { term: { result: "W" } } },
};

function gameLine(b: Agg) {
  return {
    games: b.doc_count as number,
    wins: b.wins.doc_count as number,
    ppg: round(b.pts.value),
    rpg: round(b.reb.value),
    apg: round(b.ast.value),
    spg: round(b.stl.value),
    bpg: round(b.blk.value),
    tpg: round(b.tov.value),
    mpg: round(b.min.value),
    plus_minus: round(b.plus_minus.value),
    game_score: round(b.game_score.value),
    fg_pct: ratio(b.fgm.value, b.fga.value),
    fg3_pct: ratio(b.fg3m.value, b.fg3a.value),
    ft_pct: ratio(b.ftm.value, b.fta.value),
    ts_pct: ratio(b.sum_pts.value, 2 * (b.fga.value + 0.44 * b.fta.value)),
  };
}

function splitAgg(splitBy: SplitBy): Agg {
  switch (splitBy) {
    case "home_away":
      return { terms: { field: "is_home", size: 2 } };
    case "result":
      return { terms: { field: "result", size: 2 } };
    case "opponent":
      return { terms: { field: "opponent_abbreviation", size: 40, order: { _key: "asc" } } };
    case "month":
      return { terms: { field: "month", size: 12 } };
    case "season":
      return { terms: { field: "season", size: 50, order: { _key: "asc" } } };
  }
}

function splitKey(splitBy: SplitBy, b: Agg): string {
  if (splitBy === "home_away") return b.key === 1 || b.key_as_string === "true" ? "home" : "away";
  if (splitBy === "season") return label(Number(b.key));
  return String(b.key);
}

export async function gameSplits(
  players: PlayerProfile[],
  splitBy: SplitBy,
  opts: { seasonType?: SeasonType; from?: number; to?: number; opponent?: string },
) {
  const filter: object[] = [{ terms: { player_id: players.map((p) => p.player_id) } }, ...seasonFilters(opts.seasonType, opts.from, opts.to)];
  if (opts.opponent) filter.push({ term: { opponent_abbreviation: opts.opponent.toUpperCase() } });

  const res = await es().search({
    index: INDEX.games,
    size: 0,
    // Runtime field: month name derived from game_date at query time, no reindex needed.
    runtime_mappings: {
      month: { type: "keyword", script: { source: "emit(doc['game_date'].value.getMonth().toString())" } },
    },
    query: { bool: { filter } },
    aggs: {
      players: {
        terms: { field: "player_id", size: players.length },
        aggs: {
          overall: { filter: { match_all: {} }, aggs: GAME_METRICS },
          range: { stats: { field: "season" } },
          split: { ...splitAgg(splitBy), aggs: GAME_METRICS },
        },
      },
    } as Agg,
  });

  const buckets: Agg[] = (res.aggregations as Agg)?.players?.buckets ?? [];
  return players.map((p) => {
    const b = buckets.find((x) => x.key === p.player_id);
    if (!b) return { player: p.full_name, games: 0, note: "No box scores on file for this filter." };
    return {
      player: p.full_name,
      seasons_covered: b.range.count ? `${label(b.range.min)} – ${label(b.range.max)}` : null,
      overall: gameLine(b.overall),
      splits: Object.fromEntries(b.split.buckets.map((s: Agg) => [splitKey(splitBy, s), gameLine(s)])),
    };
  });
}

// ------------------------------------------------------------ milestones

export type GameStat = "pts" | "reb" | "ast" | "stl" | "blk" | "fg3m" | "game_score" | "plus_minus";

export async function milestones(
  players: PlayerProfile[],
  stat: GameStat,
  threshold: number,
  opts: { seasonType?: SeasonType; from?: number; to?: number },
) {
  const res = await es().search({
    index: INDEX.games,
    size: 0,
    query: { bool: { filter: [{ terms: { player_id: players.map((p) => p.player_id) } }, ...seasonFilters(opts.seasonType, opts.from, opts.to)] } },
    aggs: {
      players: {
        terms: { field: "player_id", size: players.length },
        aggs: {
          range: { stats: { field: "season" } },
          hit: {
            filter: { range: { [stat]: { gte: threshold } } },
            aggs: {
              wins: { filter: { term: { result: "W" } } },
              top: {
                top_hits: {
                  size: 5,
                  sort: [{ [stat]: "desc" }, { game_date: "desc" }],
                  _source: ["game_date", "season_type", "team_abbreviation", "opponent_abbreviation", "result", "pts", "reb", "ast", "stl", "blk", "fg3m", "min", "team_score", "opp_score"],
                },
              },
            },
          },
          triple_doubles: { filter: { term: { triple_double: true } } },
          double_doubles: { filter: { term: { double_double: true } } },
          max: { max: { field: stat } },
        },
      },
    } as Agg,
  });

  const buckets: Agg[] = (res.aggregations as Agg)?.players?.buckets ?? [];
  return players.map((p) => {
    const b = buckets.find((x) => x.key === p.player_id);
    if (!b) return { player: p.full_name, games: 0, note: "No box scores on file for this filter." };
    return {
      player: p.full_name,
      seasons_covered: `${label(b.range.min)} – ${label(b.range.max)}`,
      games: b.doc_count,
      [`games_with_${stat}_gte_${threshold}`]: b.hit.doc_count,
      rate: ratio(b.hit.doc_count, b.doc_count),
      team_record_in_those_games: `${b.hit.wins.doc_count}-${b.hit.doc_count - b.hit.wins.doc_count}`,
      career_high_in_window: b.max.value,
      triple_doubles: b.triple_doubles.doc_count,
      double_doubles: b.double_doubles.doc_count,
      top_games: b.hit.top.hits.hits.map((h: Agg) => h._source),
    };
  });
}

// ----------------------------------------------------------- head to head

export async function headToHead(a: PlayerProfile, b: PlayerProfile, seasonType?: SeasonType, limit = 10) {
  const res = await es().search({
    index: INDEX.games,
    size: 0,
    query: { bool: { filter: [{ terms: { player_id: [a.player_id, b.player_id] } }, ...seasonFilters(seasonType)] } },
    aggs: {
      // Games where both players logged minutes = buckets with 2 docs.
      games: {
        terms: { field: "game_id", size: 1000, shard_size: 20000, min_doc_count: 2, order: { last: "desc" } },
        aggs: {
          last: { max: { field: "game_date" } },
          rows: {
            top_hits: {
              size: 2,
              _source: ["player_id", "game_date", "season_type", "team_abbreviation", "opponent_abbreviation", "result", "pts", "reb", "ast", "stl", "blk", "fgm", "fga", "fg3m", "game_score", "team_score", "opp_score"],
            },
          },
        },
      },
    } as Agg,
  });

  const meetings: Agg[] = [];
  for (const g of (res.aggregations as Agg)?.games?.buckets ?? []) {
    const rows = g.rows.hits.hits.map((h: Agg) => h._source);
    const ra = rows.find((r: Agg) => r.player_id === a.player_id);
    const rb = rows.find((r: Agg) => r.player_id === b.player_id);
    if (!ra || !rb || ra.team_abbreviation === rb.team_abbreviation) continue; // teammates, not opponents
    meetings.push({ ra, rb });
  }

  const summarize = (side: "ra" | "rb") => {
    const rows = meetings.map((m) => m[side]);
    const n = rows.length || 1;
    const sum = (f: string) => rows.reduce((acc: number, r: Agg) => acc + (r[f] ?? 0), 0);
    return {
      wins: rows.filter((r: Agg) => r.result === "W").length,
      ppg: round(sum("pts") / n),
      rpg: round(sum("reb") / n),
      apg: round(sum("ast") / n),
      fg_pct: ratio(sum("fgm"), sum("fga")),
      avg_game_score: round(sum("game_score") / n),
      best_game_pts: rows.length ? Math.max(...rows.map((r: Agg) => r.pts)) : null,
    };
  };

  return {
    meetings: meetings.length,
    [a.full_name]: summarize("ra"),
    [b.full_name]: summarize("rb"),
    recent_meetings: meetings.slice(0, limit).map(({ ra, rb }) => ({
      date: ra.game_date,
      type: ra.season_type,
      matchup: `${ra.team_abbreviation} vs ${rb.team_abbreviation}`,
      score: ra.team_score != null ? `${ra.team_score}-${ra.opp_score}` : null,
      winner: ra.result === "W" ? ra.team_abbreviation : rb.team_abbreviation,
      [a.full_name]: `${ra.pts} pts / ${ra.reb} reb / ${ra.ast} ast`,
      [b.full_name]: `${rb.pts} pts / ${rb.reb} reb / ${rb.ast} ast`,
    })),
  };
}

// --------------------------------------------------------- league leaders

export type SeasonStat =
  | "pts" | "reb" | "ast" | "stl" | "blk" | "tov" | "min" | "fg3m" | "fg_pct" | "fg3_pct" | "ft_pct"
  | "ts_pct" | "efg_pct" | "usg_pct" | "net_rating" | "off_rating" | "def_rating" | "pie" | "plus_minus" | "dd2" | "td3";

// Volume qualifiers so efficiency leaderboards aren't won by low-usage players.
const QUALIFIERS: Partial<Record<SeasonStat, object>> = {
  fg_pct: { range: { fga: { gte: 5 } } },
  ts_pct: { range: { fga: { gte: 8 } } },
  efg_pct: { range: { fga: { gte: 8 } } },
  fg3_pct: { range: { fg3a: { gte: 3 } } },
  ft_pct: { range: { fta: { gte: 2 } } },
};

export async function leagueLeaders(stat: SeasonStat, season: number, seasonType: SeasonType, minGames: number, minMinutes: number, size: number) {
  const ascending = stat === "def_rating" || stat === "tov";
  const qualifier = QUALIFIERS[stat];
  const res = await es().search({
    index: INDEX.seasons,
    size,
    sort: [{ [stat]: { order: ascending ? "asc" : "desc", missing: "_last" } }],
    _source: ["player_name", "team_abbreviation", "gp", stat],
    query: {
      bool: {
        filter: [
          { term: { season } },
          { term: { season_type: seasonType } },
          { range: { gp: { gte: minGames } } },
          { range: { min: { gte: minMinutes } } },
          { exists: { field: stat } },
          ...(qualifier ? [qualifier] : []),
        ],
      },
    },
  });
  return res.hits.hits.map((h, i) => {
    const s = h._source as Agg;
    return { rank: i + 1, player: s.player_name, team: s.team_abbreviation, gp: s.gp, [stat]: round(s[stat], 3) };
  });
}

// --------------------------------------------------------------- articles

export interface ArticleHit {
  title: string;
  url: string;
  source: string;
  published_at: string;
  summary: string;
  players_mentioned: string[];
  highlights?: string[];
  score?: number;
}

const ARTICLE_FIELDS = ["title", "url", "source", "published_at", "summary", "players_mentioned", "teams_mentioned"];

function articleFilters(opts: { players?: string[]; allPlayers?: boolean; days?: number; team?: string }) {
  const filter: object[] = [];
  if (opts.players?.length) {
    if (opts.allPlayers) opts.players.forEach((p) => filter.push({ term: { players_mentioned: p } }));
    else filter.push({ terms: { players_mentioned: opts.players } });
  }
  if (opts.team) filter.push({ term: { teams_mentioned: opts.team.toUpperCase() } });
  if (opts.days) filter.push({ range: { published_at: { gte: `now-${opts.days}d/d` } } });
  return filter;
}

/** Hybrid search: lexical BM25 + semantic_text (ELSER) retrievers fused with Reciprocal Rank Fusion. */
export async function searchArticles(opts: {
  query: string;
  players?: string[];
  allPlayers?: boolean;
  team?: string;
  days?: number;
  size?: number;
}): Promise<ArticleHit[]> {
  const filter = articleFilters(opts);
  const request: Agg = {
    index: INDEX.articles,
    size: opts.size ?? 5,
    _source: ARTICLE_FIELDS,
    retriever: {
      rrf: {
        retrievers: [
          {
            standard: {
              query: { bool: { must: { multi_match: { query: opts.query, fields: ["title^3", "summary^2", "body"] } }, filter } },
            },
          },
          {
            standard: {
              query: { bool: { must: { semantic: { field: "semantic_content", query: opts.query } }, filter } },
            },
          },
        ],
        rank_window_size: 50,
        rank_constant: 20,
      },
    },
    highlight: { fields: { semantic_content: { type: "semantic", number_of_fragments: 2, order: "score" } } },
  };

  let res: Agg;
  try {
    res = await es().search(request);
  } catch {
    // Older clusters may not support semantic highlighting; retry without it.
    delete request.highlight;
    res = await es().search(request);
  }

  return res.hits.hits.map((h: Agg) => ({
    title: h._source.title,
    url: h._source.url,
    source: h._source.source,
    published_at: h._source.published_at,
    summary: h._source.summary,
    players_mentioned: h._source.players_mentioned ?? [],
    highlights: (h.highlight?.semantic_content ?? []).map((s: string) => s.slice(0, 400)),
    score: round(h._score, 4) ?? undefined,
  }));
}

export async function newsComparison(a: PlayerProfile, b: PlayerProfile, topic: string | undefined, days: number | undefined, size: number) {
  const [na, nb] = [a.full_name, b.full_name];
  const [aHits, bHits, both, counts] = await Promise.all([
    searchArticles({ query: topic ?? `${na} performance and outlook`, players: [na], days, size }),
    searchArticles({ query: topic ?? `${nb} performance and outlook`, players: [nb], days, size }),
    searchArticles({ query: topic ?? `${na} ${nb}`, players: [na, nb], allPlayers: true, days, size: 3 }),
    es().search({
      index: INDEX.articles,
      size: 0,
      query: { bool: { filter: articleFilters({ days }) } },
      aggs: {
        mentions: {
          filters: {
            filters: {
              a: { term: { players_mentioned: na } },
              b: { term: { players_mentioned: nb } },
              both: { bool: { filter: [{ term: { players_mentioned: na } }, { term: { players_mentioned: nb } }] } },
            },
          },
          aggs: { sources: { terms: { field: "source", size: 10 } }, latest: { max: { field: "published_at" } } },
        },
      } as Agg,
    }),
  ]);

  const m = (counts.aggregations as Agg).mentions.buckets;
  const coverage = (k: "a" | "b" | "both") => ({
    articles: m[k].doc_count,
    latest: m[k].latest.value_as_string ?? null,
    by_source: Object.fromEntries(m[k].sources.buckets.map((s: Agg) => [s.key, s.doc_count])),
  });

  return {
    topic: topic ?? null,
    window_days: days ?? "all",
    coverage: { [na]: coverage("a"), [nb]: coverage("b"), both: coverage("both") },
    [na]: aHits,
    [nb]: bHits,
    mentioned_together: both,
  };
}
