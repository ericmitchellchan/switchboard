/**
 * Overview — the missing FIRST step of the funnel (owner 2026-08-02).
 *
 * The app had no top: every entry point (Markets, Trading, Playground) was
 * already a deep dive, and the deep-dive OBJECT — the case — was born in one
 * surface (Markets' annotate, the triage table) but could only be read in
 * another. That split is what read as "disjointed".
 *
 * This page is the spine's first rung: overview → drill → case.
 *  - every row DRILLS (click → the surface that owns that subject), and
 *  - every row can BECOME A CASE in one gesture (the "+ case" affordance),
 *    so the deep-dive object is created where you noticed the thing, not
 *    after a context switch.
 *
 * It composes EXISTING lanes only — no new backend endpoints — and shares its
 * cache keys with SportsDash / TradingDash, so landing here warms those tabs
 * and vice versa (see lib/queryCache).
 */

import { useState } from "react";
import { useSurfaceNav } from "../../../surfaces/page-api";
import {
  api,
  type Case,
  type CasePin,
  type CaseStream,
  type CaseSubject,
  type ProbableRow,
  type SportsDashboard,
} from "../api/client";
import {
  fetchTradingDash,
  type TradingDashData,
} from "../components/research/TradingDash";
import { useCachedFetch } from "../lib/queryCache";
import { usePoll } from "../hooks/usePoll";
import { useUiStore } from "../stores/uiStore";
import { ptTime } from "../lib/time";

const AMBER = "#d18f5a";

const STREAM_DOT: Record<CaseStream, string> = {
  trading: "#6ea8d1",
  tennis: "#8fd16e",
  mlb: AMBER,
  generic: "#8a8a8a",
};

