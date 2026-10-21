// Kalshi Trading page (SWIT-130). The repo has no DOM test environment (vitest
// runs in node, no jsdom / testing-library), so the page is tested the way the
// shell's other views are: server-render the hook-free views to markup, walk
// the element tree of the hook-free table to "click" a row, and drive the real
// api client against a mocked fetch to see the request a click makes. What
// that cannot reach (usePoll effects, the date input) is covered at the seams:
// usePoll.test.ts for the stale-drop, kalshiFlow.test.ts for the guards.
//
// Fixtures are shaped like the verified backend: a rung is a CODE ("MIA5")
// with a readable label ("MIA -4.5"); prices are cents; pcts are 0-100;
// price_zero_share is 0-1.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NbaFlowGame, NbaFlowGameDetail, NbaFlowGames, NbaFlowLine } from "../api/client";
import { selectionReducer } from "../lib/kalshiFlow";

// uPlot touches `document` at import; the chart is not what these tests are about.
vi.mock("../../../surfaces/charts/LinePanel", () => ({
  default: (p: { series: { label: string }[]; intraday?: boolean; points?: string[] }) =>
    createElement("div", {
      "data-chart": p.series.map((s) => s.label).join("|"),
      "data-intraday": String(p.intraday),
      "data-points": p.points ? "yes" : "no",
    }),
}));

import FlowGameDetail from "../components/trading/FlowGameDetail";
import FlowGamesTable from "../components/trading/FlowGamesTable";
import KalshiTrading, { loadFlowDetail } from "./KalshiTrading";

const line = (rung: string | null, rungLabel: string | null, a: string, b: string, o: Partial<NbaFlowLine> = {}): NbaFlowLine => ({
  rung,
  rung_label: rungLabel,
  bets: 412,
  handle: 18_240,
  sides: [
    { side: a, bets: 300, handle: 4_000, big_bets: 1, big_handle: 1_500, ticket_pct: 73, money_pct: 22, gap: -51, price_first: 44, price_last: 41 },
    { side: b, bets: 112, handle: 14_240, big_bets: 8, big_handle: 11_000, ticket_pct: 27, money_pct: 78, gap: 51, price_first: 56, price_last: 59 },
  ],
  lean: b,
  result: null,
  ...o,
});

const GAME: NbaFlowGame = {
  game: "26OCT21MINMIA",
  away: "MIN",
  home: "MIA",
  tip_utc: "2026-10-21T23:30:00Z",
  status: "final",
  away_score: 101,
  home_score: 108,
  price_zero_share: 0.05,
  lines: {
    ml: line(null, null, "MIN", "MIA", { result: "MIA" }),
    spread: line("MIA5", "MIA -4.5", "MIN +4.5", "MIA -4.5", { result: "MIN +4.5" }),
    total: null,
  },
};

const html = (n: ReactElement) => renderToStaticMarkup(n);

// Expand hook-free function components so the host elements underneath can be found.
function expand(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expand);
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (typeof el.type === "function") return expand((el.type as (p: unknown) => ReactNode)(el.props));
  return { ...el, props: { ...el.props, children: expand(el.props.children) } } as ReactElement;
}
function findAll(node: ReactNode, pred: (props: Record<string, unknown>) => boolean, out: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) node.forEach((n) => findAll(n, pred, out));
  else if (isValidElement(node)) {
    const el = node as ReactElement<Record<string, unknown>>;
    if (pred(el.props)) out.push(el);
    findAll(el.props.children as ReactNode, pred, out);
  }
  return out;
}

