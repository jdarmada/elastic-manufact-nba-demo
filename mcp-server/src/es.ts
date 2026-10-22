import { Client } from "@elastic/elasticsearch";

const prefix = process.env.INDEX_PREFIX ?? "nba";

export const INDEX = {
  players: `${prefix}-players`,
  seasons: `${prefix}-season-stats`,
  games: `${prefix}-game-stats`,
  articles: `${prefix}-articles`,
  schedule: `${prefix}-schedule`,
  injuries: `${prefix}-injuries`,
};

let client: Client | undefined;

export function es(): Client {
  if (!client) {
    const node = process.env.ES_URL;
    const apiKey = process.env.ES_API_KEY;
    if (!node || !apiKey) {
      throw new Error("ES_URL and ES_API_KEY must be set");
    }
    client = new Client({ node, auth: { apiKey }, requestTimeout: 30_000 });
  }
  return client;
}

export type PlayerProfile = {
  player_id: number;
  full_name: string;
  position?: string;
  height?: string;
  weight?: string;
  college?: string;
  country?: string;
  draft_year?: number;
  draft_round?: number;
  draft_number?: number;
  team_abbreviation?: string;
  team_name?: string;
  is_active?: boolean;
  first_season?: number;
  last_season?: number;
};

const PROFILE_FIELDS = [
  "player_id", "full_name", "position", "height", "weight", "college", "country",
  "draft_year", "draft_round", "draft_number", "team_abbreviation", "team_name",
  "is_active", "first_season", "last_season",
];

const NBA_TEAMS = [
  "ATL", "BOS", "BKN", "CHA", "CHI", "CLE", "DAL", "DEN", "DET", "GSW", "HOU", "IND", "LAC", "LAL", "MEM",
  "MIA", "MIL", "MIN", "NOP", "NYK", "OKC", "ORL", "PHI", "PHX", "POR", "SAC", "SAS", "TOR", "UTA", "WAS",
];

const NICKNAMES: Record<string, string> = {
  kd: "Kevin Durant", sga: "Shai Gilgeous-Alexander", cp3: "Chris Paul", ad: "Anthony Davis",
  "the brow": "Anthony Davis", "king james": "LeBron James", bron: "LeBron James", "greek freak": "Giannis Antetokounmpo",
  "the joker": "Nikola Jokic", joker: "Nikola Jokic", wemby: "Victor Wembanyama", "chef curry": "Stephen Curry",
  steph: "Stephen Curry", dame: "Damian Lillard", "the beard": "James Harden", kat: "Karl-Anthony Towns",
  pg13: "Paul George", "the process": "Joel Embiid", "black mamba": "Kobe Bryant", mj: "Michael Jordan",
  shaq: "Shaquille O'Neal", "the answer": "Allen Iverson", ant: "Anthony Edwards", "ant-man": "Anthony Edwards",
  timmy: "Tim Duncan", luka: "Luka Doncic", shai: "Shai Gilgeous-Alexander", ja: "Ja Morant",
  zion: "Zion Williamson", trae: "Trae Young", kawhi: "Kawhi Leonard", kyrie: "Kyrie Irving",
  tatum: "Jayson Tatum", embiid: "Joel Embiid", jokic: "Nikola Jokic", flagg: "Cooper Flagg",
  kobe: "Kobe Bryant", jordan: "Michael Jordan", lebron: "LeBron James", curry: "Stephen Curry", "the mailman": "Karl Malone", "melo": "Carmelo Anthony", jimmy: "Jimmy Butler",
};

/** Fuzzy name search; players with stats on file and active players rank higher. */
export async function findPlayers(rawName: string, size = 5): Promise<PlayerProfile[]> {
  const name = NICKNAMES[rawName.trim().toLowerCase()] ?? rawName;
  const tokens = name.toLowerCase().split(/[\s.]+/).filter(Boolean);
  const res = await es().search<PlayerProfile>({
    index: INDEX.players,
    size,
    _source: PROFILE_FIELDS,
    query: {
      bool: {
        must: [
          {
            bool: {
              should: [
                { match_phrase: { full_name: { query: name, boost: 4 } } },
                { match: { full_name: { query: name, operator: "and", fuzziness: "AUTO", boost: 2 } } },
                { multi_match: { query: name, type: "bool_prefix", fields: ["full_name.suggest", "full_name.suggest._2gram", "full_name.suggest._3gram"] } },
                // Every token must match as a prefix or with a typo: "steph cury" -> Stephen Curry
                {
                  bool: {
                    must: tokens.map((t) => ({
                      bool: {
                        should: [
                          { prefix: { full_name: { value: t } } },
                          { fuzzy: { full_name: { value: t, fuzziness: "AUTO" } } },
                        ],
                      },
                    })),
                  },
                },
              ],
              minimum_should_match: 1,
            },
          },
        ],
        // balldontlie also lists international players (e.g. a second "Luka Doncic" on Real Madrid);
        // these boosts outweigh text-score differences so NBA players with stats always win.
        should: [
          { constant_score: { filter: { exists: { field: "last_season" } }, boost: 30 } },
          { constant_score: { filter: { terms: { team_abbreviation: NBA_TEAMS } }, boost: 10 } },
          { constant_score: { filter: { term: { is_active: true } }, boost: 2 } },
        ],
      },
    },
  });
  return res.hits.hits.map((h) => h._source!).filter(Boolean);
}

const resolved = new Map<string, PlayerProfile>();

/** Resolve a free-text player name (or numeric id) to a single player profile. */
export async function resolvePlayer(nameOrId: string): Promise<PlayerProfile> {
  const key = nameOrId.trim().toLowerCase();
  const cached = resolved.get(key);
  if (cached) return cached;

  let player: PlayerProfile | undefined;
  if (/^\d+$/.test(key)) {
    const res = await es().search<PlayerProfile>({
      index: INDEX.players,
      size: 1,
      _source: PROFILE_FIELDS,
      query: { term: { player_id: Number(key) } },
    });
    player = res.hits.hits[0]?._source;
  } else {
    player = (await findPlayers(nameOrId, 1))[0];
  }
  if (!player) {
    throw new Error(`No NBA player found matching "${nameOrId}". Try find_player first.`);
  }
  if (resolved.size > 2000) resolved.clear();
  resolved.set(key, player);
  return player;
}