function Section({
  title,
  sub,
  onDrill,
  drillLabel,
  children,
}: {
  title: string;
  sub?: string;
  onDrill?: () => void;
  drillLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface p-3.5">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-xs font-medium text-text">{title}</h2>
        {sub ? <span className="font-mono text-[9.5px] text-dim">{sub}</span> : null}
        {onDrill ? (
          <button
            type="button"
            onClick={onDrill}
            className="ml-auto font-mono text-[10px] uppercase text-dim hover:text-accent"
          >
            {drillLabel ?? "open"} →
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** A row that drills on click and can spawn a case from its own context. */
function Row({
  onDrill,
  onCase,
  busy,
  children,
}: {
  onDrill: () => void;
  onCase?: () => void;
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="group flex items-center gap-2 border-b border-dashed border-line py-1.5 last:border-b-0">
      <button type="button" onClick={onDrill} className="min-w-0 flex-1 text-left">
        {children}
      </button>
      {onCase ? (
        <button
          type="button"
          onClick={onCase}
          disabled={busy}
          title="open a case on this"
          className="shrink-0 font-mono text-[9.5px] uppercase text-dim opacity-0 transition-opacity hover:text-accent group-hover:opacity-100 disabled:opacity-40"
        >
          {busy ? "…" : "+ case"}
        </button>
      ) : null}
    </div>
  );
}

function Tile({ k, v, d, tone }: { k: string; v: string; d: string; tone?: "up" | "dn" }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3.5 py-2.5">
      <div className="font-mono text-[9.5px] uppercase tracking-wider text-dim">{k}</div>
      <div className="mt-0.5 font-mono text-lg text-text">{v}</div>
      <div
        className={`font-mono text-[10px] ${
          tone === "up" ? "text-up" : tone === "dn" ? "text-dn" : "text-dim"
        }`}
      >
        {d}
      </div>
    </div>
  );
}

function pct(r: number | null): string {
  return r == null ? "—" : `${r >= 0 ? "+" : ""}${(r * 100).toFixed(2)}%`;
}

/** Loading / error / empty, in that order — so a pending fetch never renders as
 *  a factual "there is nothing here". */
function LaneState({ loading, error }: { loading: boolean; error: string | null }) {
  if (loading) return <div className="py-2 font-mono text-[11px] text-dim">loading…</div>;
  return (
    <div className="py-2 font-mono text-[11px] text-dn">
      {error ? "backend unreachable" : ""}
    </div>
  );
}

export default function Overview() {
  // SWITCHBOARD: no router — the shell opens the page (panel or full width).
  const nav = useSurfaceNav();
  const setPendingCase = useUiStore((s) => s.setPendingCase);
  const setPendingDeskTab = useUiStore((s) => s.setPendingDeskTab);
  // Shared cache keys with the desk dashboards — no duplicate fetching.
  const {
    data: sports,
    error: sportsErr,
    loading: sportsLoading,
  } = useCachedFetch<SportsDashboard>("dashboard:sports", () => api.getSportsDashboard(false));
  const { data: trading } = useCachedFetch<TradingDashData>("dashboard:trading", fetchTradingDash);
  const { data: cases, error: casesErr } = usePoll(() => api.listCases(), 5000, undefined, "cases");
  const [creating, setCreating] = useState<string | null>(null);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const caseList = cases ?? [];
  // "Not loaded yet" must never render as "nothing here" — this is the landing
  // page, and an empty-state sentence is an assertion of FACT about the data
  // (review finding). Until a lane resolves it says so instead.
  const casesLoading = cases === null && casesErr === null;

  /** The one gesture: make a case from whatever row you're looking at, then land
   *  in it. Failure leaves you where you are rather than navigating into nothing. */
  const openCaseOn = async (
    key: string,
    title: string,
    stream: CaseStream,
    subject: CaseSubject,
    hypothesis?: string,
  ): Promise<void> => {
    setCreating(key);
    setCreateErr(null);
    try {
      const c = await api.createCase({ title, stream, subject, hypothesis });
      setPendingCase(c.case_id);
      nav.openPage("playground");
    } catch (e: unknown) {
      // Silent failure here looks like a dead button — say so and stay put.
      setCreateErr(`couldn't create that case: ${String(e)}`);
      setCreating(null);
    }
  };

  const goCase = (id: string): void => {
    setPendingCase(id);
    nav.openPage("playground");
  };

  // Recent evidence across every open case — the third rung of the overview.
  const recentPins: { pin: CasePin; c: Case }[] = caseList
    .flatMap((c) => c.pins.map((pin) => ({ pin, c })))
    .sort((a, b) => (a.pin.ts < b.pin.ts ? 1 : -1))
    .slice(0, 6);

  const probables: ProbableRow[] = sports?.probables ?? [];
  const es = trading?.es ?? null;
  const nq = trading?.nq ?? null;
  const gamma = trading?.gamma ?? null;
  const flipDelta = es && gamma?.zero_gamma != null ? es.close - gamma.zero_gamma : null;

  return (
    <div className="max-w-5xl pb-8">
      <div className="mb-4 flex items-baseline gap-3">
        <h1 className="font-mono text-lg font-medium tracking-tight">Overview</h1>
        <span className="font-mono text-[10px] text-dim">
          snapshot data · {sports?.as_of ? sports.as_of.replace("T", " ") : "—"}
        </span>
      </div>
      {createErr ? (
        <div className="mb-3 rounded-lg border border-dashed border-line px-3 py-2 font-mono text-[11px] text-dn">
          {createErr}
        </div>
      ) : null}

      {/* ── what kind of day is it (markets) ── */}
      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          k="ES · last close"
          v={es ? es.close.toFixed(2) : "—"}
          d={es ? `${es.date} · ${pct(es.change_pct ?? null)}` : "no session data"}
          tone={es?.change_pct != null ? (es.change_pct >= 0 ? "up" : "dn") : undefined}
        />
        <Tile
          k="NQ · last close"
          v={nq ? nq.close.toFixed(2) : "—"}
          d={nq ? `${nq.date} · ${pct(nq.change_pct ?? null)}` : "no session data"}
          tone={nq?.change_pct != null ? (nq.change_pct >= 0 ? "up" : "dn") : undefined}
        />
        <Tile
          k="gamma flip"
          v={gamma?.zero_gamma != null ? gamma.zero_gamma.toFixed(2) : "—"}
          d={flipDelta == null ? "ES vs flip" : `ES ${flipDelta >= 0 ? "above" : "below"} by ${Math.abs(flipDelta).toFixed(2)}`}
          tone={flipDelta == null ? undefined : flipDelta >= 0 ? "up" : "dn"}
        />
        <Tile
          k="open cases"
          v={String(caseList.length)}
          d={caseList.length === 0 ? "start one below" : "in the book"}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {/* ── today's slate ── */}
        <Section
          title="Today's slate"
          sub={`mlb · ${probables.length} probables`}
          onDrill={() => nav.openPage("markets")}
          drillLabel="markets"
        >
          {sportsLoading || sportsErr ? (
            <LaneState loading={sportsLoading} error={sportsErr} />
          ) : probables.length === 0 ? (
            <div className="py-2 text-[11.5px] text-dim">
              nothing scheduled in the local snapshot — `refresh_local_data` pulls the current slate.
            </div>
          ) : (
            probables.slice(0, 8).map((p, i) => {
              const key = `prob:${p.away}@${p.home}:${i}`;
              return (
                <Row
                  key={key}
                  onDrill={() => nav.openPage("markets")}
                  busy={creating === key}
                  onCase={() =>
                    void openCaseOn(
                      key,
                      `${p.away} @ ${p.home}`,
                      "mlb",
                      {
                        kind: "situation",
                        label: `${p.away} @ ${p.home}`,
                        params: {
                          home: p.home,
                          away: p.away,
                          home_pitcher: p.home_pitcher,
                          away_pitcher: p.away_pitcher,
                          game_time_utc: p.game_time_utc,
                        },
                      },
                      `What's the edge in ${p.away} @ ${p.home}?`,
                    )
                  }
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-text">
                      {p.away} @ {p.home}
                    </span>
                    <span className="shrink-0 font-mono text-[9.5px] text-dim">
                      {p.game_time_utc ? ptTime(p.game_time_utc) : p.state ?? ""}
                    </span>
                  </div>
                  <div className="truncate font-mono text-[9.5px] text-dim2">
                    {p.away_pitcher ?? "TBD"} vs {p.home_pitcher ?? "TBD"}
                  </div>
                </Row>
              );
            })
          )}
        </Section>

        {/* ── form / what's hot ── */}
        <Section
          title="Form"
          sub={`hot & cold · capture-era`}
          onDrill={() => {
            // Drill INTO the sports dashboard, not the case library — the label
            // named a surface this used to be unable to reach (review finding).
            setPendingDeskTab("sdash");
            nav.openPage("playground");
          }}
          drillLabel="sports desk"
        >
          {sportsLoading || sportsErr ? (
            <LaneState loading={sportsLoading} error={sportsErr} />
          ) : (sports?.streaks.hot.length ?? 0) + (sports?.streaks.cold.length ?? 0) === 0 ? (
            <div className="py-2 text-[11.5px] text-dim">no captured finals yet</div>
          ) : (
            [...(sports?.streaks.hot ?? []), ...(sports?.streaks.cold ?? [])]
              .slice(0, 8)
              .map((s) => {
                const win = s.streak.startsWith("W");
                const key = `streak:${s.team}`;
                return (
                  <Row
                    key={key}
                    onDrill={() => {
                      setPendingDeskTab("sdash");
                      nav.openPage("playground");
                    }}
                    busy={creating === key}
                    onCase={() =>
                      void openCaseOn(
                        key,
                        `${s.team} — ${s.streak} run`,
                        "mlb",
                        { kind: "situation", label: s.team, params: { team: s.team, streak: s.streak } },
                        `Is the ${s.team} ${s.streak} run priced correctly?`,
                      )
                    }
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[11.5px] text-text">{s.team}</span>
                      <span
                        className={`rounded px-1.5 py-px font-mono text-[9.5px] ${win ? "text-up" : "text-dn"}`}
                        style={{ background: win ? "rgba(78,169,106,.12)" : "rgba(224,100,91,.12)" }}
                      >
                        {s.streak}
                      </span>
                      <span className="w-12 shrink-0 text-right font-mono text-[10px] text-dim">
                        {s.wins}-{s.losses}
                      </span>
                    </div>
                  </Row>
                );
              })
          )}
        </Section>

        {/* ── the book: open cases ── */}
        <Section
          title="Open cases"
          sub={caseList.length ? `${caseList.length} active` : undefined}
          onDrill={() => nav.openPage("library-cases")}
          drillLabel="see all"
        >
          {casesLoading || casesErr ? (
            <LaneState loading={casesLoading} error={casesErr} />
          ) : caseList.length === 0 ? (
            <div className="py-3">
              <div className="mb-2 text-[11.5px] text-dim">
                No open cases — the book is clear. Start one from any row above, or:
              </div>
              <button
                type="button"
                disabled={creating === "blank"}
                onClick={() =>
                  void openCaseOn("blank", "New case", "generic", { kind: "situation", label: "New case" })
                }
                className="rounded-md bg-surface2 px-2.5 py-1 font-mono text-[10px] uppercase text-text hover:text-accent disabled:opacity-40"
              >
                {creating === "blank" ? "creating…" : "+ blank case"}
              </button>
            </div>
          ) : (
            caseList.slice(0, 8).map((c) => (
              <Row key={c.case_id} onDrill={() => goCase(c.case_id)}>
                <div className="flex items-center gap-2">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: STREAM_DOT[c.stream] }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-text">{c.title}</span>
                  <span className="shrink-0 font-mono text-[9.5px] uppercase text-dim">
                    {c.disposition}
                  </span>
                </div>
                <div className="truncate font-mono text-[9.5px] text-dim2">
                  {c.pins.length} evidence · {c.notes.length} notes
                </div>
              </Row>
            ))
          )}
        </Section>

        {/* ── recent evidence ── */}
        <Section title="Recent evidence" sub={recentPins.length ? "newest first" : undefined}>
          {casesLoading || casesErr ? (
            <LaneState loading={casesLoading} error={casesErr} />
          ) : recentPins.length === 0 ? (
            <div className="py-2 text-[11.5px] text-dim">
              nothing pinned yet — evidence lands here as cases accumulate it.
            </div>
          ) : (
            recentPins.map(({ pin, c }) => (
              <Row key={pin.pin_id} onDrill={() => goCase(c.case_id)}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-text">{pin.title}</span>
                  <span className="shrink-0 font-mono text-[9.5px] text-dim">{pin.kind}</span>
                </div>
                {/* provenance is the point of a pin — never show the number alone */}
                <div className="truncate font-mono text-[9.5px] text-dim2">
                  {c.title} · {pin.provenance.tool} · n={pin.provenance.sample_size}
                </div>
              </Row>
            ))
          )}
        </Section>
      </div>
    </div>
  );
}