describe("games table", () => {
  const props = { games: [GAME], selected: null, phase: "all" as const, onRow: () => {}, onLine: () => {} };

  it("draws the matchup, each side of each line with its two shares, the lean and the result", () => {
    const out = html(createElement(FlowGamesTable, props));
    expect(out).toContain("MIN @ MIA");
    expect(out).toContain("final");
    expect(out).toContain("MIN 101 - MIA 108");
    for (const s of ["MIN", "MIA", "MIN +4.5", "MIA -4.5"]) expect(out).toContain(`data-side="${s}"`);
    expect(out).toContain("73%");
    expect(out).toContain("78%");
    expect(out).toContain("lean MIA -4.5 +51"); // the lean chip
    expect(out).toContain("won MIA · lean won"); // ML: lean side won
    expect(out).toContain("won MIN +4.5 · lean lost"); // spread: it did not
    expect(out).toContain("no bets on tape"); // the empty total (phase all)
    expect(out).toContain("$1k+ 9 bets");
    // one big bet reads "1 bet", never "1 bets"
    const one = line(null, null, "MIN", "MIA");
    one.sides[0].big_bets = 0;
    one.sides[1].big_bets = 1;
    const single = html(createElement(FlowGamesTable, { ...props, games: [{ ...GAME, lines: { ml: one, spread: null, total: null } }] }));
    expect(single).toContain("$1k+ 1 bet ·");
    expect(single).not.toMatch(/\b1 bets\b/);
  });

  it("shows the readable rung, never the code", () => {
    const out = html(createElement(FlowGamesTable, props));
    expect(out).toContain("MIA -4.5");
    expect(out).not.toContain("MIA5");
    // a line with no label falls back to its code
    const coded = { ...GAME, lines: { ...GAME.lines, spread: { ...GAME.lines.spread!, rung_label: undefined } } };
    expect(html(createElement(FlowGamesTable, { ...props, games: [coded] }))).toContain("MIA5");
  });

  it("marks rows and cells for pins", () => {
    const out = html(createElement(FlowGamesTable, props));
    expect(out).toContain('data-anchor="game:26OCT21MINMIA"');
    expect(out).toContain('data-anchor="line:26OCT21MINMIA:ml"');
    expect(out).toContain('data-anchor="line:26OCT21MINMIA:spread"');
    expect(out).toContain('data-anchor-label="MIN @ MIA · Spread MIA -4.5"');
  });

  it("gives every number its meaning for a screen reader, and nests no interactive role", () => {
    const out = html(createElement(FlowGamesTable, props));
    expect(out).toContain("MIN +4.5: 73% of bets, 22% of money");
    expect(out).toContain("MIA -4.5: 27% of bets, 78% of money");
    // a list, not a table with button rows
    expect(out).toContain("<ul");
    expect(out).toContain("<li");
    expect(out).not.toContain('role="table"');
    expect(out).not.toContain('role="row"');
    // the row's own button is the matchup; cells are buttons; no button holds a button
    const tree = expand(FlowGamesTable(props));
    const buttons = findAll(tree, (p) => p.role === "button" || (p["aria-expanded"] !== undefined));
    expect(buttons.length).toBe(3); // matchup, ML, spread (the total has no bets and is not openable)
    for (const b of buttons) {
      expect(findAll(b.props.children as ReactNode, (p) => p.role === "button")).toEqual([]);
    }
  });

  it("in pregame mode a line with no pregame bets says so and still opens the detail", () => {
    const onLine = vi.fn();
    const p = { ...props, phase: "pregame" as const, onLine };
    const out = html(createElement(FlowGamesTable, p));
    expect(out).toContain("no pregame bets");
    expect(out).not.toContain("no bets on tape");
    const tree = expand(FlowGamesTable(p));
    const cell = findAll(tree, (q) => q["data-anchor"] === "line:26OCT21MINMIA:total")[0];
    (cell.props.onClick as (e: { stopPropagation(): void }) => void)({ stopPropagation() {} });
    expect(onLine).toHaveBeenCalledWith(GAME, "total");
  });

  it("shows the outage chip only above 0.2", () => {
    const low = html(createElement(FlowGamesTable, props));
    expect(low).not.toContain("handle incomplete (capture outage)");
    const high = html(createElement(FlowGamesTable, { ...props, games: [{ ...GAME, price_zero_share: 0.35 }] }));
    expect(high).toContain("handle incomplete (capture outage)");
  });

  it("clicking a row, or a line cell, reports the game and the line", () => {
    const onRow = vi.fn();
    const onLine = vi.fn();
    const tree = expand(FlowGamesTable({ ...props, onRow, onLine }));
    const row = findAll(tree, (p) => p["data-anchor"] === "game:26OCT21MINMIA")[0];
    (row.props.onClick as () => void)();
    expect(onRow).toHaveBeenCalledWith(GAME);
    const cell = findAll(tree, (p) => p["data-anchor"] === "line:26OCT21MINMIA:spread")[0];
    const stop = vi.fn();
    (cell.props.onClick as (e: { stopPropagation(): void }) => void)({ stopPropagation: stop });
    expect(stop).toHaveBeenCalled(); // the cell does not also toggle the row
    expect(onLine).toHaveBeenCalledWith(GAME, "spread");
  });
});

