// Kalshi Trading page (SWIT-130). The repo has no DOM test environment (vitest
// runs in node, no jsdom / testing-library), so the page is tested the way the
// shell's other views are: server-render the views to markup, walk the element
// tree of the hook-free board to "click" a row, and drive the real api client
// against a mocked fetch to see the request a click makes. What that cannot
// reach (usePoll effects, the date input) is covered at the seams:
// usePoll.test.ts for the stale-drop, kalshiFlow.test.ts for the guards.
//
// Fixtures are shaped like the verified backend: a rung is a CODE ("MIA5")
// with a readable label ("MIA -4.5"); prices are cents; pcts are 0-100;
// price_zero_share is 0-1; DraftKings sends percentages only.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  NbaFlowBookGame,
  NbaFlowBookLine,
  NbaFlowBookSeries,
  NbaFlowGame,
  NbaFlowGameDetail,
  NbaFlowGames,
  NbaFlowLine,
  NbaFlowSizeRow,
  NbaFlowTimelineRow,
} from "../api/client";
import { biggestSplits, selectionReducer, type FlowSource } from "../lib/kalshiFlow";
import FlowBoard, { boardLegend } from "../components/trading/FlowBoard";
import FlowGameDetail, { type FlowGameDetailProps } from "../components/trading/FlowGameDetail";
import { FlowChartSvg, readoutFor } from "../components/trading/FlowShareChart";
import { SplitBar, SplitRow } from "../components/trading/SplitBars";
import type { SharePoint } from "../lib/kalshiFlowSeries";
import FlowSplits from "../components/trading/FlowSplits";
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

/** The same game with no Kalshi bets at all (tonight's slate before the tape fills). */
const EMPTY_GAME: NbaFlowGame = { ...GAME, status: "scheduled", away_score: null, home_score: null, lines: { ml: null, spread: null, total: null } };

const DK_ML: NbaFlowBookLine = {
  line_label: null,
  sides: [
    { side: "MIA", handle_pct: 91, bets_pct: 60, odds: -150 },
    { side: "MIN", handle_pct: 9, bets_pct: 40, odds: 130 },
  ],
};
const DK_SPREAD: NbaFlowBookLine = {
  line_label: "MIA -2.5",
  sides: [
    { side: "MIA -2.5", handle_pct: 70, bets_pct: 55 },
    { side: "MIN +2.5", handle_pct: 30, bets_pct: 45 },
  ],
};
const BOOK: NbaFlowBookGame = { game: GAME.game, captured_at: "2026-10-21T17:00:00Z", lines: { ml: DK_ML, spread: DK_SPREAD } };
const BOOKS = { games: [BOOK] };

const html = (n: ReactElement) => renderToStaticMarkup(n);
/** Rendered text only: tags and React's text-node separators out. */
const text = (markup: string) => markup.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

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

const boardProps = (o: Partial<Parameters<typeof FlowBoard>[0]> = {}) => ({
  games: [GAME],
  books: null,
  source: "kalshi" as FlowSource,
  phase: "all" as const,
  selected: null,
  sort: "tip" as const,
  onSort: () => {},
  onRow: () => {},
  onLine: () => {},
  ...o,
});

describe("the board", () => {
  it("draws the matchup, the score, each market's sides with their price and two bars, the lean and the result", () => {
    const out = html(createElement(FlowBoard, boardProps()));
    const t = text(out);
    expect(t).toContain("MIN");
    expect(t).toContain("MIA");
    expect(t).toContain("101");
    expect(t).toContain("108");
    expect(t).toContain("Final · tip 7:30 PM");
    for (const s of ["MIN", "MIA", "MIN +4.5", "MIA -4.5"]) expect(out).toContain(`data-side="${s}"`);
    expect(t).toContain("73%");
    expect(t).toContain("78%");
    expect(t).toContain("41¢");
    expect(t).toContain("59¢");
    expect(t).toContain("$ → MIA +51"); // the loud lean chip
    expect(t).toContain("412 bets · $18.2k");
    // the winner carries a check; the loser does not
    expect(out).toMatch(/MIA<span[^>]*>\s?✓/);
    // a plain Kalshi board with no DraftKings says nothing about sources
    expect(t).not.toContain("Kalshi only");
    expect(t).not.toContain("DK ");
  });

  it("a single big bet or a lone bet reads in the singular", () => {
    const one = line(null, null, "MIN", "MIA", { bets: 1, handle: 50 });
    const out = text(html(createElement(FlowBoard, boardProps({ games: [{ ...GAME, lines: { ml: one, spread: null, total: null } }] }))));
    expect(out).toContain("1 bet · $50");
    expect(out).not.toMatch(/\b1 bets\b/);
  });

  it("shows the readable rung on the cell's pin label, never the code", () => {
    const out = html(createElement(FlowBoard, boardProps()));
    expect(out).toContain('data-anchor-label="MIN @ MIA · Spread MIA -4.5"');
    expect(out).not.toContain("MIA5");
  });

  it("marks rows and cells for pins", () => {
    const out = html(createElement(FlowBoard, boardProps()));
    expect(out).toContain('data-anchor="game:26OCT21MINMIA"');
    expect(out).toContain('data-anchor="line:26OCT21MINMIA:ml"');
    expect(out).toContain('data-anchor="line:26OCT21MINMIA:spread"');
  });

  it("an empty market folds to one line and is not a button", () => {
    const all = html(createElement(FlowBoard, boardProps()));
    expect(text(all)).toContain("No bets recorded");
    expect(all).not.toContain('data-anchor="line:26OCT21MINMIA:total"');
    const pre = html(createElement(FlowBoard, boardProps({ phase: "pregame" })));
    expect(text(pre)).toContain("No bets before the tip");
  });

  it("gives every number its meaning for a screen reader, and nests no interactive role", () => {
    const out = html(createElement(FlowBoard, boardProps()));
    expect(out).toContain("MIN: 73% of bets, 22% of money");
    expect(out).toContain("MIA: 27% of bets, 78% of money");
    expect(out).toContain("<ul");
    expect(out).toContain("<li");
    const tree = expand(FlowBoard(boardProps()));
    const buttons = findAll(tree, (p) => p.role === "button" || p["aria-expanded"] !== undefined);
    expect(buttons.length).toBe(3); // the matchup, ML, spread (the total has no bets)
    for (const b of buttons) expect(findAll(b.props.children as ReactNode, (p) => p.role === "button")).toEqual([]);
  });

  it("shows the outage chip only above 0.2", () => {
    expect(html(createElement(FlowBoard, boardProps()))).not.toContain("Handle incomplete (capture outage)");
    const high = html(createElement(FlowBoard, boardProps({ games: [{ ...GAME, price_zero_share: 0.35 }] })));
    expect(high).toContain("Handle incomplete (capture outage)");
  });

  it("clicking a row, or a cell, reports the game and the line; the cell does not also open the row", () => {
    const onRow = vi.fn();
    const onLine = vi.fn();
    const tree = expand(FlowBoard(boardProps({ onRow, onLine, books: BOOKS })));
    const row = findAll(tree, (p) => p["data-anchor"] === "game:26OCT21MINMIA")[0];
    (row.props.onClick as () => void)();
    expect(onRow).toHaveBeenCalledWith(GAME, BOOK);
    const cell = findAll(tree, (p) => p["data-anchor"] === "line:26OCT21MINMIA:spread")[0];
    const stop = vi.fn();
    (cell.props.onClick as (e: { stopPropagation(): void }) => void)({ stopPropagation: stop });
    expect(stop).toHaveBeenCalled();
    expect(onLine).toHaveBeenCalledWith(GAME, "spread");
  });

  it("the sort switch reports the choice", () => {
    const onSort = vi.fn();
    const tree = expand(FlowBoard(boardProps({ onSort })));
    const gap = findAll(tree, (p) => p["data-seg"] === "gap")[0];
    (gap.props.onClick as () => void)();
    expect(onSort).toHaveBeenCalledWith("gap");
  });

  describe("the source switch", () => {
    const withBooks = (source: FlowSource) => html(createElement(FlowBoard, boardProps({ books: BOOKS, source })));

    it("Kalshi draws Kalshi's bars with DraftKings as white ticks and one quiet line", () => {
      const out = withBooks("kalshi");
      expect(out).toContain('data-drawn="kalshi"');
      expect(out).toContain('data-tick="40"'); // DraftKings' MIN bets share
      expect(out).toContain('data-tick="9"'); // and its money share
      expect(text(out)).toContain("DK 40% bets · 9% $");
      expect(text(out)).toContain("73%");
    });

    it("DraftKings draws DraftKings' bars with Kalshi as ticks, and its own spread line is named", () => {
      const out = withBooks("dk");
      expect(out).toContain('data-drawn="dk"');
      expect(out).toContain('data-tick="73"'); // Kalshi's MIN bets share
      expect(text(out)).toContain("Kalshi 73% bets · 22% $");
      expect(text(out)).toContain("40%"); // DraftKings' bets share is what the bar says now
      expect(text(out)).not.toContain("73% "); // no stray
    });

    it("Both draws the plain average, says so, and draws no ticks", () => {
      const out = withBooks("both");
      expect(out).toContain('data-drawn="avg"');
      expect(text(out)).toContain("Avg of Kalshi + DK");
      expect(out).not.toContain("data-tick=");
      // MIN bets (73 + 40) / 2 = 56.5, money (22 + 9) / 2 = 15.5; MIA bets 43.5, money 84.5
      const t = text(out);
      // the two printed shares always add to 100: the left is rounded, the right is the rest
      expect(t).toContain("57%");
      expect(t).toContain("16%");
      expect(t).toContain("43%");
      expect(t).toContain("84%");
      // DraftKings' own spread line differs from Kalshi's, so it is named
      expect(t).toContain("DK line MIA -2.5");
    });
  });

  it("a market only Kalshi has says Kalshi only when Both was asked for", () => {
    const out = html(createElement(FlowBoard, boardProps({ books: { games: [] }, source: "both" })));
    expect(text(out)).toContain("Kalshi only");
    expect(out).toContain('data-drawn="kalshi"');
  });

  it("a market only DraftKings has (no Kalshi bets yet) draws DraftKings and gives no dollars, price or result", () => {
    const out = html(createElement(FlowBoard, boardProps({ games: [EMPTY_GAME], books: BOOKS, source: "kalshi" })));
    const t = text(out);
    expect(out).toContain('data-drawn="dk"');
    expect(t).toContain("DraftKings only");
    expect(t).toContain("No dollar figures");
    expect(t).toContain("40%");
    expect(t).toContain("91%");
    expect(t).not.toMatch(/\d¢/); // no price: DraftKings has none
    expect(t).not.toContain("bets · $");
    // the cell is still openable: DraftKings' split is something to read
    expect(out).toContain('data-anchor="line:26OCT21MINMIA:ml"');
    // spread: DraftKings' own sides, away first
    expect(out).toContain('data-side="MIN +2.5"');
  });
});

