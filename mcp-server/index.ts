import { MCPServer } from "mcp-use";
import { z } from "zod";

import { findPlayers, resolvePlayer } from "./src/es.js";
import {
  compareCareers,
  gameSplits,
  headToHead,
  leagueLeaders,
  milestones,
  newsComparison,
  playerSeasons,
  searchArticles,
} from "./src/queries.js";

const server = new MCPServer({
  name: "nba-player-compare",
  title: "NBA Player Compare (Elastic × Manufact)",
  version: "1.0.0",
  description:
    "Compare NBA players with stats and news stored in Elasticsearch: career aggregations, game splits, head-to-head matchups and hybrid search over recent articles.",
  instructions: [
    "Use these tools to compare NBA players with data stored in Elasticsearch.",
    "Start with compare_players for a side-by-side view, then drill in with game_splits, milestone_games, head_to_head, player_seasons and league_leaders.",
    "Use compare_player_news or search_nba_news for recent storylines (injuries, trades, form); cite article titles and URLs.",
    "Season averages cover 1996-97 onward; box scores cover the most recent seasons loaded.",
    "Seasons are identified by start year (2024 = the 2024-25 season).",
  ].join(" "),
  websiteUrl: "https://www.elastic.co",
  icons: [{ src: "icon.svg", mimeType: "image/svg+xml", sizes: ["512x512"] }],
});

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (err: unknown) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
});

const playerArg = (which: string) => z.string().min(2).describe(`${which} player's name (fuzzy, e.g. "Steph Curry") or balldontlie player id`);
const seasonType = z.enum(["regular", "playoffs"]).default("regular").describe("Regular season or playoffs");
const fromSeason = z.number().int().min(1946).optional().describe("First season start year to include, e.g. 2015 for 2015-16");
const toSeason = z.number().int().min(1946).optional().describe("Last season start year to include");

// ---------------------------------------------------------------- find_player

