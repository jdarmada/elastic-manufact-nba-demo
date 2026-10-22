/**
 * Next-game projections built from Elasticsearch data: upcoming schedule, recent form,
 * season averages, history vs the opponent, opponent defense, venue and rest.
 * Deliberately simple and transparent so the model can explain every component.
 */
import { es, INDEX, type PlayerProfile } from "./es.js";

// Aggregation/search responses are dynamic; keep them loosely typed.
type Any = any;

export type ProjStat = "pts" | "reb" | "ast" | "fg3m" | "stl" | "blk" | "pra";
const BASE_STATS = ["pts", "reb", "ast", "fg3m", "stl", "blk"] as const;

export const currentSeason = () => {
  const now = new Date();
  return now.getUTCMonth() >= 9 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
};

const round = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const stdev = (xs: number[]) => {
  const m = mean(xs);
  if (m == null || xs.length < 2) return null;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
const statOf = (g: Any, stat: ProjStat) => (stat === "pra" ? g.pts + g.reb + g.ast : g[stat]);

// Standard normal CDF (Abramowitz-Stegun approximation).
function phi(z: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

// ------------------------------------------------------------ schedule

export interface ScheduledGame {
  game_id: number;
  date: string;
  datetime: string | null;
  home: boolean;
  opponent: string;
  opponent_name: string | null;
  postseason: boolean;
}

/** The player's team right now: latest current-season box score, else the roster team. */
export async function currentTeam(p: PlayerProfile): Promise<string | null> {
  const res = await es().search({
    index: INDEX.games,
    size: 1,
    sort: [{ game_date: "desc" }],
    _source: ["team_abbreviation", "season"],
    query: { bool: { filter: [{ term: { player_id: p.player_id } }, { term: { season: currentSeason() } }] } },
  });
  return (res.hits.hits[0]?._source as Any)?.team_abbreviation ?? p.team_abbreviation ?? null;
}

export async function upcomingGames(team: string, limit: number): Promise<ScheduledGame[]> {
  const res = await es().search({
    index: INDEX.schedule,
    size: limit,
    sort: [{ datetime: "asc" }, { date: "asc" }],
    query: {
      bool: {
        filter: [
          { term: { teams: team } },
          { range: { date: { gte: "now-1d/d" } } },
        ],
        must_not: [{ term: { status_state: "final" } }, { term: { postponed: true } }],
      },
    },
  });
  return res.hits.hits.map((h) => {
    const g = h._source as Any;
    const home = g.home_team === team;
    return {
      game_id: g.game_id,
      date: g.date,
      datetime: g.datetime ?? null,
      home,
      opponent: home ? g.visitor_team : g.home_team,
      opponent_name: home ? g.visitor_team_name : g.home_team_name,
      postseason: g.postseason,
    };
  });
}

// ------------------------------------------------------- opponent defense

export interface DefenseRow {
  team: string;
  allowed_per_game: Record<string, number | null>;
  factor: Record<string, number | null>;
  rank: Record<string, number>; // 1 = stingiest
}

let defenseCache: { at: number; table: Map<string, DefenseRow> } | undefined;

/** Stats allowed per game by each team (to all opposing players), current + previous season. */
export async function defenseTable(): Promise<Map<string, DefenseRow>> {
  if (defenseCache && Date.now() - defenseCache.at < 30 * 60_000) return defenseCache.table;
  const cur = currentSeason();
  const sums = Object.fromEntries(BASE_STATS.map((s) => [s, { sum: { field: s } }]));
  const res = await es().search({
    index: INDEX.games,
    size: 0,
    query: { bool: { filter: [{ range: { season: { gte: cur - 1 } } }, { term: { season_type: "regular" } }] } },
    aggs: {
      teams: {
        terms: { field: "opponent_abbreviation", size: 40 },
        aggs: { games: { cardinality: { field: "game_id", precision_threshold: 10000 } }, ...sums },
      },
    } as Any,
  });
  const buckets: Any[] = (res.aggregations as Any).teams.buckets;
  const rows = buckets.map((b) => {
    const allowed: Record<string, number> = {};
    for (const s of BASE_STATS) allowed[s] = b[s].value / Math.max(1, b.games.value);
    allowed.pra = allowed.pts + allowed.reb + allowed.ast;
    return { team: b.key as string, allowed };
  });
  const stats = [...BASE_STATS, "pra"];
  const league: Record<string, number> = {};
  for (const s of stats) league[s] = mean(rows.map((r) => r.allowed[s])) ?? 1;

  const table = new Map<string, DefenseRow>();
  for (const r of rows) {
    const rank: Record<string, number> = {};
    for (const s of stats) rank[s] = 1 + rows.filter((o) => o.allowed[s] < r.allowed[s]).length;
    table.set(r.team, {
      team: r.team,
      allowed_per_game: Object.fromEntries(stats.map((s) => [s, round(r.allowed[s])])),
      factor: Object.fromEntries(stats.map((s) => [s, round(r.allowed[s] / league[s], 3)])),
      rank,
    });
  }
  defenseCache = { at: Date.now(), table };
  return table;
}

// --------------------------------------------------------- player inputs

async function recentGames(p: PlayerProfile, size = 100): Promise<Any[]> {
  const res = await es().search({
    index: INDEX.games,
    size,
    sort: [{ game_date: "desc" }],
    _source: ["game_date", "season", "season_type", "team_abbreviation", "opponent_abbreviation", "is_home", "result", "min", ...BASE_STATS],
    query: { bool: { filter: [{ term: { player_id: p.player_id } }, { range: { season: { gte: currentSeason() - 1 } } }] } },
  });
  return res.hits.hits.map((h) => h._source);
}

export async function gamesVsTeam(p: PlayerProfile, team: string, seasonsBack = 5, size = 50): Promise<Any[]> {
  const res = await es().search({
    index: INDEX.games,
    size,
    sort: [{ game_date: "desc" }],
    _source: ["game_date", "season", "season_type", "team_abbreviation", "opponent_abbreviation", "is_home", "result", "min", "team_score", "opp_score", ...BASE_STATS, "fgm", "fga", "fg3a"],
    query: {
      bool: {
        filter: [
          { term: { player_id: p.player_id } },
          { term: { opponent_abbreviation: team.toUpperCase() } },
          { range: { season: { gte: currentSeason() - seasonsBack + 1 } } },
        ],
      },
    },
  });
  return res.hits.hits.map((h) => h._source);
}

async function injuryFor(p: PlayerProfile) {
  const res = await es().search({
    index: INDEX.injuries,
    size: 1,
    query: { term: { player_id: p.player_id } },
  });
  const i = res.hits.hits[0]?._source as Any;
  return i ? { status: i.status as string, return_date: i.return_date ?? null, note: (i.description ?? "").slice(0, 300) } : null;
}

// ------------------------------------------------------------ projection

export interface Projection {
  player: string;
  team: string | null;
  stat: ProjStat;
  next_game: (ScheduledGame & { days_rest: number | null }) | null;
  injury: { status: string; return_date: string | null; note: string } | null;
  likely_out: boolean;
  projection: number | null;
  range: [number, number] | null;
  components: {
    last_10_avg: number | null;
    season_avg: number | null;
    season_games: number;
    vs_opponent_avg: number | null;
    vs_opponent_games: number;
    opponent_defense_rank: number | null;
    opponent_allowed_factor: number | null;
    venue_avg: number | null;
    back_to_back: boolean;
  };
  recent_games: { date: string; opponent: string; value: number }[];
  note?: string;
}

export async function projectNextGame(p: PlayerProfile, stat: ProjStat): Promise<Projection> {
  const cur = currentSeason();
  const [team, games, injury, defense] = await Promise.all([currentTeam(p), recentGames(p), injuryFor(p), defenseTable()]);
  const base: Projection = {
    player: p.full_name,
    team,
    stat,
    next_game: null,
    injury,
    likely_out: /^out/i.test(injury?.status ?? ""),
    projection: null,
    range: null,
    components: {
      last_10_avg: null, season_avg: null, season_games: 0, vs_opponent_avg: null, vs_opponent_games: 0,
      opponent_defense_rank: null, opponent_allowed_factor: null, venue_avg: null, back_to_back: false,
    },
    recent_games: [],
  };
  if (!team) return { ...base, note: "Could not determine the player's current team." };

  const [next] = await upcomingGames(team, 1);
  const lastPlayed = games[0]?.game_date ? new Date(games[0].game_date) : null;
  const daysRest = next && lastPlayed ? Math.round((new Date(next.date).getTime() - lastPlayed.getTime()) / 86_400_000) : null;
  base.next_game = next ? { ...next, days_rest: daysRest } : null;
  if (!next) return { ...base, note: `No upcoming games found for ${team}.` };
  if (!games.length) return { ...base, note: "No box scores in the last two seasons to project from." };

  const values = games.map((g) => statOf(g, stat));
  const last10 = mean(values.slice(0, 10))!;
  const thisSeason = games.filter((g) => g.season === cur).map((g) => statOf(g, stat));
  const lastSeason = games.filter((g) => g.season === cur - 1).map((g) => statOf(g, stat));
  // Early in the season, shrink the small current sample toward last season.
  const prior = mean(lastSeason) ?? last10;
  const seasonAvg = (thisSeason.reduce((a, b) => a + b, 0) + 10 * prior) / (thisSeason.length + 10);

  const vsOpp = (await gamesVsTeam(p, next.opponent, 4, 20)).map((g) => statOf(g, stat));
  const vsAvg = mean(vsOpp);
  const w = vsAvg == null ? 0 : (Math.min(vsOpp.length, 10) / 10) * 0.2;
  let projection = (0.45 * last10 + 0.55 * seasonAvg) * (1 - w) + (vsAvg ?? 0) * w;

  const d = defense.get(next.opponent);
  const factor = d?.factor[stat] ?? null;
  if (factor) projection *= 1 + 0.5 * (factor - 1);

  const venueVals = games.filter((g) => g.is_home === next.home).map((g) => statOf(g, stat));
  const venueAvg = mean(venueVals);
  const overall = mean(values)!;
  if (venueAvg != null && overall > 0 && venueVals.length >= 10) projection *= 1 + 0.5 * (venueAvg / overall - 1);

  const b2b = daysRest === 1;
  if (b2b) projection *= 0.97;

  const sd = Math.max(stdev(values.slice(0, 30)) ?? 0, projection * 0.15, 1);
  return {
    ...base,
    projection: round(projection)!,
    range: [round(Math.max(0, projection - sd))!, round(projection + sd)!],
    components: {
      last_10_avg: round(last10),
      season_avg: round(seasonAvg),
      season_games: thisSeason.length,
      vs_opponent_avg: round(vsAvg),
      vs_opponent_games: vsOpp.length,
      opponent_defense_rank: d?.rank[stat] ?? null,
      opponent_allowed_factor: factor,
      venue_avg: round(venueAvg),
      back_to_back: b2b,
    },
    recent_games: games.slice(0, 5).map((g) => ({ date: g.game_date, opponent: g.opponent_abbreviation, value: statOf(g, stat) })),
  };
}

/** P(a's stat > b's stat) under independent normal approximations. */
export function probabilityAOverB(a: Projection, b: Projection): number | null {
  if (a.projection == null || b.projection == null || !a.range || !b.range) return null;
  const sdA = a.range[1] - a.projection;
  const sdB = b.range[1] - b.projection;
  return round(phi((a.projection - b.projection) / Math.sqrt(sdA ** 2 + sdB ** 2)), 3);
}

// --------------------------------------------------------- vs-team summary

export async function playerVsTeam(p: PlayerProfile, team: string, seasonsBack: number, limit: number) {
  const games = await gamesVsTeam(p, team, seasonsBack, 200);
  if (!games.length) return { player: p.full_name, opponent: team.toUpperCase(), games: 0, note: "No games vs this team in the box-score window." };
  const avg = (f: string) => round(mean(games.map((g) => g[f] ?? 0)));
  const sum = (f: string) => games.reduce((a, g) => a + (g[f] ?? 0), 0);
  const recent = await recentGames(p, 82);
  const overall = (f: string) => round(mean(recent.map((g) => g[f] ?? 0)));
  return {
    player: p.full_name,
    opponent: team.toUpperCase(),
    games: games.length,
    record: `${games.filter((g) => g.result === "W").length}-${games.filter((g) => g.result === "L").length}`,
    averages: { pts: avg("pts"), reb: avg("reb"), ast: avg("ast"), fg3m: avg("fg3m"), stl: avg("stl"), blk: avg("blk"), min: avg("min") },
    fg_pct: sum("fga") ? round(sum("fgm") / sum("fga"), 3) : null,
    compared_to_recent_overall: { pts: overall("pts"), reb: overall("reb"), ast: overall("ast") },
    best_game: games.reduce((best, g) => (g.pts > (best?.pts ?? -1) ? g : best), null as Any),
    game_log: games.slice(0, limit),
  };
}
