// Kalshi Trading page (SWIT-130). The repo has no DOM test environment (vitest
// runs in node, no jsdom / testing-library), so the page is tested the way the
// shell's other views are: server-render the hook-free views to markup, walk
// the element tree of the hook-free table to "click" a row, and drive the real
// api client against a mocked fetch to see the request a click makes.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NbaFlowGame, NbaFlowGameDetail, NbaFlowGames, NbaFlowLine } from "../api/client";
import { selectionReducer } from "../lib/kalshiFlow";

// uPlot touches `document` at import; the chart is not what these tests are about.
vi.mock("../../../surfaces/charts/LinePanel", () => ({
  default: (p: { series: { label: string }[] }) => createElement("div", { "data-chart": p.series.map((s) => s.label).join("|") }),
}));

import FlowGameDetail from "../components/trading/FlowGameDetail";
import FlowGamesTable from "../components/trading/FlowGamesTable";
import KalshiTrading, { loadFlowDetail } from "./KalshiTrading";

const line = (rung: string | null, a: string, b: string, o: Partial<NbaFlowLine> = {}): NbaFlowLine => ({
  rung,
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
    ml: line(null, "MIN", "MIA", { result: "MIA" }),
    spread: line("MIA -4.5", "MIN +4.5", "MIA -4.5", { result: "MIN +4.5" }),
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
  const props = { games: [GAME], selected: null, onRow: () => {}, onLine: () => {} };

  it("draws the matchup, each side of each line with its two shares, the lean and the result", () => {
    const out = html(createElement(FlowGamesTable, props));
    expect(out).toContain("MIN @ MIA");
    expect(out).toContain("final");
    expect(out).toContain("MIN 101 - MIA 108");
    for (const s of ["MIN", "MIA", "MIN +4.5", "MIA -4.5"]) expect(out).toContain(`data-side="${s}"`);
    expect(out).toContain("MIA -4.5"); // the rung label
    expect(out).toContain("73%");
    expect(out).toContain("78%");
    expect(out).toContain("lean MIA +51"); // the lean chip
    expect(out).toContain("won MIA · lean won"); // ML: lean side won
    expect(out).toContain("won MIN +4.5 · lean lost"); // spread: it did not
    expect(out).toContain("no bets on tape"); // the empty total
  });

  it("marks rows and cells for pins", () => {
    const out = html(createElement(FlowGamesTable, props));
    expect(out).toContain('data-anchor="game:26OCT21MINMIA"');
    expect(out).toContain('data-anchor="line:26OCT21MINMIA:ml"');
    expect(out).toContain('data-anchor="line:26OCT21MINMIA:spread"');
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

  it("a spread cell with a chosen rung sends the rung", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    let sel = selectionReducer(null, { type: "line", game: GAME, line: "spread" });
    sel = selectionReducer(sel, { type: "rung", rung: "MIA -5.5" });
    await loadFlowDetail(sel!);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(
      "http://127.0.0.1:8799/nba/flow/game?game=26OCT21MINMIA&line=spread&rung=MIA+-5.5&bucket_min=15",
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
  const detail: NbaFlowGameDetail = {
    game: GAME.game,
    line: "spread",
    rung: "MIA -4.5",
    tip_utc: GAME.tip_utc,
    sides: ["MIN +4.5", "MIA -4.5"],
    timeline: [
      { t: "2026-10-21T20:00:00Z", side: "MIN +4.5", bets: 5, handle: 50, big_bets: 0, big_handle: 0, price: 44 },
      { t: "2026-10-21T20:15:00Z", side: "MIA -4.5", bets: 2, handle: 3000, big_bets: 2, big_handle: 3000, price: 57 },
    ],
    sizes: [
      { bucket: "<$10", side: "MIN +4.5", bets: 4, handle: 20 },
      { bucket: "$1k-10k", side: "MIA -4.5", bets: 2, handle: 3000 },
    ],
    rungs: [
      { rung: "MIA -4.5", bets: 7, handle: 3050 },
      { rung: "MIA -5.5", bets: 1, handle: 10 },
    ],
    price_zero_share: 0.4,
  };
  const base = { game: GAME, selection: { game: GAME.game, line: "spread" as const, rung: null }, error: null, onLine: () => {}, onRung: () => {}, onClose: () => {} };

  it("draws the line selector, rung dropdown, both charts, the size buckets and the outage chip", () => {
    const out = html(createElement(FlowGameDetail, { ...base, detail }));
    expect(out).toContain("Moneyline");
    expect(out).toContain("Spread");
    expect(out).toContain("MIA -5.5 · 1 bets");
    expect(out).toContain("cumulative handle by side");
    expect(out).toContain("price paid per $1");
    expect((out.match(/data-chart="MIN \+4.5\|MIA -4.5"/g) ?? []).length).toBe(2);
    for (const b of ["&lt;$10", "$10-100", "$100-1k", "$1k-10k", "$10k+"]) expect(out).toContain(`data-size-bucket="${b}"`);
    expect(out).toContain("handle incomplete (capture outage)");
    // the total line has no bets, so its tab is disabled
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Total<\/button>/);
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*>Spread<\/button>/);
  });

  it("loading, error and empty states", () => {
    expect(html(createElement(FlowGameDetail, { ...base, detail: null }))).toContain("loading game flow");
    expect(html(createElement(FlowGameDetail, { ...base, detail: null, error: "boom" }))).toContain("backend unreachable - boom");
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
  });
});