describe("a spread DraftKings has the other way round", () => {
  // Kalshi: MIN +4.5 / MIA -4.5. DraftKings has MIN as the favourite: MIN -2.5 / MIA +2.5.
  const OTHER_WAY: NbaFlowBookGame = {
    game: GAME.game,
    captured_at: "2026-10-21T17:00:00Z",
    lines: { spread: { line_label: "MIN -2.5", sides: [{ side: "MIN -2.5", handle_pct: 12, bets_pct: 58 }, { side: "MIA +2.5", handle_pct: 88, bets_pct: 42 }] } },
  };
  it("the board uses none of DraftKings numbers for it - no ticks, no average - and says why", () => {
    for (const source of ["kalshi", "dk", "both"] as const) {
      const out = html(createElement(FlowBoard, boardProps({ books: { games: [OTHER_WAY] }, source })));
      const t = text(out);
      expect(t).toContain("DK favours the other side: MIN -2.5");
      expect(out).toContain('data-drawn="kalshi"');
      expect(out).not.toContain('data-drawn="avg"');
      expect(out).not.toContain("data-tick=");
      expect(t).not.toContain("DK line"); // the line note would be a second, misleading line
    }
  });
  it("the detail says it under the side instead of showing DraftKings numbers, and draws no dotted line", () => {
    const series: NbaFlowBookSeries = {
      game: GAME.game, line: "spread", book: "draftkings",
      series: [
        { t: "2026-10-21T20:00:00Z", sides: [{ side: "MIN -2.5", handle_pct: 12, bets_pct: 58 }, { side: "MIA +2.5", handle_pct: 88, bets_pct: 42 }] },
        { t: "2026-10-21T22:00:00Z", sides: [{ side: "MIN -2.5", handle_pct: 14, bets_pct: 57 }, { side: "MIA +2.5", handle_pct: 86, bets_pct: 43 }] },
      ],
    };
    const out = detail({ book: OTHER_WAY, bookSeries: series });
    expect(text(out)).toContain("DK favours the other side: MIN -2.5");
    expect(text(out)).not.toContain("DraftKings 58% bets");
    expect(out).not.toContain('data-series="dk-money"');
    expect(text(out)).not.toContain("DK money on");
  });
});

describe("the printed shares", () => {
  it("a row's two shares always add to 100", () => {
    for (const [a, l, r] of [[56.5, "57%", "43%"], [12.5, "13%", "87%"], [15.5, "16%", "84%"], [0.4, "0%", "100%"]] as const) {
      const t = text(html(createElement(SplitRow, { label: "bets", a })));
      expect(t).toContain(l);
      expect(t).toContain(r);
    }
  });
});