describe("a click requests /nba/flow/game", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("row click -> selection -> the real client asks for that game's first line", async () => {
    const detail = { game: GAME.game, line: "ml", timeline: [] } as unknown as NbaFlowGameDetail;
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => detail }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const sel = selectionReducer(null, { type: "row", game: GAME });
    expect(sel).not.toBeNull();
    await loadFlowDetail(sel!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("http://127.0.0.1:8799/nba/flow/game?game=26OCT21MINMIA&line=ml&bucket_min=15");
  });

  it("a spread cell with a chosen rung sends the rung CODE, not the label", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    let sel = selectionReducer(null, { type: "line", game: GAME, line: "spread" });
    sel = selectionReducer(sel, { type: "rung", rung: "MIA6" });
    await loadFlowDetail(sel!);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(
      "http://127.0.0.1:8799/nba/flow/game?game=26OCT21MINMIA&line=spread&rung=MIA6&bucket_min=15",
    );
  });

  it("the slate request carries the date and the phase", async () => {
    const slate: NbaFlowGames = { date: "2026-10-21", phase: "all", games: [] };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => slate }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../api/client");
    await api.getNbaFlowGames("2026-10-21", "all");
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("http://127.0.0.1:8799/nba/flow/games?date=2026-10-21&phase=all");
  });
});

