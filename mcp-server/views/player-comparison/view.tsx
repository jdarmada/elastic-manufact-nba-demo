/** Side-by-side NBA player comparison card rendered for the compare_players tool. */
import { ThemeProvider, useHostContext, useSendFollowUp, useToolContext } from "mcp-use/react";

import "./view.css";

const COLOR_A = "#0B64DD"; // Elastic blue
const COLOR_B = "#F04E98"; // Elastic pink

type Ctx = ReturnType<typeof useToolContext<"compare_players">>;
type Output = Extract<Ctx, { status: "ready" }>["toolOutput"];
type Side = Output["a"];
type Career = NonNullable<Side["career"]>;

const pct = (v: number | null | undefined) => (v == null ? "–" : `${(v <= 1.5 ? v * 100 : v).toFixed(1)}%`);
const num = (v: number | null | undefined, d = 1) => (v == null ? "–" : v.toFixed(d));

const ROWS: { key: keyof Career; label: string; fmt: (v: number | null) => string }[] = [
  { key: "ppg", label: "Points", fmt: num },
  { key: "rpg", label: "Rebounds", fmt: num },
  { key: "apg", label: "Assists", fmt: num },
  { key: "spg", label: "Steals", fmt: num },
  { key: "bpg", label: "Blocks", fmt: num },
  { key: "tpg", label: "Turnovers", fmt: num },
  { key: "fg_pct", label: "FG%", fmt: pct },
  { key: "fg3_pct", label: "3P%", fmt: pct },
  { key: "ft_pct", label: "FT%", fmt: pct },
  { key: "ts_pct", label: "True shooting", fmt: pct },
  { key: "usg_pct", label: "Usage", fmt: pct },
  { key: "net_rating", label: "Net rating", fmt: num },
  { key: "pie", label: "PIE", fmt: pct },
];

function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("");
}

function PlayerHeader({ side, color, align }: { side: Side; color: string; align: "left" | "right" }) {
  const p = side.profile;
  const c = side.career;
  const right = align === "right";
  return (
    <div className={`flex items-center gap-3 ${right ? "flex-row-reverse text-right" : ""}`}>
      <div
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-base font-semibold text-white"
        style={{ background: color }}
      >
        {initials(p.full_name)}
      </div>
      <div className="min-w-0">
        <div className="hero-title truncate text-lg leading-tight text-zinc-900 dark:text-white">{p.full_name}</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {[p.position, p.team_abbreviation, p.draft_year ? `Draft ${p.draft_year}${p.draft_number ? ` #${p.draft_number}` : ""}` : null]
            .filter(Boolean)
            .join(" · ")}
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {c ? `${c.gp} games · ${c.span}` : "No data in this window"}
        </div>
      </div>
    </div>
  );
}

function StatRow({ label, a, b, fmt, edge }: { label: string; a: number | null; b: number | null; fmt: (v: number | null) => string; edge?: string }) {
  const max = Math.max(Math.abs(a ?? 0), Math.abs(b ?? 0)) || 1;
  const w = (v: number | null) => `${Math.max(2, (Math.abs(v ?? 0) / max) * 100)}%`;
  const strong = (side: "a" | "b") => (edge === side ? "font-semibold text-zinc-900 dark:text-white" : "text-zinc-500 dark:text-zinc-400");
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 py-1">
      <div className="flex items-center justify-end gap-2">
        <span className={`w-14 text-right text-sm tabular-nums ${strong("a")}`}>{fmt(a)}</span>
        <div className="h-2 w-full max-w-40 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div className="ml-auto h-full rounded-full" style={{ width: w(a), background: COLOR_A, opacity: edge === "a" ? 1 : 0.45 }} />
        </div>
      </div>
      <div className="w-24 text-center text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="flex items-center gap-2">
        <div className="h-2 w-full max-w-40 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div className="h-full rounded-full" style={{ width: w(b), background: COLOR_B, opacity: edge === "b" ? 1 : 0.45 }} />
        </div>
        <span className={`w-14 text-sm tabular-nums ${strong("b")}`}>{fmt(b)}</span>
      </div>
    </div>
  );
}

function TrendChart({ a, b }: { a: Side; b: Side }) {
  const seasons = [...new Set([...a.series, ...b.series].map((s) => s.season))].sort((x, y) => x - y);
  if (seasons.length < 2) return null;
  const values = [...a.series, ...b.series].map((s) => s.pts ?? 0);
  const maxY = Math.ceil(Math.max(10, ...values) / 5) * 5;
  const W = 560, H = 150, P = { l: 28, r: 8, t: 10, b: 20 };
  const x = (season: number) => P.l + ((season - seasons[0]) / (seasons[seasons.length - 1] - seasons[0])) * (W - P.l - P.r);
  const y = (v: number) => H - P.b - (v / maxY) * (H - P.t - P.b);
  const path = (side: Side) =>
    side.series
      .filter((s) => s.pts != null)
      .map((s, i) => `${i ? "L" : "M"}${x(s.season).toFixed(1)},${y(s.pts!).toFixed(1)}`)
      .join(" ");
  const ticks = [0, maxY / 2, maxY];
  const labelEvery = Math.ceil(seasons.length / 8);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Points per game by season">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} className="stroke-zinc-200 dark:stroke-zinc-800" strokeWidth={1} />
          <text x={P.l - 6} y={y(t) + 3} textAnchor="end" className="fill-zinc-400 text-[9px]">{t}</text>
        </g>
      ))}
      {seasons.map((s, i) =>
        i % labelEvery === 0 ? (
          <text key={s} x={x(s)} y={H - 5} textAnchor="middle" className="fill-zinc-400 text-[9px]">
            {`'${String(s).slice(-2)}`}
          </text>
        ) : null,
      )}
      {[{ side: a, color: COLOR_A }, { side: b, color: COLOR_B }].map(({ side, color }) => (
        <g key={side.profile.player_id}>
          <path d={path(side)} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
          {side.series.filter((s) => s.pts != null).map((s) => (
            <circle key={s.season} cx={x(s.season)} cy={y(s.pts!)} r={2.5} fill={color}>
              <title>{`${side.profile.full_name} ${s.season_label} (${s.team ?? ""}): ${s.pts} ppg`}</title>
            </circle>
          ))}
        </g>
      ))}
    </svg>
  );
}

