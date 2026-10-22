/** Next-game projection card rendered for the predict_next_game tool. */
import { ThemeProvider, useHostContext, useSendFollowUp, useToolContext } from "mcp-use/react";

import "./view.css";

const COLOR_A = "#0B64DD";
const COLOR_B = "#F04E98";

type Ctx = ReturnType<typeof useToolContext<"predict_next_game">>;
type Output = Extract<Ctx, { status: "ready" }>["toolOutput"];
type Proj = Output["a"];

const STAT_LABEL: Record<string, string> = {
  pts: "points", reb: "rebounds", ast: "assists", fg3m: "threes", stl: "steals", blk: "blocks", pra: "pts+reb+ast",
};

const fmt = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(1));

function gameLabel(p: Proj, locale?: string, timeZone?: string) {
  const g = p.next_game;
  if (!g) return p.note ?? "No upcoming game";
  const when = g.datetime
    ? new Date(g.datetime).toLocaleString(locale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone })
    : g.date;
  return `${g.home ? "vs" : "@"} ${g.opponent} · ${when}`;
}

function injuryBadge(p: Proj) {
  if (!p.injury) return null;
  const out = p.likely_out;
  return (
    <span
      title={p.injury.note}
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        out ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
      }`}
    >
      {p.injury.status}
    </span>
  );
}

function Factors({ p }: { p: Proj }) {
  const c = p.components;
  const rows: [string, string][] = [
    ["Last 10", fmt(c.last_10_avg)],
    [`Season (${c.season_games} gp)`, fmt(c.season_avg)],
    [`vs ${p.next_game?.opponent ?? "opp"} (${c.vs_opponent_games} gp)`, fmt(c.vs_opponent_avg)],
    [p.next_game?.home ? "At home" : "On road", fmt(c.venue_avg)],
    [
      "Opp. defense rank",
      c.opponent_defense_rank != null ? `#${c.opponent_defense_rank}${c.opponent_allowed_factor ? ` (${c.opponent_allowed_factor >= 1 ? "+" : ""}${Math.round((c.opponent_allowed_factor - 1) * 100)}%)` : ""}` : "–",
    ],
  ];
  if (c.back_to_back) rows.push(["Back-to-back", "yes"]);
  return (
    <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-zinc-500 dark:text-zinc-400">{k}</dt>
          <dd className="text-right tabular-nums text-zinc-800 dark:text-zinc-200">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function PlayerColumn({ p, color, max }: { p: Proj; color: string; max: number }) {
  const { locale, timeZone } = useHostContext();
  const pct = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  return (
    <div className="min-w-0 flex-1 rounded-2xl border border-zinc-100 p-4 dark:border-zinc-900">
      <div className="flex items-center justify-between gap-2">
        <div className="hero-title truncate text-base text-zinc-900 dark:text-white">{p.player}</div>
        {injuryBadge(p)}
      </div>
      <div className="text-xs text-zinc-500 dark:text-zinc-400">
        {p.team ? `${p.team} ` : ""}
        {gameLabel(p, locale, timeZone)}
      </div>

      <div className="mt-3 flex items-baseline gap-2">
        <span className="hero-title text-4xl tabular-nums" style={{ color }}>
          {p.likely_out ? "OUT" : fmt(p.projection)}
        </span>
        {!p.likely_out && p.range && (
          <span className="text-xs text-zinc-500">
            range {fmt(p.range[0])}–{fmt(p.range[1])}
          </span>
        )}
      </div>

      {!p.likely_out && p.range && p.projection != null && (
        <div className="relative mt-2 h-2 rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div
            className="absolute h-2 rounded-full opacity-30"
            style={{ left: pct(p.range[0]), width: `calc(${pct(p.range[1])} - ${pct(p.range[0])})`, background: color }}
          />
          <div className="absolute -top-0.5 h-3 w-1 rounded-full" style={{ left: pct(p.projection), background: color }} />
        </div>
      )}

      <Factors p={p} />

      {p.recent_games.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {p.recent_games.map((g) => (
            <span key={g.date} title={`${g.date} vs ${g.opponent}`} className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
              {g.opponent} {g.value}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function NextGamePrediction() {
  const view = useToolContext<"predict_next_game">();
  const { hostCapabilities } = useHostContext();
  const sendFollowUp = useSendFollowUp();
  const shell = "overflow-hidden rounded-3xl border border-zinc-200 bg-white dark:border-white/10 dark:bg-black";

  if (view.status === "pending") {
    return (
      <ThemeProvider>
        <div className={`${shell} animate-pulse space-y-3 p-5`}>
          <div className="h-4 w-1/2 rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="flex gap-3">
            <div className="h-40 flex-1 rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
            <div className="h-40 flex-1 rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
          </div>
        </div>
      </ThemeProvider>
    );
  }
  if (view.status === "error") {
    return (
      <ThemeProvider>
        <div className={`${shell} p-5 text-sm text-red-600`}>{view.error.message}</div>
      </ThemeProvider>
    );
  }

  const { a, b, stat, probability_a_higher: prob } = view.toolOutput;
  const label = STAT_LABEL[stat] ?? stat;
  const max = Math.max(5, ...[a, b].filter(Boolean).map((p) => p!.range?.[1] ?? p!.projection ?? 0)) * 1.1;
  const canFollowUp = hostCapabilities?.message !== undefined;

  let verdict = `Projected ${label} in ${a.player}'s next game`;
  if (b) {
    if (a.likely_out || b.likely_out) verdict = `${a.likely_out ? a.player : b.player} is listed out`;
    else if (prob != null) {
      const leader = prob >= 0.5 ? a.player : b.player;
      verdict = `${leader} projects for more ${label} (${Math.round(Math.max(prob, 1 - prob) * 100)}%)`;
    }
  }

  return (
    <ThemeProvider>
      <div className={shell}>
        <div className="space-y-4 p-5">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-zinc-400">Next-game projection · {label}</div>
            <div className="hero-title text-lg text-zinc-900 dark:text-white">{verdict}</div>
          </div>

          {b && prob != null && !a.likely_out && !b.likely_out && (
            <div>
              <div className="flex h-2.5 overflow-hidden rounded-full">
                <div style={{ width: `${prob * 100}%`, background: COLOR_A }} />
                <div style={{ width: `${(1 - prob) * 100}%`, background: COLOR_B }} />
              </div>
              <div className="mt-1 flex justify-between text-[11px] tabular-nums text-zinc-500">
                <span>{Math.round(prob * 100)}%</span>
                <span>{Math.round((1 - prob) * 100)}%</span>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-3 sm:flex-row">
            <PlayerColumn p={a} color={COLOR_A} max={max} />
            {b && <PlayerColumn p={b} color={COLOR_B} max={max} />}
          </div>

          {canFollowUp && (
            <div className="flex flex-wrap justify-center gap-2">
              {[
                b ? `Compare ${a.player} and ${b.player} career stats` : `Show ${a.player}'s upcoming schedule`,
                `How has ${a.player} played against ${a.next_game?.opponent ?? "their next opponent"}?`,
                b ? `Who will have more assists next game, ${a.player} or ${b.player}?` : `Latest news on ${a.player}`,
              ].map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => void sendFollowUp({ prompt })}
                  className="cursor-pointer rounded-full border border-zinc-300 px-3 py-1 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}

          <div className="text-center text-[10px] text-zinc-400">
            Statistical estimate from Elasticsearch box scores, schedule & injury data · for fun, not betting advice
          </div>
        </div>
      </div>
    </ThemeProvider>
  );
}