describe("biggest splits", () => {
  const entries = biggestSplits([GAME, EMPTY_GAME].slice(0, 1), BOOKS, "kalshi");

  it("draws the strip with the side, its two shares, the gap, the dollars and the result", () => {
    const out = html(createElement(FlowSplits, { entries, source: "kalshi", phase: "pregame", onOpen: () => {} }));
    const t = text(out);
    expect(t).toContain("Biggest splits");
    expect(t).toContain("Kalshi lines with $5k+");
    expect(t).toContain("before tip");
    expect(t).toContain("MIN @ MIA");
    expect(t).toContain("+51 pts · $18.2k · 412 bets");
    expect(out).toContain('data-tick="'); // DraftKings' share on the featured side's own scale
    expect(t).toMatch(/Won|Lost/);
  });

  it("DraftKings mode ranks DraftKings shares with no dollar gate and labels it so", () => {
    const dkEntries = biggestSplits([EMPTY_GAME], BOOKS, "dk");
    expect(dkEntries.length).toBeGreaterThan(0);
    const t = text(html(createElement(FlowSplits, { entries: dkEntries, source: "dk", phase: "pregame", onOpen: () => {} })));
    expect(t).toContain("DraftKings shares, no dollar gate");
    expect(t).not.toContain("$5k+");
    expect(t).toContain("no dollar figures");
    // with Kalshi bets on the line the label does not claim there are none
    const withKalshi = text(html(createElement(FlowSplits, { entries: biggestSplits([GAME], BOOKS, "dk"), source: "dk", phase: "pregame", onOpen: () => {} })));
    expect(withKalshi).toContain("DraftKings shares, no dollar gate");
    expect(withKalshi).not.toContain("no Kalshi bets yet");
    expect(withKalshi).toContain("$18.2k");
  });

  it("Kalshi and Both never list a DraftKings-only line, and Both says it is the average", () => {
    expect(biggestSplits([EMPTY_GAME], BOOKS, "kalshi")).toEqual([]);
    expect(biggestSplits([EMPTY_GAME], BOOKS, "both")).toEqual([]);
    const both = text(html(createElement(FlowSplits, { entries: biggestSplits([GAME], BOOKS, "both"), source: "both", phase: "all", onOpen: () => {} })));
    expect(both).toContain("Kalshi lines with $5k+ \u00b7 avg of Kalshi + DK");
    expect(both).toContain("whole game");
  });

  it("an empty strip folds to one line, and a click opens the game on that line", () => {
    expect(text(html(createElement(FlowSplits, { entries: [], source: "kalshi", phase: "all", onOpen: () => {} })))).toContain(
      "No line has money ahead of its bets yet",
    );
    const onOpen = vi.fn();
    const tree = expand(FlowSplits({ entries, source: "kalshi", phase: "all", onOpen }));
    const first = findAll(tree, (p) => typeof p["data-split"] === "string")[0];
    (first.props.onClick as () => void)();
    expect(onOpen).toHaveBeenCalledWith(entries[0].game, entries[0].line);
  });
});

describe("a click requests the flow endpoints", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = (body: unknown = {}) => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => body }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const url = (m: ReturnType<typeof stub>, i = 0) => (m.mock.calls[i] as unknown[])[0];

  it("row click -> selection -> the real client asks for that game's first line", async () => {
    const fetchMock = stub({ game: GAME.game, line: "ml", timeline: [] });
    const sel = selectionReducer(null, { type: "row", game: GAME });
    expect(sel).not.toBeNull();
    await loadFlowDetail(sel!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url(fetchMock)).toBe("http://127.0.0.1:8799/nba/flow/game?game=26OCT21MINMIA&line=ml&bucket_min=15");
  });

  it("a spread cell with a chosen rung sends the rung CODE, not the label", async () => {
    const fetchMock = stub();
    let sel = selectionReducer(null, { type: "line", game: GAME, line: "spread" });
    sel = selectionReducer(sel, { type: "rung", rung: "MIA6" });
    await loadFlowDetail(sel!);
    expect(url(fetchMock)).toBe("http://127.0.0.1:8799/nba/flow/game?game=26OCT21MINMIA&line=spread&rung=MIA6&bucket_min=15");
  });

  it("the slate request carries the date and the phase", async () => {
    const slate: NbaFlowGames = { date: "2026-10-21", phase: "all", games: [] };
    const fetchMock = stub(slate);
    const { api } = await import("../api/client");
    await api.getNbaFlowGames("2026-10-21", "all");
    expect(url(fetchMock)).toBe("http://127.0.0.1:8799/nba/flow/games?date=2026-10-21&phase=all");
  });

  it("DraftKings' day, its snapshots for a line, and last season's bands are three more requests", async () => {
    const fetchMock = stub({});
    const { api } = await import("../api/client");
    await api.getNbaFlowBooks("2026-10-21");
    await api.getNbaFlowBookSeries("26OCT21MINMIA", "total");
    await api.getNbaFlowGapBands();
    expect(url(fetchMock, 0)).toBe("http://127.0.0.1:8799/nba/flow/books?date=2026-10-21");
    expect(url(fetchMock, 1)).toBe("http://127.0.0.1:8799/nba/flow/books/game?game=26OCT21MINMIA&line=total");
    expect(url(fetchMock, 2)).toBe("http://127.0.0.1:8799/nba/flow/gap_bands");
  });
});

// -- the detail -------------------------------------------------------------------