function Skeleton() {
  return (
    <div className="animate-pulse space-y-3 p-5">
      <div className="flex justify-between">
        <div className="h-12 w-48 rounded-xl bg-zinc-200 dark:bg-zinc-800" />
        <div className="h-12 w-48 rounded-xl bg-zinc-200 dark:bg-zinc-800" />
      </div>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-3 rounded bg-zinc-100 dark:bg-zinc-900" />
      ))}
    </div>
  );
}

export default function PlayerComparison() {
  const view = useToolContext<"compare_players">();
  const { hostCapabilities } = useHostContext();
  const sendFollowUp = useSendFollowUp();

  const shell = "overflow-hidden rounded-3xl border border-zinc-200 bg-white dark:border-white/10 dark:bg-black";

  if (view.status === "pending") {
    return (
      <ThemeProvider>
        <div className={shell}>
          <Skeleton />
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

  const { a, b, edges, season_type, window } = view.toolOutput;
  const nameA = a.profile.full_name;
  const nameB = b.profile.full_name;
  const leadsA = Object.values(edges).filter((e) => e === "a").length;
  const leadsB = Object.values(edges).filter((e) => e === "b").length;
  const canFollowUp = hostCapabilities?.message !== undefined;

  const followUps = [
    { label: "Head-to-head", prompt: `Show the head-to-head record between ${nameA} and ${nameB}.` },
    { label: "40-point games", prompt: `Who has more 40-point games and triple-doubles, ${nameA} or ${nameB}?` },
    { label: "Home vs away", prompt: `Compare ${nameA} and ${nameB} home vs away splits.` },
    { label: "Latest news", prompt: `What is the latest news on ${nameA} and ${nameB}?` },
  ];

  return (
    <ThemeProvider>
      <div className={shell}>
        <div className="space-y-5 p-5">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
            <PlayerHeader side={a} color={COLOR_A} align="left" />
            <div className="text-center">
              <div className="text-xs font-medium uppercase tracking-widest text-zinc-400">vs</div>
              <div className="mt-1 text-sm tabular-nums text-zinc-600 dark:text-zinc-300">
                <span style={{ color: COLOR_A }}>{leadsA}</span> – <span style={{ color: COLOR_B }}>{leadsB}</span>
              </div>
              <div className="text-[10px] text-zinc-400">categories led</div>
            </div>
            <PlayerHeader side={b} color={COLOR_B} align="right" />
          </div>

          <div className="text-center text-[11px] uppercase tracking-wider text-zinc-400">
            {season_type === "playoffs" ? "Playoffs" : "Regular season"} · {window} · per game
          </div>

          {a.career && b.career ? (
            <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {ROWS.map((r) => (
                <StatRow key={r.key} label={r.label} a={a.career![r.key] as number | null} b={b.career![r.key] as number | null} fmt={r.fmt} edge={edges[r.key]} />
              ))}
            </div>
          ) : (
            <p className="text-center text-sm text-zinc-500">
              Not enough data to compare both players in this window.
            </p>
          )}

          <div>
            <div className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Points per game by season</div>
            <TrendChart a={a} b={b} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            {[{ side: a, color: COLOR_A }, { side: b, color: COLOR_B }].map(({ side, color }) => {
              const best = side.career?.best_season;
              return (
                <div key={side.profile.player_id} className="rounded-2xl border border-zinc-100 p-3 dark:border-zinc-900">
                  <div className="text-[11px] uppercase tracking-wider" style={{ color }}>Best season</div>
                  {best ? (
                    <div className="text-sm text-zinc-800 dark:text-zinc-200">
                      <span className="font-semibold">{best.season_label}</span> {best.team ? `(${best.team})` : ""} ·{" "}
                      {num(best.ppg)} / {num(best.rpg)} / {num(best.apg)}
                    </div>
                  ) : (
                    <div className="text-sm text-zinc-400">–</div>
                  )}
                  <div className="mt-1 text-xs text-zinc-500">
                    Totals: {side.career?.total_pts?.toLocaleString() ?? "–"} pts · {side.career?.total_reb?.toLocaleString() ?? "–"} reb ·{" "}
                    {side.career?.total_ast?.toLocaleString() ?? "–"} ast
                  </div>
                </div>
              );
            })}
          </div>

          {canFollowUp && (
            <div className="flex flex-wrap justify-center gap-2">
              {followUps.map((f) => (
                <button
                  key={f.label}
                  type="button"
                  onClick={() => void sendFollowUp({ prompt: f.prompt })}
                  className="cursor-pointer rounded-full border border-zinc-300 px-3 py-1 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}

          <div className="text-center text-[10px] text-zinc-400">Powered by Elasticsearch aggregations · served by Manufact</div>
        </div>
      </div>
    </ThemeProvider>
  );
}