export const findPlayer = server.tool(
  {
    name: "find_player",
    title: "Find player",
    description: "Fuzzy-search NBA players by name. Use to disambiguate names before comparing.",
    inputSchema: z.object({
      name: z.string().min(2).describe("Full or partial player name; typos are tolerated"),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    annotations: readOnly,
  },
  async ({ name, limit }) => {
    try {
      return json(await findPlayers(name, limit));
    } catch (err) {
      return fail(err);
    }
  },
);

// ------------------------------------------------------------- compare_players

const careerLine = z
  .object({
    gp: z.number(),
    seasons: z.number(),
    span: z.string().nullable(),
    mpg: z.number().nullable(),
    ppg: z.number().nullable(),
    rpg: z.number().nullable(),
    apg: z.number().nullable(),
    spg: z.number().nullable(),
    bpg: z.number().nullable(),
    tpg: z.number().nullable(),
    fg_pct: z.number().nullable(),
    fg3_pct: z.number().nullable(),
    ft_pct: z.number().nullable(),
    ts_pct: z.number().nullable(),
    usg_pct: z.number().nullable(),
    net_rating: z.number().nullable(),
    off_rating: z.number().nullable(),
    def_rating: z.number().nullable(),
    pie: z.number().nullable(),
    total_pts: z.number().nullable(),
    total_reb: z.number().nullable(),
    total_ast: z.number().nullable(),
    best_season: z
      .object({
        season_label: z.string(),
        team: z.string().nullable(),
        ppg: z.number().nullable(),
        rpg: z.number().nullable(),
        apg: z.number().nullable(),
      })
      .nullable(),
  })
  .nullable();

const comparisonSide = z.object({
  profile: z.object({
    player_id: z.number(),
    full_name: z.string(),
    position: z.string().nullish(),
    height: z.string().nullish(),
    team_abbreviation: z.string().nullish(),
    team_name: z.string().nullish(),
    draft_year: z.number().nullish(),
    draft_number: z.number().nullish(),
    is_active: z.boolean().nullish(),
  }).passthrough(),
  career: careerLine,
  series: z.array(
    z.object({
      season: z.number(),
      season_label: z.string(),
      team: z.string().nullable(),
      gp: z.number().nullable(),
      pts: z.number().nullable(),
      reb: z.number().nullable(),
      ast: z.number().nullable(),
      ts_pct: z.number().nullable(),
    }),
  ),
});

export const comparePlayers = server.tool(
  {
    name: "compare_players",
    title: "Compare two players",
    description:
      "Side-by-side comparison of two NBA players using Elasticsearch aggregations over season averages: per-game averages, shooting splits, true shooting, advanced metrics, best season, and a season-by-season scoring trend. Renders an interactive comparison card.",
    inputSchema: z.object({
      player_a: playerArg("First"),
      player_b: playerArg("Second"),
      season_type: seasonType,
      from_season: fromSeason,
      to_season: toSeason,
    }),
    outputSchema: z.object({
      season_type: z.string(),
      window: z.string(),
      a: comparisonSide,
      b: comparisonSide,
      edges: z.record(z.string(), z.enum(["a", "b", "tie"])).describe("Which player leads each category"),
    }),
    view: {
      name: "player-comparison",
      description: "Head-to-head stat comparison card",
      prefersBorder: false,
      csp: { resourceDomains: ["https://fonts.googleapis.com", "https://fonts.gstatic.com"] },
    },
    annotations: readOnly,
  },
  async ({ player_a, player_b, season_type, from_season, to_season }) => {
    try {
      const [a, b] = await Promise.all([resolvePlayer(player_a), resolvePlayer(player_b)]);
      const result = await compareCareers(a, b, season_type, from_season, to_season);
      const window =
        from_season || to_season ? `${from_season ?? "start"}–${to_season ?? "latest"}` : "career (1996-97+ data)";
      const data = { season_type, window, ...result };

      const line = (n: string, c: typeof result.a.career) =>
        c
          ? `${n}: ${c.ppg} pts / ${c.rpg} reb / ${c.apg} ast, TS% ${c.ts_pct}, ${c.gp} games (${c.span})`
          : `${n}: no ${season_type} season data in this window`;
      const summary = [
        `${a.full_name} vs ${b.full_name} — ${season_type}, ${window}`,
        line(a.full_name, result.a.career),
        line(b.full_name, result.b.career),
      ].join("\n");

      return {
        content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data)}` }],
        structuredContent: data,
      };
    } catch (err) {
      return fail(err);
    }
  },
);

// ------------------------------------------------------------- player_seasons

export const playerSeasonsTool = server.tool(
  {
    name: "player_seasons",
    title: "Season-by-season stats",
    description: "Season-by-season per-game and advanced stats for one player (1996-97 onward).",
    inputSchema: z.object({ player: playerArg("The"), season_type: seasonType }),
    annotations: readOnly,
  },
  async ({ player, season_type }) => {
    try {
      const p = await resolvePlayer(player);
      return json({ player: p.full_name, season_type, seasons: await playerSeasons(p, season_type) });
    } catch (err) {
      return fail(err);
    }
  },
);

// ---------------------------------------------------------------- game_splits

export const gameSplitsTool = server.tool(
  {
    name: "game_splits",
    title: "Compare game splits",
    description:
      "Aggregate box scores for one or two players, split by home/away, win/loss result, opponent, calendar month, or season. Returns per-game averages, shooting %, and team record per split.",
    inputSchema: z.object({
      player_a: playerArg("First"),
      player_b: playerArg("Second").optional(),
      split_by: z.enum(["home_away", "result", "opponent", "month", "season"]).default("home_away"),
      season_type: z.enum(["regular", "playoffs"]).optional().describe("Omit to include both"),
      from_season: fromSeason,
      to_season: toSeason,
      opponent: z.string().length(3).optional().describe("Only games vs this team abbreviation, e.g. BOS"),
    }),
    annotations: readOnly,
  },
  async ({ player_a, player_b, split_by, season_type, from_season, to_season, opponent }) => {
    try {
      const players = await Promise.all([player_a, player_b].filter(Boolean).map((p) => resolvePlayer(p!)));
      return json({
        split_by,
        results: await gameSplits(players, split_by, { seasonType: season_type, from: from_season, to: to_season, opponent }),
      });
    } catch (err) {
      return fail(err);
    }
  },
);

// ------------------------------------------------------------ milestone_games

export const milestoneGames = server.tool(
  {
    name: "milestone_games",
    title: "Milestone games",
    description:
      "Count games where players hit a threshold (e.g. 40+ points, 15+ assists, 8+ threes) plus triple-doubles and double-doubles, with their top games. Great for 'who has more 50-point games' questions.",
    inputSchema: z.object({
      player_a: playerArg("First"),
      player_b: playerArg("Second").optional(),
      stat: z.enum(["pts", "reb", "ast", "stl", "blk", "fg3m", "game_score", "plus_minus"]).default("pts"),
      threshold: z.number().default(40).describe("Minimum value of the stat, inclusive"),
      season_type: z.enum(["regular", "playoffs"]).optional().describe("Omit to include both"),
      from_season: fromSeason,
      to_season: toSeason,
    }),
    annotations: readOnly,
  },
  async ({ player_a, player_b, stat, threshold, season_type, from_season, to_season }) => {
    try {
      const players = await Promise.all([player_a, player_b].filter(Boolean).map((p) => resolvePlayer(p!)));
      return json({
        stat,
        threshold,
        results: await milestones(players, stat, threshold, { seasonType: season_type, from: from_season, to: to_season }),
      });
    } catch (err) {
      return fail(err);
    }
  },
);

// ---------------------------------------------------------------- head_to_head

export const headToHeadTool = server.tool(
  {
    name: "head_to_head",
    title: "Head-to-head matchups",
    description:
      "Find every game where the two players faced each other (on opposing teams) and compare their production and win record in those matchups.",
    inputSchema: z.object({
      player_a: playerArg("First"),
      player_b: playerArg("Second"),
      season_type: z.enum(["regular", "playoffs"]).optional().describe("Omit to include both"),
      recent: z.number().int().min(1).max(25).default(10).describe("How many recent meetings to list"),
    }),
    annotations: readOnly,
  },
  async ({ player_a, player_b, season_type, recent }) => {
    try {
      const [a, b] = await Promise.all([resolvePlayer(player_a), resolvePlayer(player_b)]);
      return json(await headToHead(a, b, season_type, recent));
    } catch (err) {
      return fail(err);
    }
  },
);

// -------------------------------------------------------------- league_leaders

export const leagueLeadersTool = server.tool(
  {
    name: "league_leaders",
    title: "League leaders",
    description: "Top players in a season for a stat (per-game or advanced), to put a comparison in league context.",
    inputSchema: z.object({
      stat: z
        .enum(["pts", "reb", "ast", "stl", "blk", "tov", "min", "fg3m", "fg_pct", "fg3_pct", "ft_pct", "ts_pct", "efg_pct", "usg_pct", "net_rating", "off_rating", "def_rating", "pie", "plus_minus", "dd2", "td3"])
        .default("pts"),
      season: z.number().int().min(1996).describe("Season start year, e.g. 2024 for 2024-25"),
      season_type: seasonType,
      min_games: z.number().int().min(0).default(40),
      min_minutes: z.number().min(0).default(20).describe("Minimum minutes per game"),
      limit: z.number().int().min(1).max(25).default(10),
    }),
    annotations: readOnly,
  },
  async ({ stat, season, season_type, min_games, min_minutes, limit }) => {
    try {
      const games = season_type === "playoffs" ? Math.min(min_games, 4) : min_games;
      return json(await leagueLeaders(stat, season, season_type, games, min_minutes, limit));
    } catch (err) {
      return fail(err);
    }
  },
);

// ------------------------------------------------------------- search_nba_news

export const searchNews = server.tool(
  {
    name: "search_nba_news",
    title: "Search NBA news",
    description:
      "Hybrid search (BM25 keyword + semantic_text vector search, fused with RRF) over recent NBA articles. Optionally filter to articles mentioning given players or a team.",
    inputSchema: z.object({
      query: z.string().min(2).describe("Natural-language question or keywords, e.g. 'injury update', 'trade rumors'"),
      players: z.array(z.string()).max(4).optional().describe("Only articles mentioning any of these players"),
      team: z.string().length(3).optional().describe("Only articles mentioning this team abbreviation, e.g. LAL"),
      days: z.number().int().min(1).max(365).optional().describe("Only articles from the last N days"),
      limit: z.number().int().min(1).max(15).default(6),
    }),
    annotations: readOnly,
  },
  async ({ query, players, team, days, limit }) => {
    try {
      const names = players?.length ? (await Promise.all(players.map(resolvePlayer))).map((p) => p.full_name) : undefined;
      return json({ query, players: names, results: await searchArticles({ query, players: names, team, days, size: limit }) });
    } catch (err) {
      return fail(err);
    }
  },
);

// --------------------------------------------------------- compare_player_news

export const comparePlayerNews = server.tool(
  {
    name: "compare_player_news",
    title: "Compare player news",
    description:
      "Compare recent media coverage of two players: article counts by source, the most relevant articles for each (hybrid search), and articles mentioning both. Pass a topic like 'defense', 'injury', 'MVP case' to focus the search.",
    inputSchema: z.object({
      player_a: playerArg("First"),
      player_b: playerArg("Second"),
      topic: z.string().optional().describe("Optional focus, e.g. 'playoff performance' or 'contract'"),
      days: z.number().int().min(1).max(365).optional(),
      limit: z.number().int().min(1).max(10).default(4),
    }),
    annotations: readOnly,
  },
  async ({ player_a, player_b, topic, days, limit }) => {
    try {
      const [a, b] = await Promise.all([resolvePlayer(player_a), resolvePlayer(player_b)]);
      return json(await newsComparison(a, b, topic, days, limit));
    } catch (err) {
      return fail(err);
    }
  },
);

// ------------------------------------------------------------------- prompts

server.prompt(
  {
    name: "scouting_report",
    description: "Full scouting-style comparison of two players using every tool",
    schema: z.object({
      player_a: z.string().describe("First player"),
      player_b: z.string().describe("Second player"),
    }),
  },
  async ({ player_a, player_b }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Build a scouting report comparing ${player_a} and ${player_b}. Use compare_players for the overview, head_to_head for direct matchups, milestone_games for 40-point games and triple-doubles, game_splits by home_away, and compare_player_news for current storylines. Finish with a verdict and cite article URLs.`,
        },
      },
    ],
  }),
);

export default server;