const T0 = Date.parse("2026-10-21T19:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** 16 buckets before the tip: MIN many small bets, MIA a few large ones. */
function timeline(side: [string, string] = ["MIN", "MIA"]): NbaFlowTimelineRow[] {
  const rows: NbaFlowTimelineRow[] = [];
  for (let i = 0; i < 16; i++) {
    const t = iso(T0 + i * 15 * 60_000);
    rows.push({ t, side: side[0], bets: 4, handle: 40, big_bets: 0, big_handle: 0, price: 44 });
    rows.push({ t, side: side[1], bets: 1, handle: 400 + i * 50, big_bets: i % 4 === 0 ? 1 : 0, big_handle: i % 4 === 0 ? 1200 : 0, price: 57 });
  }
  return rows;
}

const WIDE_SIZES: NbaFlowSizeRow[] = [
  { bucket: "$10-100", side: "MIN", bets: 64, handle: 640 },
  { bucket: "$100-1k", side: "MIA", bets: 12, handle: 7_000 },
  { bucket: "$1k-10k", side: "MIA", bets: 4, handle: 4_800 },
];
// 50 bets each, 52% of the money: an ordinary gap
const ORDINARY_SIZES: NbaFlowSizeRow[] = [
  { bucket: "$10-100", side: "MIN", bets: 50, handle: 4_800 },
  { bucket: "$10-100", side: "MIA", bets: 50, handle: 5_200 },
];

const detailOf = (o: Partial<NbaFlowGameDetail> = {}): NbaFlowGameDetail => ({
  game: GAME.game,
  line: "spread",
  rung: "MIA5",
  rung_label: "MIA -4.5",
  tip_utc: GAME.tip_utc,
  // the backend's order: home side first - the page puts the away side first
  sides: ["MIA -4.5", "MIN +4.5"],
  timeline: timeline(["MIN +4.5", "MIA -4.5"]),
  sizes: WIDE_SIZES.map((r) => ({ ...r, side: r.side === "MIN" ? "MIN +4.5" : "MIA -4.5" })),
  sizes_pregame: WIDE_SIZES.map((r) => ({ ...r, side: r.side === "MIN" ? "MIN +4.5" : "MIA -4.5" })),
  big_bets: [
    { ts: "2026-10-21T20:00:00Z", side: "MIA -4.5", dollars: 1200, contracts: 2_100, price: 57, phase: "pregame" },
    { ts: "2026-10-21T21:00:00Z", side: "MIN +4.5", dollars: 3_400, contracts: 7_200, price: 47, phase: "pregame" },
    { ts: "2026-10-21T23:50:00Z", side: "MIA -4.5", dollars: 2_000, contracts: 3_000, price: null, phase: "live" },
  ],
  rungs: [
    { rung: "MIA5", label: "MIA -4.5", bets: 7, handle: 3050 },
    { rung: "MIA6", label: "MIA -5.5", bets: 1, handle: 10 },
  ],
  price_zero_share: 0.4,
  ...o,
});

const BANDS = { all: Array.from({ length: 101 }, (_, i) => Math.round(i * 0.4 * 10) / 10) };

const detailProps = (o: Partial<FlowGameDetailProps> = {}): FlowGameDetailProps => ({
  game: GAME,
  book: BOOK,
  bookSeries: null,
  bands: BANDS,
  selection: { game: GAME.game, line: "spread", rung: null },
  phase: "pregame",
  detail: detailOf(),
  previous: null,
  error: null,
  range: "pre",
  mode: "share",
  price: true,
  onRange: () => {},
  onMode: () => {},
  onPrice: () => {},
  onLine: () => {},
  onRung: () => {},
  onClose: () => {},
  ...o,
});

const detail = (o: Partial<FlowGameDetailProps> = {}) => html(createElement(FlowGameDetail, detailProps(o)));

describe("game detail", () => {
  it("draws the head, the line tabs, the versus block, the one chart and the three tables", () => {
    const out = detail();
    const t = text(out);
    expect(t).toContain("MIN @ MIA");
    expect(t).toContain("final 101–108");
    expect(t).toContain("tip Wed 7:30 PM ET");
    expect(t).toContain("Handle incomplete (capture outage)");
    for (const h of ["Money vs bets over time", "When the money came in", "Who bet what size", "$1k+ bets"]) expect(t).toContain(h);
    expect(t).toContain("Moneyline");
    expect(t).toContain("Spread");
    // ONE chart
    expect((out.match(/<svg/g) ?? []).length).toBe(1);
    // the away side is on the left, home on the right, whatever order the backend used
    expect(out.indexOf('data-versus="a"')).toBeLessThan(out.indexOf('data-versus="b"'));
    expect(out).toMatch(/data-versus="a"[^]*MIN \+4\.5[^]*data-versus="b"[^]*MIA -4\.5/);
  });

  it("the numbers come from this rung and this phase: shares, counts, dollars, price, $1k+ bets", () => {
    const t = text(detail());
    expect(t).toContain("80% of bets · 64"); // MIN: 64 of 80 bets
    expect(t).toContain("20% of bets · 16");
    expect(t).toContain("last price before tip");
    expect(t).toContain("$1k+ bets · $4.8k");
  });

  it("puts DraftKings under each side as one mono line, matching the spread by team", () => {
    const out = detail();
    expect(text(out)).toContain("DraftKings 45% bets · 30% money"); // MIN +2.5 against Kalshi's MIN +4.5
    expect(text(out)).toContain("DraftKings 55% bets · 70% money");
    expect(detail({ book: undefined })).toContain("No DraftKings split");
    expect(text(detail({ book: undefined }))).toContain("No DraftKings split");
  });

  it("a wide gap that holds without the big bets reads as broad money, against last season", () => {
    const t = text(detail());
    expect(t).toContain("Money leans MIA -4.5");
    expect(t).toMatch(/Gap \d+ pts toward MIA -4\.5, wider than \d+% of spread lines last season \(widest fifth\)/);
    expect(t).toContain("Take out all 4 $1k+ bets (");
    expect(t).toMatch(/without them\): broad money\s*\./);
    expect(t).not.toContain("mostly a few big bets");
    expect(t).toContain("Average bet:");
    expect(t).toContain("Result: MIN +4.5");
  });

  it("an ordinary gap says ordinary and makes no big-bet claim at all", () => {
    const ordinary = detailOf({
      sizes: ORDINARY_SIZES.map((r) => ({ ...r, side: r.side === "MIN" ? "MIN +4.5" : "MIA -4.5" })),
      sizes_pregame: ORDINARY_SIZES.map((r) => ({ ...r, side: r.side === "MIN" ? "MIN +4.5" : "MIA -4.5" })),
    });
    const t = text(detail({ detail: ordinary }));
    expect(t).toMatch(/Gap \d+ pts toward MIA -4\.5, wider than \d+% of spread lines last season \(ordinary\)\./);
    expect(t).toContain("No lean");
    expect(t).not.toMatch(/few big bets|broad money|Take out all|without them/);
  });

  it("a gap that is a few big bets says so", () => {
    const few = detailOf({
      sizes: [
        { bucket: "$1k-10k", side: "MIA -4.5", bets: 3, handle: 9_800 },
        { bucket: "$10-100", side: "MIA -4.5", bets: 17, handle: 200 },
        { bucket: "$10-100", side: "MIN +4.5", bets: 80, handle: 2_000 },
      ],
      sizes_pregame: [
        { bucket: "$1k-10k", side: "MIA -4.5", bets: 3, handle: 9_800 },
        { bucket: "$10-100", side: "MIA -4.5", bets: 17, handle: 200 },
        { bucket: "$10-100", side: "MIN +4.5", bets: 80, handle: 2_000 },
      ],
    });
    const t = text(detail({ detail: few }));
    expect(t).toMatch(/Take out all 3 \$1k\+ bets \(\+63 \u2192 -8 without them\): mostly a few big bets\s*\./);
  });

  it("says nothing about zones when last season's file is missing", () => {
    const t = text(detail({ bands: null }));
    expect(t).toMatch(/Gap \d+ pts toward MIA -4\.5\./);
    expect(t).not.toMatch(/last season|widest fifth|big bets, not|broad money/);
  });

  it("draws the chart's anchors, the DraftKings dotted line, and the $1k+ rail", () => {
    const series: NbaFlowBookSeries = {
      game: GAME.game, line: "spread", book: "draftkings",
      series: [
        { t: "2026-10-21T20:00:00Z", sides: [{ side: "MIA -2.5", handle_pct: 66, bets_pct: 53 }, { side: "MIN +2.5", handle_pct: 34, bets_pct: 47 }] },
        { t: "2026-10-21T22:00:00Z", sides: [{ side: "MIA -2.5", handle_pct: 70, bets_pct: 55 }, { side: "MIN +2.5", handle_pct: 30, bets_pct: 45 }] },
      ],
    };
    const out = detail({ bookSeries: series });
    const anchors = [...out.matchAll(/data-anchor="pt:([^"]+)"/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(3);
    for (const a of anchors) expect(Number.isNaN(Date.parse(a))).toBe(false);
    expect(out).toContain('data-series="dk-money"');
    expect(out).toContain('data-rail="big-bets"');
    expect(text(out)).toContain("DK money on MIN +4.5");
    // without snapshots there is no dotted line and no legend item for it
    expect(detail()).not.toContain('data-series="dk-money"');
    expect(text(detail())).not.toContain("DK money on");
  });

  it("the $1k+ table follows the phase: before tip drops the in-game bets", () => {
    const pre = detail({ phase: "pregame" });
    expect((pre.match(/data-big-bet="/g) ?? []).length).toBe(2);
    expect(text(pre)).toContain("2 bets, before tip");
    const all = detail({ phase: "all" });
    expect((all.match(/data-big-bet="/g) ?? []).length).toBe(3);
    expect(text(all)).toContain("3 bets, whole game");
    expect(text(all)).toContain("· live");
    expect(text(all)).toContain("$3.4k");
    // a missing price is a dash, not "null"
    expect(text(all)).toMatch(/\$2k[^]*-/);
  });

  it("when the money came in: bets, dollars and the left side's shares by how far ahead of the tip", () => {
    const out = detail();
    expect(out).toContain('data-when="6h-1h"');
    expect(out).toContain('data-when="lastHour"');
    expect(out).not.toContain('data-when="inGame"');
    expect(out).not.toContain('data-when="over24h"');
    expect(text(out)).toContain("MIN +4.5 share of bets");
    expect(text(out)).toContain("MIN +4.5 share of money");
  });

  it("the size mix is a table with a row per bucket, in size order", () => {
    const out = detail();
    expect(out).toContain('role="table"');
    const order = ["<$10", "$10-100", "$100-1k", "$1k-10k", "$10k+"].map((b) => out.indexOf(`data-size-bucket="${b.replace("<", "&lt;")}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("shares a 'no Kalshi bets' line with DraftKings only: its figures, no dollar tables, no gap zone", () => {
    const empty = detailOf({ sides: [], timeline: [], sizes: [], sizes_pregame: [], big_bets: [], rungs: [] });
    const series: NbaFlowBookSeries = {
      game: GAME.game, line: "ml", book: "draftkings",
      series: [
        { t: "2026-10-21T16:00:00Z", sides: [{ side: "MIA", handle_pct: 90, bets_pct: 59 }, { side: "MIN", handle_pct: 10, bets_pct: 41 }] },
        { t: "2026-10-21T17:00:00Z", sides: [{ side: "MIA", handle_pct: 91, bets_pct: 60 }, { side: "MIN", handle_pct: 9, bets_pct: 40 }] },
      ],
    };
    const out = detail({
      game: EMPTY_GAME,
      selection: { game: GAME.game, line: "ml", rung: null },
      detail: { ...empty, line: "ml", rung: null },
      bookSeries: series,
    });
    const t = text(out);
    expect(t).toContain("No Kalshi bets on this line");
    expect(t).not.toContain("so there is no dollar figure"); // no narration: one short line
    expect(out).not.toContain('data-seg="totals"'); // no totals view without Kalshi dollars
    expect(t).toContain("40% of bets · DraftKings");
    expect(t).toContain("91% of money · DraftKings");
    expect(t).not.toContain("When the money came in");
    expect(t).not.toContain("Who bet what size");
    expect(t).not.toContain("Gap ");
    expect(t).toContain("DK money on MIN"); // the legend is the DraftKings one
    expect(t).not.toContain("Gap without $1k+ bets");
    expect(out).not.toContain('data-rail="big-bets"');
    expect(out).toContain('data-series="dk-money"');
  });

  it("only the main rung says who won: another rung hides the result", () => {
    const main = detail();
    expect(text(main)).toContain("Result: MIN +4.5");
    expect(text(main)).toMatch(/MIN \+4\.5 Won/);
    const other = detail({ detail: detailOf({ rung: "MIA6", rung_label: "MIA -5.5" }), selection: { game: GAME.game, line: "spread", rung: "MIA6" } });
    expect(text(other)).not.toContain("Result:");
    expect(text(other)).not.toMatch(/won/);
    // while another rung loads, nothing is said either
    const loading = detail({ detail: null, previous: detailOf(), selection: { game: GAME.game, line: "spread", rung: "MIA6" } });
    expect(text(loading)).not.toMatch(/\bwon\b/);
  });

  it("the $1k+ table says how many of the backend's 100 largest it shows when the cap is hit", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => ({
      ts: new Date(T0 + i * 60_000).toISOString(), side: "MIA -4.5", dollars: 1000 + i, contracts: 2000, price: 57, phase: "pregame" as const,
    }));
    const out = text(detail({ detail: detailOf({ big_bets: hundred }) }));
    expect(out).toContain("100 of the 100 largest, before tip");
    expect(text(detail())).toContain("2 bets, before tip"); // not capped: plain count
  });

  it("an unknown tip says so once, in the head, the board and the when-table", () => {
    const noTip = { ...GAME, tip_utc: null };
    const out = text(detail({ game: noTip, detail: detailOf({ tip_utc: null }) }));
    expect(out).toContain("tip time unknown");
    expect(out).not.toContain("tip unknown");
    expect(out.match(/tip time unknown/gi)!.length).toBe(2); // the head and the when-table
    const board = text(html(createElement(FlowBoard, boardProps({ games: [noTip] }))));
    expect(board).toContain("tip time unknown");
    expect(board).not.toContain("tip tip");
  });

  it("the legend lists only what is drawn: no price item without prices, no DraftKings item without snapshots", () => {
    const noPrice = detailOf({ timeline: timeline(["MIN +4.5", "MIA -4.5"]).map((r) => ({ ...r, price: null })) });
    const t = text(detail({ detail: noPrice }));
    expect(t).not.toContain("price (");
    expect(t).not.toContain("DK money on");
    expect(text(detail())).toContain("MIN +4.5 price (on)");
  });

  it("an empty range is one quiet line, not an empty chart", () => {
    // the last bet was long before the six-hour window
    const stale = detailOf({ timeline: timeline(["MIN +4.5", "MIA -4.5"]).slice(0, 10) }); // ends ~21:15Z; tip 23:30Z
    const out = detail({ detail: { ...stale, tip_utc: "2026-10-22T20:00:00Z" }, range: "6h", game: { ...GAME, tip_utc: "2026-10-22T20:00:00Z" } });
    expect(text(out)).toContain("No bets in this range");
    expect(out).not.toContain("<svg");
  });

  it("totals mode draws cumulative dollars per side and no gap strip", () => {
    const out = detail({ mode: "totals" });
    expect(out).toContain('data-chart="totals"');
    expect(text(out)).toContain("Bets, dashed (right scale)");
    expect(text(out)).not.toContain("Gap: money share minus bet share");
    expect(text(detail())).toContain("Gap: money share minus bet share");
  });

  it("shows the rung the answer is for, even when it is not the one asked for", () => {
    // the backend substituted its main rung (MIA5) for the one chosen (MIA6)
    const out = detail({ selection: { game: GAME.game, line: "spread", rung: "MIA6" } });
    expect(out).toContain('<option value="MIA5" selected="">');
    expect(out).not.toContain('<option value="MIA6" selected="">');
    expect(out).not.toContain(">MIA5<"); // the label is shown, never the code
    expect(text(out)).toContain("MIA -4.5 · 7 bets");
    expect(text(out)).toContain("MIA -5.5 · 1 bet ·");
  });

  it("while a chosen rung loads, the select shows the chosen rung and stays mounted", () => {
    const out = detail({ selection: { game: GAME.game, line: "spread", rung: "MIA6" }, detail: null, previous: detailOf() });
    expect(out).toContain('<option value="MIA6" selected="">');
    expect(out).toContain('aria-busy="true"');
  });

  it("after a line change nothing from the old line is selectable until the new answer lands", () => {
    const out = detail({ selection: { game: GAME.game, line: "total", rung: null }, detail: null, previous: null });
    expect(text(out)).toContain("Spread");
    expect(out).not.toContain("<select");
    expect(text(out)).toContain("Loading game flow");
  });

  it("orders the sides away-first from the game code when the slate row is not there", () => {
    const out = detail({ game: undefined });
    expect(out).toMatch(/data-versus="a"[^]*MIN \+4\.5[^]*data-versus="b"[^]*MIA -4\.5/);
  });

  it("anchors the page as detail:<game>:<line>, not as the game row", () => {
    const out = detail();
    expect(out).toContain('data-anchor="detail:26OCT21MINMIA:spread"');
    expect(out).not.toContain('data-anchor="game:');
  });

  it("line tabs: a line with neither Kalshi bets nor a DraftKings split is disabled; DraftKings alone opens", () => {
    const out = detail();
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*data-line-tab="total"/);
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*data-line-tab="spread"/);
    const withTotal = detail({ book: { ...BOOK, lines: { ...BOOK.lines, total: { line_label: "240.5", sides: [{ side: "Over 240.5", handle_pct: 40, bets_pct: 50 }, { side: "Under 240.5", handle_pct: 60, bets_pct: 50 }] } } } });
    expect(withTotal).not.toMatch(/<button[^>]*disabled=""[^>]*data-line-tab="total"/);
  });

  it("the tabs, the back button and the toggles report what was chosen", () => {
    const onLine = vi.fn();
    const onClose = vi.fn();
    const onMode = vi.fn();
    const onRange = vi.fn();
    // not expanded: the chart has hooks; the switches are Seg elements carrying their handler
    const tree = FlowGameDetail(detailProps({ onLine, onClose, onMode, onRange }));
    (findAll(tree, (p) => p["data-line-tab"] === "ml")[0].props.onClick as () => void)();
    expect(onLine).toHaveBeenCalledWith("ml");
    (findAll(tree, (p) => p.label === "chart mode")[0].props.onChange as (k: string) => void)("totals");
    expect(onMode).toHaveBeenCalledWith("totals");
    (findAll(tree, (p) => p.label === "chart range")[0].props.onChange as (k: string) => void)("6h");
    expect(onRange).toHaveBeenCalledWith("6h");
    const back = findAll(tree, (p) => typeof p.onClick === "function" && p.children === "← All games")[0];
    (back.props.onClick as () => void)();
    expect(onClose).toHaveBeenCalled();
  });

  it("an endpoint failure says so instead of spinning, and DraftKings figures still show", () => {
    const out = detail({ detail: null, error: "Error: GET /nba/flow/game -> 503 Service Unavailable · historical DB unavailable" });
    expect(text(out)).toContain("endpoint returned 503 Service Unavailable");
    expect(text(out)).toContain("DraftKings 45% bets");
  });
});

describe("the chart on its own", () => {
  it("is one svg with a label that says where it ends, and anchors only on plotted points", () => {
    const d = detailOf();
    const out = detail({ detail: d, range: "pre" });
    expect(out).toMatch(/<svg[^>]*role="img"[^>]*aria-label="Money vs bets over time\. At the end, MIN \+4\.5 has \d+% of the money and \d+% of the bets\./);
  });

  const pt = (t: number, gap: number): SharePoint => ({ t, ha: 1, hb: 1, na: 20, nb: 20, mA: 50 + gap, bA: 50, gap, exGap: gap, px: 50 });

  it("the pin columns come first and the drawing lets clicks through, so rail and DraftKings dots keep their tooltips", () => {
    const series: NbaFlowBookSeries = {
      game: GAME.game, line: "spread", book: "draftkings",
      series: [
        { t: "2026-10-21T20:00:00Z", sides: [{ side: "MIN +2.5", handle_pct: 34, bets_pct: 47 }, { side: "MIA -2.5", handle_pct: 66, bets_pct: 53 }] },
        { t: "2026-10-21T22:00:00Z", sides: [{ side: "MIN +2.5", handle_pct: 30, bets_pct: 45 }, { side: "MIA -2.5", handle_pct: 70, bets_pct: 55 }] },
      ],
    };
    const out = detail({ bookSeries: series });
    const firstPin = out.indexOf('data-anchor="pt:');
    expect(firstPin).toBeGreaterThan(0);
    expect(firstPin).toBeLessThan(out.indexOf('data-rail="big-bets"'));
    expect(firstPin).toBeLessThan(out.indexOf('data-series="dk-money"'));
    expect(out).toContain('pointer-events="none"');
    expect(out).toMatch(/<circle[^>]*pointer-events="auto"/);
  });

  it("the gap bars carry forward across empty buckets: unbroken, each bar runs to the next one", () => {
    const t0 = Date.parse("2026-10-21T10:00:00Z");
    const pts = [pt(t0 + 15 * 60_000, 30), pt(t0 + 120 * 60_000, -20)]; // nothing between 10:15 and 12:00
    const svg = html(
      createElement(FlowChartSvg, {
        mode: "share", points: pts, window: { t0, t1: t0 + 120 * 60_000 }, a: "A", b: "B", bigBets: [], dk: [], showPrice: false,
        bands: BANDS.all, tipMs: t0 + 120 * 60_000, bucketMin: 15, width: 900,
      }),
    );
    const bars = [...svg.matchAll(/<rect x="([\d.]+)"[^>]*width="([\d.]+)"[^>]*shape-rendering="crispEdges"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(bars).toHaveLength(2);
    expect(bars[0][0] + bars[0][1]).toBeCloseTo(bars[1][0], 0); // no hole between them
    expect(bars[0][1]).toBeGreaterThan(bars[1][1] * 4); // the first value holds for most of the window
  });

  it("the end values sit in the right gutter, clear of each other", () => {
    const t0 = Date.parse("2026-10-21T10:00:00Z");
    const svg = html(
      createElement(FlowChartSvg, {
        mode: "share", points: [pt(t0 + 15 * 60_000, 1), pt(t0 + 30 * 60_000, 1)], window: { t0, t1: t0 + 60 * 60_000 }, a: "A", b: "B",
        bigBets: [], dk: [], showPrice: false, bands: null, tipMs: t0 + 60 * 60_000, bucketMin: 15, width: 900,
      }),
    );
    const ys = ["Money 51%", "Bets 50%"].map((label) => {
      const m = new RegExp(`<text x="([\\d.]+)" y="([\\d.]+)"[^>]*>${label}</text>`).exec(svg);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBeGreaterThan(900 - 86); // right of the plot
      return Number(m![2]);
    });
    expect(Math.abs(ys[0] - ys[1])).toBeGreaterThanOrEqual(14);
  });

  it("with nothing to draw it says so in the svg label", () => {
    const svg = html(
      createElement(FlowChartSvg, {
        mode: "share", points: [], window: { t0: 0, t1: 3_600_000 }, a: "A", b: "B", bigBets: [], dk: [], showPrice: true,
        bands: null, tipMs: NaN, bucketMin: 15, width: 800,
      }),
    );
    expect(svg).toContain("Nothing to draw yet");
    expect(svg).not.toContain("data-anchor=");
  });
});

describe("reading the board (SWIT-135)", () => {
  const board = (source: FlowSource) => html(createElement(FlowBoard, boardProps({ books: BOOKS, source })));

  it("one legend line under the column heads says what the bar and the white tick are, per source", () => {
    expect(boardLegend("kalshi")).toBe("Bar: share of Kalshi bets (faded) and money (solid), left side from the left \u00b7 white tick: DraftKings' share");
    expect(boardLegend("dk")).toBe("Bar: DraftKings' shares \u00b7 white tick: Kalshi's share");
    // the average draws no tick (a tick is only ever the OTHER source), so the line does not promise one
    expect(boardLegend("both")).toBe("Bar: average of Kalshi and DraftKings");
    for (const src of ["kalshi", "dk", "both"] as const) {
      const out = board(src);
      expect(out.match(/data-board-legend/g)).toHaveLength(1);
      expect(text(out)).toContain(boardLegend(src).replace(/'/g, "&#x27;"));
    }
  });

  it("each bar carries a tooltip with both sources' numbers", () => {
    const k = board("kalshi");
    expect(k).toContain('title="Kalshi 73% / 27% \u00b7 DraftKings 40% / 60%"'); // MIN's bets
    expect(k).toContain('title="Kalshi 22% / 78% \u00b7 DraftKings 9% / 91%"'); // MIN's money
    const d = board("dk");
    expect(d).toContain('title="DraftKings 40% / 60% \u00b7 Kalshi 73% / 27%"');
    // the average has no tick: one source named, no second half
    expect(board("both")).toContain('title="Average of Kalshi and DraftKings 57% / 43%"');
    // a lone source says only itself
    expect(html(createElement(FlowBoard, boardProps({ books: null })))).toContain('title="Kalshi 73% / 27%"');
    expect(html(createElement(SplitBar, { a: 61, tick: 58, title: "Kalshi 61% / 39% \u00b7 DraftKings 58% / 42%" }))).toContain(
      'title="Kalshi 61% / 39% \u00b7 DraftKings 58% / 42%"',
    );
  });

  it("the two sides are divided by a 3px gap, not a stray 2px line", () => {
    const out = html(createElement(SplitBar, { a: 40 }));
    expect(out).toContain("gap:3px");
    expect(out).not.toContain("gap:2px");
  });

  it("labels are sentence case: sort options, column heads, bar rows, status words", () => {
    const out = board("kalshi");
    const t = text(out);
    expect(t).toContain("Sort Tip Handle Gap");
    expect(t).toContain("Moneyline Spread Total");
    expect(t).toContain("Bets 73%");
    expect(t).toContain("Money 22%");
    expect(out).not.toContain("text-transform:uppercase");
    expect(out).toContain('data-seg="tip"');
    const live = text(html(createElement(FlowBoard, boardProps({ games: [{ ...GAME, status: "live" }] }))));
    expect(live).toContain("Live · tip 7:30 PM");
    const sched = text(html(createElement(FlowBoard, boardProps({ games: [{ ...GAME, status: "scheduled" }] }))));
    expect(sched).toContain("Tip 7:30 PM");
  });

  it("the three markets sit in columns: a faint rule left of the second and third, and roomier rows", () => {
    const out = board("kalshi");
    // two column heads and two cells carry the rule (the first market has none)
    expect(out.match(/border-left:1px solid var\(--border\)/g)).toHaveLength(4);
    expect(out).toContain("padding-left:14px");
    expect(out).toContain("padding:18px 12px");
    expect(out).toContain("column-gap:36px");
    // the click target and the pin anchors are unchanged
    expect(out).toContain('data-anchor="game:26OCT21MINMIA"');
    expect(out).toContain('data-anchor="line:26OCT21MINMIA:spread"');
  });

  it("the biggest-splits strip is roomier: 32px between entries, 20px above and 30px below", () => {
    const out = html(createElement(FlowSplits, { entries: biggestSplits([GAME], BOOKS, "kalshi"), source: "kalshi", phase: "all", onOpen: () => {} }));
    expect(out).toContain("gap:32px");
    expect(out).toContain("margin:20px 0 30px");
    expect(text(out)).toContain("Money share minus bet share");
  });
});

describe("the chart cursor (SWIT-135)", () => {
  const t0 = Date.parse("2026-10-21T10:00:00Z");
  const MIN15 = 15 * 60_000;
  const pt = (k: number, gap: number): SharePoint => ({ t: t0 + k * MIN15, ha: 1_200, hb: 800, na: 20, nb: 20, mA: 50 + gap, bA: 50, gap, exGap: gap, px: 72 });
  const pts = [pt(1, 4), pt(2, 7), pt(3, -3), pt(4, 12)];
  const base = {
    mode: "share" as const, points: pts, window: { t0, t1: t0 + 4 * MIN15 }, a: "MIN +4.5", b: "MIA -4.5", bigBets: [],
    dk: [{ t: t0 + 2 * MIN15 - 60_000, money: 58, bets: 47 }], showPrice: true, bands: BANDS.all, tipMs: t0 + 4 * MIN15, bucketMin: 15, width: 900,
  };
  const svg = (o: Record<string, unknown> = {}) => html(createElement(FlowChartSvg, { ...base, ...o } as never));

  it("lists, in the legend's order, the time, money, bets, gap, price and DraftKings", () => {
    const r = readoutFor({ mode: "share", q: pts[1], a: "MIN +4.5", b: "MIA -4.5", showPrice: true, dk: base.dk[0], day: false });
    expect(r.title).toBe("6:30 AM");
    expect(r.rows.map((x) => [x.label, x.value])).toEqual([
      ["Money MIN +4.5", "57%"],
      ["Bets MIN +4.5", "50%"],
      ["Gap", "+7"],
      ["Price", "72\u00a2"],
      ["DraftKings money", "58%"],
    ]);
    // no price when the price line is off, no DraftKings when no snapshot sits in the bucket
    const bare = readoutFor({ mode: "share", q: pts[2], a: "MIN +4.5", b: "MIA -4.5", showPrice: false, dk: null, day: true });
    expect(bare.title).toBe("Wed 6:45 AM");
    expect(bare.rows.map((x) => x.label)).toEqual(["Money MIN +4.5", "Bets MIN +4.5", "Gap"]);
    expect(bare.rows[2].value).toBe("-3");
  });

  it("totals mode lists each side's cumulative dollars and bets", () => {
    const r = readoutFor({ mode: "totals", q: pts[0], a: "MIN +4.5", b: "MIA -4.5", showPrice: true, dk: null, day: false });
    expect(r.rows.map((x) => [x.label, x.value])).toEqual([
      ["MIN +4.5 money", "$1.2k"],
      ["MIN +4.5 bets", "20"],
      ["MIA -4.5 money", "$800"],
      ["MIA -4.5 bets", "20"],
    ]);
  });

  it("draws nothing until the cursor is placed, then a hairline, a dot per series and the readout", () => {
    expect(svg()).not.toContain("data-crosshair");
    expect(svg({ cursorT: 12345 })).not.toContain("data-crosshair"); // not a plotted point: nothing
    const on = svg({ cursorT: pts[1].t });
    expect(on).toContain(`data-crosshair="${pts[1].t}"`);
    expect(on).toContain("data-readout");
    const t = text(on);
    for (const w of ["6:30 AM", "Money MIN +4.5 57%", "Bets MIN +4.5 50%", "Gap +7", "Price 72", "DraftKings money 58%"]) expect(t).toContain(w);
    // the layer lets clicks through and sits after (above) the pin columns
    const g = on.slice(on.indexOf("data-crosshair"));
    expect(g).toContain('pointer-events="none"');
    expect(on.indexOf('data-anchor="pt:')).toBeLessThan(on.indexOf("data-crosshair"));
    // 1px hairline in dim ink
    expect(on).toMatch(/<line[^>]*stroke="var\(--text-dim\)"[^>]*stroke-width="1"/);
  });

  it("totals mode puts a dot on all four series and no gap row", () => {
    const on = svg({ mode: "totals", cursorT: pts[0].t });
    expect((on.slice(on.indexOf("data-crosshair")).match(/<circle[^>]*r="(3|3\.5)"/g) ?? [])).toHaveLength(4);
    expect(text(on)).toContain("MIN +4.5 money $1.2k");
    expect(text(on)).not.toContain("Gap +");
  });

  it("flips to the left of the cursor near the right edge", () => {
    const panelX = (o: Record<string, unknown>) => {
      const out = svg(o);
      const cx = Number(/<g data-crosshair[^>]*><line x1="([\d.]+)"/.exec(out)![1]);
      const px = Number(/<rect x="([\d.]+)"[^>]*rx="4"/.exec(out)![1]);
      return { cx, px };
    };
    const early = panelX({ cursorT: pts[0].t });
    expect(early.px).toBeGreaterThan(early.cx);
    const late = panelX({ cursorT: pts[3].t });
    expect(late.px).toBeLessThan(late.cx);
  });

  it("the chart is focusable with a label that says the readout is there; without a handler it is a plain image", () => {
    const live = svg({ onCursor: () => {} });
    expect(live).toContain('tabindex="0"');
    expect(live).toMatch(/aria-label="[^"]*arrow keys[^"]*readout/);
    const plain = svg();
    expect(plain).not.toContain("tabindex");
    expect(plain).not.toContain("arrow keys");
    // nothing to draw: no readout promised
    expect(svg({ points: [], dk: [], onCursor: () => {} })).not.toContain("arrow keys");
  });

  it("the arrow keys step the cursor one point and Escape hides it", () => {
    const calls: (number | null)[] = [];
    const tree = FlowChartSvg({ ...base, cursorT: pts[1].t, onCursor: (t: number | null) => calls.push(t) } as never);
    const onKeyDown = (tree as ReactElement<Record<string, unknown>>).props.onKeyDown as (e: { key: string; preventDefault(): void }) => void;
    const key = (k: string) => onKeyDown({ key: k, preventDefault: () => {} });
    key("ArrowRight");
    key("ArrowLeft");
    key("Escape");
    key("a");
    expect(calls).toEqual([pts[2].t, pts[0].t, null]);
    // from nothing: Left lands on the last point, Right on the first; the ends hold
    const none: (number | null)[] = [];
    const fresh = FlowChartSvg({ ...base, cursorT: null, onCursor: (t: number | null) => none.push(t) } as never);
    const k2 = (fresh as ReactElement<Record<string, unknown>>).props.onKeyDown as (e: { key: string; preventDefault(): void }) => void;
    k2({ key: "ArrowLeft", preventDefault: () => {} });
    k2({ key: "ArrowRight", preventDefault: () => {} });
    expect(none).toEqual([pts[3].t, pts[0].t]);
    const end: (number | null)[] = [];
    const last = FlowChartSvg({ ...base, cursorT: pts[3].t, onCursor: (t: number | null) => end.push(t) } as never);
    ((last as ReactElement<Record<string, unknown>>).props.onKeyDown as (e: { key: string; preventDefault(): void }) => void)({ key: "ArrowRight", preventDefault: () => {} });
    expect(end).toEqual([pts[3].t]);
  });

  it("a pointer over the plot snaps to the nearest point; the gutter and leaving hide it; a touch lift keeps it", () => {
    const calls: (number | null)[] = [];
    const tree = FlowChartSvg({ ...base, onCursor: (t: number | null) => calls.push(t) } as never) as ReactElement<Record<string, unknown>>;
    const move = tree.props.onPointerMove as (e: unknown) => void;
    // plot runs 52..814 over four 15-minute steps; point k sits at 52 + k/4 * 762 (the window opens at t0)
    const at = (clientX: number) => ({ clientX, currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 900 }) } });
    move(at(52 + 0.5 * 762 + 10)); // just right of point 2
    move(at(52 + 0.25 * 762 - 20)); // just left of point 1
    move(at(10)); // the left gutter: hidden
    move(at(880)); // the right gutter: hidden
    expect(calls).toEqual([pts[1].t, pts[0].t, null, null]);
    // the same pointer on a page scaled to half width reads the same point
    const scaled = (clientX: number) => ({ clientX, currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 450 }) } });
    calls.length = 0;
    move(scaled((52 + 0.5 * 762 + 10) / 2));
    expect(calls).toEqual([pts[1].t]);
    const leave = tree.props.onPointerLeave as (e: { pointerType: string }) => void;
    calls.length = 0;
    leave({ pointerType: "mouse" });
    leave({ pointerType: "touch" });
    expect(calls).toEqual([null]);
    (tree.props.onPointerDown as (e: unknown) => void)(at(52 + 0.75 * 762 + 5));
    expect(calls).toEqual([null, pts[2].t]);
  });
});

describe("the page", () => {
  it("draws the top bar: title, sport with NFL and Props disabled, date, phase, source, and the three tabs", () => {
    const out = html(createElement(KalshiTrading));
    const t = text(out);
    expect(t).toContain("Kalshi Trading");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*data-seg="nfl"/);
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*data-seg="props"/);
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*data-seg="nba"/);
    expect(t).toContain("Before tip");
    expect(t).toContain("Whole game");
    for (const s of ["Kalshi", "DraftKings", "Both"]) expect(t).toContain(s);
    expect(t).toContain("Flow");
    expect(t).toContain("Positions");
    expect(t).toContain("Portfolio");
    // Flow, Positions and Portfolio, in that order, Flow selected
    expect(out.match(/role="tab"/g)).toHaveLength(3);
    expect(out).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Flow<[^]*>Positions<[^]*>Portfolio</);
    // no narration under the bar: the source's meaning is the switch's hover text
    expect(t).not.toContain("white ticks mark");
    expect(out).toContain("white ticks mark DraftKings");
    expect(out).toContain('aria-label="previous day"');
    expect(out).toContain('aria-label="next day"');
    // Kalshi is the default source, Before tip the default phase
    expect(out).toMatch(/aria-pressed="true"[^>]*data-seg="kalshi"/);
    expect(out).toMatch(/aria-pressed="true"[^>]*data-seg="pregame"/);
    // the Flow tab loads before it draws
    expect(t).toContain("Loading NBA flow");
  });
});