describe("game detail", () => {
  const T0 = Date.parse("2026-10-21T20:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const detail: NbaFlowGameDetail = {
    game: GAME.game,
    line: "spread",
    rung: "MIA5",
    rung_label: "MIA -4.5",
    tip_utc: GAME.tip_utc,
    // the backend's order: home side first - the page puts the away side first
    sides: ["MIA -4.5", "MIN +4.5"],
    timeline: [
      { t: iso(T0), side: "MIN +4.5", bets: 5, handle: 50, big_bets: 0, big_handle: 0, price: 44 },
      { t: iso(T0 + 15 * 60_000), side: "MIA -4.5", bets: 2, handle: 3000, big_bets: 2, big_handle: 3000, price: 57 },
    ],
    sizes: [
      { bucket: "<$10", side: "MIN +4.5", bets: 4, handle: 20 },
      { bucket: "$1k-10k", side: "MIA -4.5", bets: 2, handle: 3000 },
    ],
    rungs: [
      { rung: "MIA5", label: "MIA -4.5", bets: 7, handle: 3050 },
      { rung: "MIA6", label: "MIA -5.5", bets: 1, handle: 10 },
    ],
    price_zero_share: 0.4,
  };
  const base = {
    game: GAME,
    selection: { game: GAME.game, line: "spread" as const, rung: null },
    phase: "all" as const,
    previous: null,
    error: null,
    onLine: () => {},
    onRung: () => {},
    onClose: () => {},
  };

  it("draws the line selector, rung dropdown (labels shown, codes sent), both charts and the outage chip", () => {
    const out = html(createElement(FlowGameDetail, { ...base, detail }));
    expect(out).toContain("Moneyline");
    expect(out).toContain("Spread");
    expect(out).toContain('<option value="MIA5" selected="">MIA -4.5 · 7 bets');
    expect(out).toContain('<option value="MIA6">MIA -5.5 · 1 bet ·');
    expect(out).not.toContain(">MIA5<");
    expect(out).toContain("cumulative handle by side");
    expect(out).toContain("bets in the bucket the tip falls inside appear after the marker");
    expect(out).toContain("price paid per $1");
    expect(out).toContain("handle incomplete (capture outage)");
    expect(out).toContain("whole tape: pregame + in play");
    // away side first on both charts, whatever order the backend used
    expect((out.match(/data-chart="MIN \+4.5\|MIA -4.5"/g) ?? []).length).toBe(2);
    // only the first chart publishes pt: anchors
    expect((out.match(/data-points="yes"/g) ?? []).length).toBe(1);
    expect(out).toContain('data-intraday="true"');
  });

  it("shows the rung the answer is for, even when it is not the one asked for", () => {
    // the backend substituted its main rung (MIA5) for the one chosen (MIA6)
    const out = html(createElement(FlowGameDetail, { ...base, selection: { ...base.selection, rung: "MIA6" }, detail }));
    expect(out).toContain('<option value="MIA5" selected="">');
    expect(out).not.toContain('<option value="MIA6" selected="">');
  });

  it("while a chosen rung loads, the select shows the chosen rung", () => {
    const out = html(createElement(FlowGameDetail, { ...base, selection: { ...base.selection, rung: "MIA6" }, detail: null, previous: detail }));
    expect(out).toContain('<option value="MIA6" selected="">');
  });

  it("after a line change nothing from the old line is selectable until the new answer lands", () => {
    // the page passes previous = null when the line differs
    const out = html(createElement(FlowGameDetail, { ...base, selection: { game: GAME.game, line: "total", rung: null }, detail: null, previous: null }));
    expect(out).toContain("Spread"); // the line tabs stay
    expect(out).not.toContain("<select");
    expect(out).toContain("loading game flow");
  });

  it("orders the sides away-first from the game code when the slate row is not there", () => {
    const out = html(createElement(FlowGameDetail, { ...base, game: undefined, detail }));
    expect((out.match(/data-chart="MIN \+4.5\|MIA -4.5"/g) ?? []).length).toBe(2);
  });

  it("anchors the panel as detail:<game>:<line>, not as the game row", () => {
    const out = html(createElement(FlowGameDetail, { ...base, detail }));
    expect(out).toContain('data-anchor="detail:26OCT21MINMIA:spread"');
    expect(out).not.toContain('data-anchor="game:');
  });

  it("puts a text summary under each chart", () => {
    const out = html(createElement(FlowGameDetail, { ...base, detail }));
    expect(out).toMatch(/MIN \+4\.5 \d+% of bets, \d+% of money; MIA -4\.5 \d+% of bets, \d+% of money; money leans MIA -4\.5/);
    expect(out).toContain("MIN +4.5 44c; MIA -4.5 57c");
  });

  it("the size mix is a real table with column and row headers", () => {
    const out = html(createElement(FlowGameDetail, { ...base, detail }));
    expect(out).toContain('scope="col"');
    for (const h of ["bet size", "side", "bets", "handle", "avg bet"]) expect(out).toContain(`>${h}</th>`);
    for (const b of ["&lt;$10", "$10-100", "$100-1k", "$1k-10k", "$10k+"]) expect(out).toContain(`data-size-bucket="${b}"`);
    expect(out).toContain('scope="row"');
  });

  it("spans over a day draw a dated axis", () => {
    const long = { ...detail, timeline: [...detail.timeline, { ...detail.timeline[0], t: iso(T0 + 30 * 3600_000) }] };
    const out = html(createElement(FlowGameDetail, { ...base, detail: long }));
    expect(out).toContain('data-intraday="false"');
  });

  it("line tabs: a line with no bets is disabled in All mode and openable in Pregame mode", () => {
    const all = html(createElement(FlowGameDetail, { ...base, detail }));
    expect(all).toMatch(/<button[^>]*disabled=""[^>]*>Total<\/button>/);
    expect(all).not.toMatch(/<button[^>]*disabled=""[^>]*>Spread<\/button>/);
    const pre = html(createElement(FlowGameDetail, { ...base, phase: "pregame", detail }));
    expect(pre).not.toMatch(/<button[^>]*disabled=""[^>]*>Total<\/button>/);
  });

  it("while the next line or rung loads, the controls stay mounted from the previous answer", () => {
    const out = html(createElement(FlowGameDetail, { ...base, detail: null, previous: detail }));
    expect(out).toContain("loading game flow");
    expect(out).toContain('<option value="MIA6">'); // the rung select did not unmount
    expect(out).toContain('aria-busy="true"');
    expect(out).not.toContain("<select disabled");
    // with nothing to keep there is nothing to show
    expect(html(createElement(FlowGameDetail, { ...base, detail: null }))).not.toContain("<select");
  });

  it("error and empty states say what happened", () => {
    expect(html(createElement(FlowGameDetail, { ...base, detail: null, error: "Error: GET /x -> 404 Not Found" }))).toContain(
      "endpoint returned 404 Not Found",
    );
    expect(html(createElement(FlowGameDetail, { ...base, detail: null, error: "TypeError: Failed to fetch" }))).toContain(
      "backend unreachable",
    );
    const empty = { ...detail, timeline: [], sizes: [], price_zero_share: 0 };
    expect(html(createElement(FlowGameDetail, { ...base, detail: empty }))).toContain("no bets on tape for this line");
  });
});

describe("the page", () => {
  it("opens on Flow with the controls, the help and a loading state; Positions is only a placeholder tab", () => {
    const out = html(createElement(KalshiTrading));
    expect(out).toContain("Kalshi Trading");
    expect(out).toMatch(/aria-selected="true"[^>]*>Flow</);
    expect(out).toContain("Pregame");
    expect(out).toContain('type="date"');
    expect(out).toContain("how to read this");
    expect(out).toContain("one taker order");
    expect(out).toContain("$1,000 or more");
    expect(out).toContain("loading NBA flow");
    expect(out).not.toMatch(/grey|blue/);
  });
});
