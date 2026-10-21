// Kalshi Trading / Flow - the derived numbers (SWIT-130).

import { describe, it, expect } from "vitest";
import type {
  NbaFlowBookGame,
  NbaFlowBookLine,
  NbaFlowGame,
  NbaFlowGapBands,
  NbaFlowLine,
  NbaFlowSide,
  NbaFlowSizeRow,
  NbaFlowTimelineRow,
} from "../api/client";
import {
  avgBet,
  avgBetSentence,
  bandsFor,
  bigBetsFor,
  biggestSplits,
  bookGame,
  bookLineNote,
  booksMatch,
  buildCell,
  cellAriaLabel,
  defaultLine,
  detailMatches,
  dkLine,
  fetchErrorText,
  fmtBets,
  fmtCount,
  fmtDateLabel,
  fmtEt,
  fmtGap,
  fmtMoney,
  fmtPct,
  gameCodeTeams,
  handicapSign,
  gapPercentile,
  gapRead,
  gapSentence,
  gapWithoutBig,
  gapZone,
  isHandleIncomplete,
  kalshiLine,
  leanChip,
  leanSentence,
  matchBookSide,
  orderSides,
  parseIso,
  rungText,
  selectionReducer,
  shiftDate,
  shortSide,
  sideStats,
  sideTeam,
  sizeMix,
  slateIsSettled,
  slateMatches,
  sortGames,
  stabilize,
  todayEt,
  whenBucketOf,
  whenTheMoneyCame,
} from "./kalshiFlow";

const side = (s: string, o: Partial<NbaFlowSide> = {}): NbaFlowSide => ({
  side: s, bets: 0, handle: 0, big_bets: 0, big_handle: 0, ticket_pct: 50, money_pct: 50, gap: 0,
  price_first: null, price_last: null, ...o,
});

const line = (o: Partial<NbaFlowLine> = {}): NbaFlowLine => ({
  rung: null, bets: 0, handle: 0, sides: [], lean: null, result: null, ...o,
});

const game = (o: Partial<NbaFlowGame> = {}): NbaFlowGame => ({
  game: "26OCT21MINMIA", away: "MIN", home: "MIA", tip_utc: "2026-10-21T23:30:00Z", status: "scheduled",
  away_score: null, home_score: null, price_zero_share: 0, lines: { ml: null, spread: null, total: null }, ...o,
});

/** Kalshi's moneyline for MIN @ MIA: the backend lists the home side first. */
const kalshiMl = (o: Partial<NbaFlowLine> = {}): NbaFlowLine =>
  line({
    bets: 412,
    handle: 18_240,
    sides: [
      side("MIA", { bets: 112, handle: 14_240, big_bets: 8, big_handle: 11_000, ticket_pct: 27, money_pct: 78, gap: 51, price_last: 59 }),
      side("MIN", { bets: 300, handle: 4_000, big_bets: 1, big_handle: 1_500, ticket_pct: 73, money_pct: 22, gap: -51, price_last: 41 }),
    ],
    lean: "MIA",
    result: "MIA",
    ...o,
  });

/** DraftKings' moneyline for the same game (percentages only). */
const dkMl = (o: Partial<NbaFlowBookLine> = {}): NbaFlowBookLine => ({
  line_label: null,
  sides: [
    { side: "MIA", handle_pct: 91, bets_pct: 60, odds: -150 },
    { side: "MIN", handle_pct: 9, bets_pct: 40, odds: 130 },
  ],
  ...o,
});

const bookGameOf = (lines: NbaFlowBookGame["lines"], g = "26OCT21MINMIA"): NbaFlowBookGame => ({
  game: g,
  captured_at: "2026-10-21T17:00:00Z",
  lines,
});

describe("formatting", () => {
  it("money reads in dollars, k and M", () => {
    expect(fmtMoney(0)).toBe("$0");
    expect(fmtMoney(849.6)).toBe("$850");
    expect(fmtMoney(1000)).toBe("$1k");
    expect(fmtMoney(18_240)).toBe("$18.2k");
    expect(fmtMoney(114_201)).toBe("$114k");
    expect(fmtMoney(1_250_000)).toBe("$1.3M");
    expect(fmtMoney(NaN)).toBe("-");
    // tiers follow the ROUNDED value: never "$1000" or "$1000k"
    expect(fmtMoney(999.4)).toBe("$999");
    expect(fmtMoney(999.6)).toBe("$1k");
    expect(fmtMoney(99_950)).toBe("$100k");
    expect(fmtMoney(999_400)).toBe("$999k");
    expect(fmtMoney(999_999)).toBe("$1M");
  });
  it("counts, percentages and signed gaps", () => {
    expect(fmtCount(1203)).toBe("1,203");
    expect(fmtPct(63.6)).toBe("64%");
    expect(fmtPct(NaN)).toBe("-");
    expect(fmtGap(23.4)).toBe("+23");
    expect(fmtGap(-23.4)).toBe("-23");
    expect(fmtGap(0.2)).toBe("0");
  });
  it("pluralises bets", () => {
    expect(fmtBets(1)).toBe("1 bet");
    expect(fmtBets(412)).toBe("412 bets");
  });
  it("shows a total's sides short, and leaves a team side alone", () => {
    expect(shortSide("Over 216.5")).toBe("O 216.5");
    expect(shortSide("Under 216.5")).toBe("U 216.5");
    expect(shortSide("MIA -4.5")).toBe("MIA -4.5");
  });
  it("times are Eastern, with the weekday when asked, and absence is said", () => {
    expect(fmtEt("2026-10-21T23:30:00Z")).toBe("7:30 PM");
    expect(fmtEt("2026-10-21T23:30:00Z", true)).toBe("Wed 7:30 PM");
    expect(fmtEt("2026-10-21T23:30:00Z", false, "UTC")).toBe("11:30 PM");
    expect(fmtEt(null)).toBe("-");
    expect(fmtEt("not a date")).toBe("-");
  });
  it("today is the Eastern calendar date, whatever zone the viewer is in", () => {
    // 02:30 UTC on the 22nd is still the 21st in New York
    expect(todayEt(new Date("2026-10-22T02:30:00Z"))).toBe("2026-10-21");
    expect(todayEt(new Date("2026-10-22T06:00:00Z"))).toBe("2026-10-22");
  });
  it("steps a date across month and year ends, and labels it", () => {
    expect(shiftDate("2026-10-21", 1)).toBe("2026-10-22");
    expect(shiftDate("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(fmtDateLabel("2026-10-21")).toBe("Wed, Oct 21, 2026");
    expect(fmtDateLabel("junk")).toBe("junk");
  });
  it("warns about an incomplete handle above 0.2 only", () => {
    expect(isHandleIncomplete(0.2)).toBe(false);
    expect(isHandleIncomplete(0.21)).toBe(true);
    expect(isHandleIncomplete(null)).toBe(false);
  });
  it("shows the readable rung when there is one and the code otherwise", () => {
    expect(rungText({ rung: "MIA5", rung_label: "MIA -4.5" })).toBe("MIA -4.5");
    expect(rungText({ rung: "MIA5" })).toBe("MIA5");
    expect(rungText({ rung: null })).toBe("");
  });
});

describe("matching Kalshi's sides to DraftKings'", () => {
  it("takes the team out of a side", () => {
    expect(sideTeam("ORL -2.5")).toBe("ORL");
    expect(sideTeam("atl")).toBe("ATL");
  });
  it("matches a moneyline or spread by TEAM, whatever line DraftKings quotes", () => {
    const dk = [{ side: "ORL -2.5" }, { side: "ATL +2.5" }];
    expect(matchBookSide("spread", "ATL +10.5", dk)).toBe(dk[1]);
    expect(matchBookSide("spread", "ORL -10.5", dk)).toBe(dk[0]);
    expect(matchBookSide("ml", "ORL", [{ side: "ATL" }, { side: "ORL" }])).toEqual({ side: "ORL" });
    expect(matchBookSide("ml", "XXX", [{ side: "ATL" }])).toBeNull();
  });
  it("matches a total by Over / Under, whatever number DraftKings quotes", () => {
    const dk = [{ side: "Over 234.5" }, { side: "Under 234.5" }];
    expect(matchBookSide("total", "Under 249.5", dk)).toBe(dk[1]);
    expect(matchBookSide("total", "Over 249.5", dk)).toBe(dk[0]);
    expect(matchBookSide("total", "ATL", dk)).toBeNull();
    expect(matchBookSide("total", "Over 1", null)).toBeNull();
  });
  it("a spread side is a team AND a direction: DraftKings other-way favourite is a different bet and matches nothing", () => {
    expect(handicapSign("CHA -1.5")).toBe(-1);
    expect(handicapSign("CHA +1.5")).toBe(1);
    expect(handicapSign("CHA")).toBe(0);
    const dk = [{ side: "CHA -1.5" }, { side: "BKN +1.5" }];
    expect(matchBookSide("spread", "CHA +1.5", dk)).toBeNull(); // Kalshi CHA is the underdog, DraftKings the favourite
    expect(matchBookSide("spread", "BKN -1.5", dk)).toBeNull();
    // same direction, different number: still compared
    expect(matchBookSide("spread", "BKN +9.5", dk)).toBe(dk[1]);
    expect(matchBookSide("spread", "CHA -9.5", dk)).toBe(dk[0]);
    // a moneyline has no direction
    expect(matchBookSide("ml", "CHA", [{ side: "CHA" }])).toEqual({ side: "CHA" });
  });
  it("puts the away team first for ml and spread, Over first for a total", () => {
    const g = { away: "MIN" };
    expect(orderSides(["MIA", "MIN"], "ml", g)).toEqual(["MIN", "MIA"]);
    expect(orderSides(["MIA -4.5", "MIN +4.5"], "spread", g)).toEqual(["MIN +4.5", "MIA -4.5"]);
    expect(orderSides(["Under 216.5", "Over 216.5"], "total", g)).toEqual(["Over 216.5", "Under 216.5"]);
    expect(orderSides(["B", "A"], "ml", undefined)).toEqual(["B", "A"]);
  });
  it("names DraftKings' own line only when it is not Kalshi's", () => {
    const g = { away: "MIN", home: "MIA" };
    const k = { rung: "MIA4", rung_label: "MIA -4.5" };
    expect(bookLineNote("spread", g, k, dkMl({ line_label: "MIA -2.5" }))).toBe("MIA -2.5");
    expect(bookLineNote("spread", g, k, dkMl({ line_label: "MIA -4.5" }))).toBeNull();
    // the same spread written from the other team is the same line
    expect(bookLineNote("spread", g, k, dkMl({ line_label: "MIN +4.5" }))).toBeNull();
    expect(bookLineNote("total", g, { rung: "243", rung_label: "243.5" }, dkMl({ line_label: "240.5" }))).toBe("240.5");
    expect(bookLineNote("total", g, { rung: "243", rung_label: "243.5" }, dkMl({ line_label: "243.5" }))).toBeNull();
    expect(bookLineNote("ml", g, { rung: null }, dkMl({ line_label: null }))).toBeNull();
    expect(bookLineNote("spread", g, null, dkMl({ line_label: "MIA -2.5" }))).toBeNull();
  });
});

describe("the market cell and the source switch", () => {
  const g = game();

  it("Kalshi: left side is the away team, the bars are Kalshi's, DraftKings rides as ticks and one quiet line", () => {
    const c = buildCell(g, "ml", kalshiMl(), dkMl(), "kalshi")!;
    expect(c.drawn).toBe("kalshi");
    expect([c.a.side, c.b.side]).toEqual(["MIN", "MIA"]);
    expect([c.a.betsPct, c.a.moneyPct, c.a.gap]).toEqual([73, 22, -51]);
    expect([c.b.betsPct, c.b.moneyPct, c.b.gap]).toEqual([27, 78, 51]);
    expect([c.a.price, c.b.price]).toEqual([41, 59]);
    expect(c.b.won).toBe(true);
    expect(c.a.won).toBe(false);
    expect(c.tickSource).toBe("dk");
    expect([c.a.tickBetsPct, c.a.tickMoneyPct]).toEqual([40, 9]);
    expect(dkLine(c)).toBe("DK 40% bets · 9% $");
    expect(kalshiLine(c)).toBeNull();
    expect(c.note).toBeNull();
    expect([c.bets, c.handle]).toEqual([412, 18_240]);
    expect(c.lean?.side).toBe("MIA");
    expect(c.maxGap).toBe(51);
    expect(c.result).toBe("MIA");
  });

  it("DraftKings: the bars are DraftKings', Kalshi rides as ticks, the counts stay Kalshi's", () => {
    const c = buildCell(g, "ml", kalshiMl(), dkMl(), "dk")!;
    expect(c.drawn).toBe("dk");
    expect([c.a.betsPct, c.a.moneyPct]).toEqual([40, 9]);
    expect([c.b.betsPct, c.b.moneyPct]).toEqual([60, 91]);
    expect(c.tickSource).toBe("kalshi");
    expect([c.a.tickBetsPct, c.a.tickMoneyPct]).toEqual([73, 22]);
    expect(kalshiLine(c)).toBe("Kalshi 73% bets · 22% $");
    expect(dkLine(c)).toBeNull();
    expect(c.handle).toBe(18_240);
    // the price is Kalshi's, still shown
    expect(c.a.price).toBe(41);
  });

  it("Both: the plain average of the two, no ticks, and it says so", () => {
    const c = buildCell(g, "ml", kalshiMl(), dkMl(), "both")!;
    expect(c.drawn).toBe("avg");
    expect(c.a.betsPct).toBeCloseTo((73 + 40) / 2);
    expect(c.a.moneyPct).toBeCloseTo((22 + 9) / 2);
    expect(c.b.betsPct).toBeCloseTo((27 + 60) / 2);
    expect(c.b.moneyPct).toBeCloseTo((78 + 91) / 2);
    expect(c.b.gap).toBeCloseTo((78 + 91) / 2 - (27 + 60) / 2);
    expect(c.tickSource).toBeNull();
    expect(c.a.tickBetsPct).toBeNull();
    expect(c.note).toBe("avg of Kalshi + DK");
    // DraftKings' own shares stay on the side for the detail
    expect(c.a.dkMoneyPct).toBe(9);
  });

  it("a market only Kalshi has draws Kalshi and says which when it matters", () => {
    expect(buildCell(g, "ml", kalshiMl(), undefined, "kalshi")!.note).toBeNull();
    expect(buildCell(g, "ml", kalshiMl(), undefined, "kalshi")!.tickSource).toBeNull();
    expect(buildCell(g, "ml", kalshiMl(), undefined, "both")).toMatchObject({ drawn: "kalshi", note: "Kalshi only" });
    expect(buildCell(g, "ml", kalshiMl(), undefined, "dk")).toMatchObject({ drawn: "kalshi", note: "Kalshi only" });
  });

  it("a market only DraftKings has draws DraftKings, with no dollar figure and no price", () => {
    for (const source of ["kalshi", "dk", "both"] as const) {
      const c = buildCell(g, "ml", null, dkMl(), source)!;
      expect(c.drawn).toBe("dk");
      // said when the switch asked for something else; DraftKings asked for and drawn needs no note
      expect(c.note).toBe(source === "dk" ? null : "DraftKings only");
      expect([c.a.side, c.b.side]).toEqual(["MIN", "MIA"]);
      expect([c.a.betsPct, c.a.moneyPct]).toEqual([40, 9]);
      expect(c.bets).toBeNull();
      expect(c.handle).toBeNull();
      expect(c.a.price).toBeNull();
      expect(c.result).toBeNull();
      expect(c.tickSource).toBeNull();
    }
  });

  it("DraftKings-only spreads and totals keep DraftKings' own sides, away / Over first", () => {
    const sp = buildCell(g, "spread", null, { line_label: "MIA -2.5", sides: [
      { side: "MIA -2.5", handle_pct: 81, bets_pct: 58 }, { side: "MIN +2.5", handle_pct: 19, bets_pct: 42 },
    ] }, "kalshi")!;
    expect([sp.a.side, sp.b.side]).toEqual(["MIN +2.5", "MIA -2.5"]);
    const tot = buildCell(g, "total", null, { line_label: "240.5", sides: [
      { side: "Under 240.5", handle_pct: 70, bets_pct: 55 }, { side: "Over 240.5", handle_pct: 30, bets_pct: 45 },
    ] }, "kalshi")!;
    expect([tot.a.short, tot.b.short]).toEqual(["O 240.5", "U 240.5"]);
  });

  describe("a spread DraftKings has the other way round", () => {
    // Kalshi: MIN +1.5 / MIA -1.5 (MIA the favourite). DraftKings: MIN -1.5 / MIA +1.5 (MIN the favourite).
    const kSp = line({
      rung: "MIA1", rung_label: "MIA -1.5", bets: 100, handle: 20_000,
      sides: [
        side("MIA -1.5", { ticket_pct: 40, money_pct: 80, price_last: 50 }),
        side("MIN +1.5", { ticket_pct: 60, money_pct: 20, price_last: 50 }),
      ],
    });
    const dkOther: NbaFlowBookLine = {
      line_label: "MIN -1.5",
      sides: [
        { side: "MIN -1.5", handle_pct: 10, bets_pct: 54 },
        { side: "MIA +1.5", handle_pct: 90, bets_pct: 46 },
      ],
    };
    it("uses none of DraftKings numbers - no ticks, no average - and says why in one quiet line", () => {
      for (const source of ["kalshi", "dk", "both"] as const) {
        const c = buildCell(g, "spread", kSp, dkOther, source)!;
        expect(c.drawn).toBe("kalshi");
        expect([c.a.side, c.b.side]).toEqual(["MIN +1.5", "MIA -1.5"]);
        expect([c.a.betsPct, c.a.moneyPct]).toEqual([60, 20]);
        expect(c.tickSource).toBeNull();
        expect([c.a.tickBetsPct, c.a.dkBetsPct, c.a.dkMoneyPct]).toEqual([null, null, null]);
        expect(c.note).toBe("DK favours the other side: MIN -1.5");
        expect(c.dkMismatch).toBe("DK favours the other side: MIN -1.5");
        expect(c.dkLine).toBeNull(); // not also "DK line ..."
        expect(dkLine(c)).toBeNull();
      }
    });
    it("DraftKings alone still draws its own sides (nothing to mismatch with)", () => {
      const c = buildCell(g, "spread", null, dkOther, "both")!;
      expect(c.drawn).toBe("dk");
      expect(c.dkMismatch).toBeNull();
      expect([c.a.side, c.b.side]).toEqual(["MIN -1.5", "MIA +1.5"]);
    });
  });

  describe("a spread DraftKings has with the same favourite but a different number", () => {
    const kSp = line({
      rung: "MIA4", rung_label: "MIA -4.5", bets: 100, handle: 20_000,
      sides: [
        side("MIA -4.5", { ticket_pct: 40, money_pct: 80 }),
        side("MIN +4.5", { ticket_pct: 60, money_pct: 20 }),
      ],
    });
    const dkSame: NbaFlowBookLine = {
      line_label: "MIA -2.5",
      sides: [
        { side: "MIA -2.5", handle_pct: 70, bets_pct: 50 },
        { side: "MIN +2.5", handle_pct: 30, bets_pct: 50 },
      ],
    };
    it("compares as before - ticks, average - and keeps the DK line note", () => {
      const k = buildCell(g, "spread", kSp, dkSame, "kalshi")!;
      expect(k.dkMismatch).toBeNull();
      expect([k.a.tickBetsPct, k.a.tickMoneyPct]).toEqual([50, 30]);
      expect(k.dkLine).toBe("MIA -2.5");
      const both = buildCell(g, "spread", kSp, dkSame, "both")!;
      expect(both.drawn).toBe("avg");
      expect(both.a.moneyPct).toBeCloseTo((20 + 30) / 2);
      expect(both.dkLine).toBe("MIA -2.5");
    });
  });

  it("a total compares Over with Over at any number, with the line noted", () => {
    const k = line({ rung: "243", rung_label: "243.5", bets: 50, handle: 9000, sides: [
      side("Over 243.5", { ticket_pct: 60, money_pct: 30 }), side("Under 243.5", { ticket_pct: 40, money_pct: 70 }),
    ] });
    const dk: NbaFlowBookLine = { line_label: "230.5", sides: [
      { side: "Under 230.5", handle_pct: 55, bets_pct: 45 }, { side: "Over 230.5", handle_pct: 45, bets_pct: 55 },
    ] };
    const c = buildCell(g, "total", k, dk, "both")!;
    expect(c.drawn).toBe("avg");
    expect(c.dkMismatch).toBeNull();
    expect(c.a.moneyPct).toBeCloseTo((30 + 45) / 2);
    expect(c.dkLine).toBe("230.5");
  });

  it("neither source has the market: nothing to draw", () => {
    expect(buildCell(g, "ml", null, undefined, "both")).toBeNull();
    expect(buildCell(g, "ml", line({ sides: [side("MIN")] }), null, "kalshi")).toBeNull();
  });

  it("a DraftKings split with a missing percentage is treated as no DraftKings split", () => {
    const bad = dkMl({ sides: [{ side: "MIA", handle_pct: null, bets_pct: 60 }, { side: "MIN", handle_pct: 9, bets_pct: 40 }] });
    const c = buildCell(g, "ml", kalshiMl(), bad, "dk")!;
    expect(c.drawn).toBe("kalshi");
    expect(c.note).toBe("Kalshi only");
    expect(c.a.dkMoneyPct).toBeNull();
  });

  it("totals match DraftKings by Over / Under and carry its own line when it differs", () => {
    const k = line({
      rung: "243", rung_label: "243.5", bets: 50, handle: 9000,
      sides: [
        side("Under 243.5", { ticket_pct: 40, money_pct: 70 }),
        side("Over 243.5", { ticket_pct: 60, money_pct: 30 }),
      ],
    });
    const dk: NbaFlowBookLine = { line_label: "240.5", sides: [
      { side: "Over 240.5", handle_pct: 25, bets_pct: 55 }, { side: "Under 240.5", handle_pct: 75, bets_pct: 45 },
    ] };
    const c = buildCell(g, "total", k, dk, "kalshi")!;
    expect([c.a.short, c.b.short]).toEqual(["O 243.5", "U 243.5"]);
    expect([c.a.tickBetsPct, c.a.tickMoneyPct]).toEqual([55, 25]);
    expect(c.dkLine).toBe("240.5");
    expect(c.rung).toBe("243.5");
  });

  it("the lean chip is quiet until the gap reaches 30", () => {
    const quiet = buildCell(g, "ml", kalshiMl({ sides: [
      side("MIA", { ticket_pct: 40, money_pct: 55 }), side("MIN", { ticket_pct: 60, money_pct: 45 }),
    ] }), undefined, "kalshi")!;
    expect(leanChip(quiet)).toEqual({ text: "$ → MIA", loud: false });
    const loud = buildCell(g, "ml", kalshiMl(), undefined, "kalshi")!;
    expect(leanChip(loud)).toEqual({ text: "$ → MIA +51", loud: true });
    const none = buildCell(g, "ml", kalshiMl({ sides: [
      side("MIA", { ticket_pct: 49, money_pct: 52 }), side("MIN", { ticket_pct: 51, money_pct: 48 }),
    ] }), undefined, "kalshi")!;
    expect(none.lean).toBeNull();
    expect(leanChip(none)).toBeNull();
  });

  it("gives a screen reader every number with its meaning", () => {
    const t = cellAriaLabel(buildCell(g, "ml", kalshiMl(), dkMl(), "kalshi")!);
    expect(t).toContain("Moneyline");
    expect(t).toContain("MIN: 73% of bets, 22% of money");
    expect(t).toContain("MIA: 27% of bets, 78% of money");
    expect(t).toContain("412 bets, $18.2k handle");
    expect(t).toContain("money leans MIA");
    expect(t).toContain("won MIA");
    expect(t).toContain("Opens the game detail.");
  });
});

describe("biggest splits", () => {
  const g1 = game({ game: "26OCT21AAABBB", away: "AAA", home: "BBB", lines: {
    ml: line({ bets: 100, handle: 20_000, sides: [side("AAA", { ticket_pct: 70, money_pct: 40 }), side("BBB", { ticket_pct: 30, money_pct: 60 })] }),
    spread: null, total: null,
  } });
  const g2 = game({ game: "26OCT21CCCDDD", away: "CCC", home: "DDD", lines: {
    ml: line({ bets: 10, handle: 2_000, sides: [side("CCC", { ticket_pct: 90, money_pct: 5 }), side("DDD", { ticket_pct: 10, money_pct: 95 })] }),
    spread: null,
    total: line({ rung: "230", rung_label: "230.5", bets: 80, handle: 9_000, sides: [side("Over 230.5", { ticket_pct: 50, money_pct: 85 }), side("Under 230.5", { ticket_pct: 50, money_pct: 15 })] }),
  } });
  const g3 = game({ game: "26OCT21EEEFFF", away: "EEE", home: "FFF" });
  const books = { games: [bookGameOf({ ml: { line_label: null, sides: [
    { side: "EEE", handle_pct: 20, bets_pct: 65 }, { side: "FFF", handle_pct: 80, bets_pct: 35 },
  ] } }, "26OCT21EEEFFF")] };

  it("ranks the side whose money share is furthest above its bet share, skipping Kalshi lines under $5k", () => {
    const out = biggestSplits([g1, g2], null, "kalshi");
    expect(out.map((e) => `${e.game.game}:${e.line}`)).toEqual(["26OCT21CCCDDD:total", "26OCT21AAABBB:ml"]);
    expect(out[0].side.short).toBe("O 230.5");
    expect(out[0].gap).toBe(35);
    // g2's moneyline has a bigger gap (85) but only $2k of handle
    expect(out.some((e) => e.game.game === "26OCT21CCCDDD" && e.line === "ml")).toBe(false);
  });
  it("Kalshi and Both leave DraftKings-only lines out of the strip", () => {
    for (const source of ["kalshi", "both"] as const) {
      const out = biggestSplits([g1, g3], books, source);
      expect(out.map((e) => e.game.game)).toEqual(["26OCT21AAABBB"]);
    }
  });
  it("DraftKings ranks its own shares with no dollar gate, and only lines DraftKings has", () => {
    const dkBooks = { games: [
      ...books.games,
      bookGameOf({ ml: { line_label: null, sides: [
        { side: "CCC", handle_pct: 10, bets_pct: 60 }, { side: "DDD", handle_pct: 90, bets_pct: 40 },
      ] } }, "26OCT21CCCDDD"),
    ] };
    const out = biggestSplits([g1, g2, g3], dkBooks, "dk");
    // g2 moneyline has only $2k of Kalshi handle - the gate does not apply to DraftKings
    expect(out.map((e) => `${e.game.game}:${e.line}`)).toEqual(["26OCT21CCCDDD:ml", "26OCT21EEEFFF:ml"]);
    expect(out[0].gap).toBe(50);
    expect(out.every((e) => e.cell.drawn === "dk")).toBe(true);
    // g1 has no DraftKings split: not a DraftKings line, so not ranked there
    expect(out.some((e) => e.game.game === "26OCT21AAABBB")).toBe(false);
    // the same books under Kalshi still gate g2 ml
    expect(biggestSplits([g2], dkBooks, "kalshi").every((e) => e.line !== "ml")).toBe(true);
  });
  it("keeps at most the count asked for", () => {
    expect(biggestSplits([g1, g2, g3], books, "kalshi", 1)).toHaveLength(1);
    expect(biggestSplits([g1, g2, g3], books, "kalshi", 10)).toHaveLength(2);
    expect(biggestSplits([], null, "kalshi")).toEqual([]);
  });
});

describe("sorting the board", () => {
  const a = game({ game: "A", tip_utc: "2026-10-21T23:00:00Z", lines: { ml: line({ handle: 500, sides: [side("MIN", { ticket_pct: 50, money_pct: 55 }), side("MIA", { ticket_pct: 50, money_pct: 45 })] }), spread: null, total: null } });
  const b = game({ game: "B", tip_utc: "2026-10-21T22:00:00Z", lines: { ml: line({ handle: 9_000, sides: [side("MIN", { ticket_pct: 50, money_pct: 52 }), side("MIA", { ticket_pct: 50, money_pct: 48 })] }), spread: null, total: null } });
  const c = game({ game: "C", tip_utc: "2026-10-21T21:00:00Z", lines: { ml: line({ handle: 100, sides: [side("MIN", { ticket_pct: 10, money_pct: 70 }), side("MIA", { ticket_pct: 90, money_pct: 30 })] }), spread: null, total: null } });
  it("by tip, by handle or by the widest gap", () => {
    expect(sortGames([a, b, c], null, "kalshi", "tip").map((g) => g.game)).toEqual(["C", "B", "A"]);
    expect(sortGames([a, b, c], null, "kalshi", "handle").map((g) => g.game)).toEqual(["B", "A", "C"]);
    expect(sortGames([a, b, c], null, "kalshi", "gap").map((g) => g.game)).toEqual(["C", "A", "B"]);
  });
  it("does not reorder the input", () => {
    const input = [a, b, c];
    sortGames(input, null, "kalshi", "tip");
    expect(input.map((g) => g.game)).toEqual(["A", "B", "C"]);
  });
});

describe("last season's gap bands", () => {
  // p0..p100 in steps of 0.4: p50 = 20, p80 = 32
  const P = Array.from({ length: 101 }, (_, i) => Math.round(i * 0.4 * 10) / 10);

  it("uses the line's own table, falls back to all, and refuses a malformed one", () => {
    const bands: NbaFlowGapBands = { all: P, ml: P.map((v) => v + 1) };
    expect(bandsFor(bands, "ml")![50]).toBe(21);
    expect(bandsFor(bands, "total")).toBe(P);
    expect(bandsFor({ all: [1, 2, 3] }, "ml")).toBeNull();
    expect(bandsFor(null, "ml")).toBeNull();
    expect(bandsFor({ all: P, ml: [1] }, "ml")).toBe(P);
  });
  it("the percentile is the share of lines this gap is wider than", () => {
    expect(gapPercentile(7, P)).toBe(17);
    expect(gapPercentile(0, P)).toBe(0);
    expect(gapPercentile(30, P)).toBe(75);
    expect(gapPercentile(99, P)).toBe(100);
    expect(gapPercentile(-30, P)).toBe(75); // the sign does not matter
  });
  it("ordinary inside the median, wider up to the 80th percentile, then the widest fifth", () => {
    expect(gapZone(10, P)).toBe("ordinary");
    expect(gapZone(19.9, P)).toBe("ordinary");
    expect(gapZone(20, P)).toBe("wider");
    expect(gapZone(31.9, P)).toBe("wider");
    expect(gapZone(32, P)).toBe("widest");
    expect(gapZone(-50, P)).toBe("widest");
  });
  it("the gap with every $1k+ bet out of both sides", () => {
    const lead = side("A", { bets: 20, handle: 10_000, big_bets: 3, big_handle: 9_800 });
    const other = side("B", { bets: 80, handle: 2_000 });
    expect(gapWithoutBig(lead, other)).toBeCloseTo((200 / 2200) * 100 - (17 / 97) * 100);
    // everything was a big bet: nothing left to take a share of
    expect(gapWithoutBig(side("A", { bets: 2, handle: 3000, big_bets: 2, big_handle: 3000 }), side("B", { bets: 1, handle: 2000, big_bets: 1, big_handle: 2000 }))).toBeNull();
  });

  const few = [
    side("A", { bets: 20, handle: 10_000, big_bets: 3, big_handle: 9_800, ticket_pct: 20, money_pct: (10_000 / 12_000) * 100 }),
    side("B", { bets: 80, handle: 2_000, ticket_pct: 80, money_pct: (2_000 / 12_000) * 100 }),
  ] as const;

  it("a wide gap that disappears without the big bets says it is a few big bets, not broad money", () => {
    const r = gapRead(few[1], few[0], P);
    expect(r.lead.side).toBe("A");
    expect(r.zone).toBe("widest");
    expect(r.bigBets).toBe("few");
    const t = gapSentence(r, "total");
    expect(t).toContain("**63 pts** toward A");
    expect(t).toContain("wider than 100% of total lines last season (widest fifth)");
    expect(t).toContain("Take out all 3 $1k+ bets (+63 \u2192 -8 without them): **mostly a few big bets**.");
  });

  it("a wide gap that holds without the big bets says it is broad money", () => {
    const r = gapRead(
      side("A", { bets: 112, handle: 14_240, big_bets: 8, big_handle: 11_000, ticket_pct: 27, money_pct: 78 }),
      side("B", { bets: 300, handle: 4_000, big_bets: 1, big_handle: 1_500, ticket_pct: 73, money_pct: 22 }),
      P,
    );
    expect(r.bigBets).toBe("broad");
    const t = gapSentence(r, "ml");
    expect(t).toContain("wider than 100% of moneyline lines last season (widest fifth)");
    expect(t).toContain("Take out all 9 $1k+ bets (+51 \u2192 +31 without them): **broad money**."); // both sides big bets
  });

  it("an ordinary gap makes no claim about big bets, whatever they do to it", () => {
    const r = gapRead(
      side("A", { bets: 50, handle: 5_000, big_bets: 2, big_handle: 3_000, ticket_pct: 48, money_pct: 55 }),
      side("B", { bets: 54, handle: 4_000, big_bets: 0, ticket_pct: 52, money_pct: 45 }),
      P,
    );
    expect(r.zone).toBe("ordinary");
    expect(r.bigBets).toBeNull();
    const t = gapSentence(r, "spread");
    expect(t).toContain("**7 pts** toward A, wider than 17% of spread lines last season (ordinary).");
    expect(t).not.toMatch(/big bets|broad money|Take out/);
  });

  it("few versus broad is the share of the gap that survives: under half is few", () => {
    const mk = (exLeadHandle: number) => {
      // lead: 20 bets, $10k, one big bet holding all but exLeadHandle; other: 80 bets, $2k
      const lead = side("A", { bets: 20, handle: 10_000, big_bets: 1, big_handle: 10_000 - exLeadHandle, ticket_pct: 20, money_pct: (10_000 / 12_000) * 100 });
      const other = side("B", { bets: 80, handle: 2_000, ticket_pct: 80, money_pct: (2_000 / 12_000) * 100 });
      return gapRead(lead, other, P);
    };
    const gap = (10_000 / 12_000) * 100 - 20;
    expect(mk(100).exGap! / gap).toBeLessThan(0.5);
    expect(mk(100).bigBets).toBe("few");
    expect(mk(8_000).exGap! / gap).toBeGreaterThan(0.5);
    expect(mk(8_000).bigBets).toBe("broad");
    // no big bets at all: nothing to attribute
    const none = gapRead(side("A", { bets: 20, handle: 10_000, ticket_pct: 20, money_pct: 83 }), side("B", { bets: 80, handle: 2_000, ticket_pct: 80, money_pct: 17 }), P);
    expect(none.bigBets).toBeNull();
  });

  it("with no bands file there are no zone and no big-bet claims", () => {
    const r = gapRead(few[1], few[0], null);
    expect(r).toMatchObject({ zone: null, wider: null, bigBets: null });
    expect(gapSentence(r, "total")).toBe("Gap **63 pts** toward A.");
  });

  it("the middle zone is 'wider than usual'", () => {
    const r = gapRead(side("A", { ticket_pct: 40, money_pct: 65 }), side("B", { ticket_pct: 60, money_pct: 35 }), P);
    expect(gapSentence(r, "ml")).toContain("(wider than usual)");
  });
});

describe("the read", () => {
  it("names the side the money leans to, or says there is no lean", () => {
    const [mia, min] = kalshiMl().sides;
    expect(leanSentence(mia, min)).toBe(
      "Money leans **MIA**: 78% of the money from 27% of the bets, against 73% of bets on MIN.",
    );
    const t = leanSentence(side("A", { ticket_pct: 49, money_pct: 52 }), side("B", { ticket_pct: 51, money_pct: 48 }));
    expect(t).toBe("No lean: the money split (52% / 48%) tracks the bet split (49% / 51%).");
  });
  it("average bet per side, with the ratio only when it is 1.5x or more", () => {
    const a = avgBet({ side: "A", bets: 10, handle: 5_000 }, { side: "B", bets: 100, handle: 4_000 });
    expect(a.hi).toEqual({ side: "A", avg: 500 });
    expect(a.lo).toEqual({ side: "B", avg: 40 });
    expect(a.ratio).toBeCloseTo(12.5);
    expect(avgBetSentence(a)).toBe("Average bet: **$500** on A against $40 on B (12.5x).");
    const close = avgBet({ side: "Over 1", bets: 10, handle: 1_000 }, { side: "Under 1", bets: 10, handle: 1_200 });
    expect(close.showRatio).toBe(false);
    expect(avgBetSentence(close)).toBe("Average bet: **$120** on U 1 against $100 on O 1.");
    expect(avgBet({ side: "A", bets: 0, handle: 0 }, { side: "B", bets: 0, handle: 0 }).ratio).toBeNull();
  });
});

describe("when the money came in", () => {
  const tip = Date.parse("2026-10-21T23:30:00Z");
  const H = 3_600_000;
  const row = (msBeforeTip: number, s: string, bets: number, handle: number): NbaFlowTimelineRow => ({
    t: new Date(tip - msBeforeTip).toISOString(), side: s, bets, handle, big_bets: 0, big_handle: 0, price: null,
  });

  it("files a bucket by how far ahead of the tip it opened", () => {
    expect(whenBucketOf(tip - 25 * H, tip)).toBe("over24h");
    expect(whenBucketOf(tip - 24 * H, tip)).toBe("24h-6h"); // exactly 24h out is not "more than"
    expect(whenBucketOf(tip - 6 * H, tip)).toBe("6h-1h");
    expect(whenBucketOf(tip - 1 * H, tip)).toBe("lastHour");
    expect(whenBucketOf(tip - 15 * 60_000, tip)).toBe("lastHour");
    expect(whenBucketOf(tip, tip)).toBe("inGame");
    expect(whenBucketOf(tip + H, tip)).toBe("inGame");
  });

  const rows = [
    row(30 * H, "MIN", 10, 100),
    row(30 * H, "MIA", 10, 300),
    row(10 * H, "MIN", 30, 600),
    row(3 * H, "MIA", 20, 1_000),
    row(30 * 60_000, "MIN", 10, 0),
    row(0, "MIA", 5, 5_000),
  ];

  it("per window: bets, dollars and the left side's shares of each", () => {
    const out = whenTheMoneyCame(rows, "MIN", tip, true);
    expect(out.map((r) => r.bucket)).toEqual(["over24h", "24h-6h", "6h-1h", "lastHour", "inGame"]);
    expect(out[0]).toMatchObject({ label: "more than 24h out", bets: 20, handle: 400, leftBetPct: 50, leftMoneyPct: 25 });
    expect(out[1]).toMatchObject({ bets: 30, handle: 600, leftBetPct: 100, leftMoneyPct: 100 });
    expect(out[2]).toMatchObject({ bets: 20, handle: 1_000, leftBetPct: 0, leftMoneyPct: 0 });
    // a window with bets but no dollars has no money share
    expect(out[3]).toMatchObject({ bets: 10, handle: 0, leftBetPct: 100, leftMoneyPct: null });
    expect(out[4]).toMatchObject({ label: "in game", bets: 5, leftBetPct: 0 });
  });
  it("an off-grid tip: the backend cuts the bucket at the tip, so t < tip is pregame and t >= tip is live", () => {
    const tip2 = Date.parse("2026-10-21T23:20:00Z");
    const mk = (t: string, s: string, bets: number): NbaFlowTimelineRow => ({ t, side: s, bets, handle: bets * 10, big_bets: 0, big_handle: 0, price: null });
    const tl = [mk("2026-10-21T23:00:00Z", "MIN", 10), mk("2026-10-21T23:15:00Z", "MIN", 3), mk("2026-10-21T23:20:00Z", "MIN", 7)];
    const pre = whenTheMoneyCame(tl, "MIN", tip2, false);
    expect(pre).toHaveLength(1);
    expect(pre[0]).toMatchObject({ bucket: "lastHour", bets: 13 }); // 23:00 and the 23:15 partial
    const all = whenTheMoneyCame(tl, "MIN", tip2, true);
    expect(all.map((r) => [r.bucket, r.bets])).toEqual([["lastHour", 13], ["inGame", 7]]);
  });
  it("leaves out in-game bets before the tip view, and windows with no bets", () => {
    const out = whenTheMoneyCame(rows, "MIN", tip, false);
    expect(out.map((r) => r.bucket)).not.toContain("inGame");
    expect(whenTheMoneyCame([row(10 * H, "MIN", 3, 10)], "MIN", tip, true).map((r) => r.bucket)).toEqual(["24h-6h"]);
    expect(whenTheMoneyCame([], "MIN", tip, true)).toEqual([]);
    expect(whenTheMoneyCame(rows, "MIN", NaN, true)).toEqual([]);
  });
});

describe("one rung's sides for the phase on screen", () => {
  const sizes: NbaFlowSizeRow[] = [
    { bucket: "<$10", side: "A", bets: 90, handle: 400 },
    { bucket: "$1k-10k", side: "A", bets: 2, handle: 4000 },
    { bucket: "$10k+", side: "B", bets: 1, handle: 12_000 },
    { bucket: "$10-100", side: "B", bets: 10, handle: 300 },
  ];
  const tip = Date.parse("2026-10-21T23:30:00Z");
  const tl = (t: string, s: string, price: number | null): NbaFlowTimelineRow => ({ t, side: s, bets: 1, handle: 1, big_bets: 0, big_handle: 0, price });
  const timeline = [
    tl("2026-10-21T20:00:00Z", "A", 44),
    tl("2026-10-21T22:00:00Z", "A", 41),
    tl("2026-10-21T23:45:00Z", "A", 12), // after the tip
  ];

  it("totals, shares, big bets and prices come from the size mix and the timeline", () => {
    const [a, b] = sideStats(sizes, timeline, ["A", "B"], tip, false);
    expect(a).toMatchObject({ side: "A", bets: 92, handle: 4_400, big_bets: 2, big_handle: 4_000, price_first: 44, price_last: 41 });
    expect(b).toMatchObject({ bets: 11, handle: 12_300, big_bets: 1, big_handle: 12_000, price_first: null, price_last: null });
    expect(a.ticket_pct).toBeCloseTo((92 / 103) * 100);
    expect(a.money_pct).toBeCloseTo((4_400 / 16_700) * 100);
    expect(a.gap).toBeCloseTo(a.money_pct - a.ticket_pct);
    // whole game: the last price is the last one printed
    expect(sideStats(sizes, timeline, ["A", "B"], tip, true)[0].price_last).toBe(12);
    // an off-grid tip: a row starting AT the tip is live, one just before is pregame
    const tip2 = Date.parse("2026-10-21T23:20:00Z");
    const tl2 = [tl("2026-10-21T23:15:00Z", "A", 40), tl("2026-10-21T23:20:00Z", "A", 9)];
    expect(sideStats(sizes, tl2, ["A", "B"], tip2, false)[0].price_last).toBe(40);
    expect(sideStats(sizes, tl2, ["A", "B"], tip2, true)[0].price_last).toBe(9);
  });
  it("nothing on a side gives zero shares, not NaN", () => {
    const [a, b] = sideStats([], [], ["A", "B"], tip, true);
    expect([a.ticket_pct, a.money_pct, b.gap]).toEqual([0, 0, 0]);
  });
  it("every size bucket for the two sides, in size order, zero-filled", () => {
    const rows = sizeMix(sizes, "A", "B");
    expect(rows.map((r) => r.bucket)).toEqual(["<$10", "$10-100", "$100-1k", "$1k-10k", "$10k+"]);
    expect(rows[0]).toEqual({ bucket: "<$10", a: { bets: 90, handle: 400 }, b: { bets: 0, handle: 0 } });
    expect(rows[2]).toEqual({ bucket: "$100-1k", a: { bets: 0, handle: 0 }, b: { bets: 0, handle: 0 } });
    expect(rows[4].b).toEqual({ bets: 1, handle: 12_000 });
  });
  it("the big bets follow the phase: in-game bets only when the whole game is on", () => {
    const bets = [
      { ts: "a", side: "A", dollars: 1000, contracts: 1, price: 50, phase: "pregame" as const },
      { ts: "b", side: "A", dollars: 2000, contracts: 1, price: 50, phase: "live" as const },
    ];
    expect(bigBetsFor(bets, false).map((b) => b.ts)).toEqual(["a"]);
    expect(bigBetsFor(bets, true).map((b) => b.ts)).toEqual(["a", "b"]);
    expect(bigBetsFor(undefined, true)).toEqual([]);
  });
});

describe("selection", () => {
  it("a game opens the first line that has Kalshi bets or a DraftKings split", () => {
    expect(defaultLine(game({ lines: { ml: null, spread: line(), total: null } }))).toBe("spread");
    expect(defaultLine(game(), bookGameOf({ total: dkMl() }))).toBe("total");
    expect(defaultLine(game())).toBe("ml");
  });
  it("a row opens that game; a line cell its own line; changing the line drops the rung", () => {
    const g = game({ lines: { ml: null, spread: line(), total: null } });
    expect(selectionReducer(null, { type: "row", game: g })).toEqual({ game: g.game, line: "spread", rung: null });
    expect(selectionReducer(null, { type: "line", game: g, line: "total" })).toEqual({ game: g.game, line: "total", rung: null });
    let sel = selectionReducer(null, { type: "line", game: g, line: "spread" });
    sel = selectionReducer(sel, { type: "rung", rung: "MIA6" });
    expect(sel?.rung).toBe("MIA6");
    expect(selectionReducer(sel, { type: "setLine", line: "total" })).toEqual({ game: g.game, line: "total", rung: null });
    expect(selectionReducer(sel, { type: "close" })).toBeNull();
    expect(selectionReducer(null, { type: "setLine", line: "ml" })).toBeNull();
    expect(selectionReducer(null, { type: "rung", rung: "x" })).toBeNull();
  });
});

describe("wording", () => {
  it("tells an HTTP failure from an unreachable backend", () => {
    expect(fetchErrorText("Error: GET /nba/flow/books -> 503 Service Unavailable · historical DB unavailable"))
      .toBe("endpoint returned 503 Service Unavailable - historical DB unavailable");
    expect(fetchErrorText("TypeError: Failed to fetch")).toBe("backend unreachable - TypeError: Failed to fetch");
  });
  it("parses a stamp with no zone as UTC", () => {
    expect(parseIso("2026-10-21T20:00:00")).toBe(Date.parse("2026-10-21T20:00:00Z"));
    expect(parseIso("2026-10-21 20:00:00+00:00")).toBe(Date.parse("2026-10-21T20:00:00Z"));
    expect(Number.isNaN(parseIso("nope"))).toBe(true);
  });
});

describe("stale-response guards", () => {
  it("the slate must answer the date and phase on screen", () => {
    const slate = { date: "2026-10-21", phase: "pregame" };
    expect(slateMatches(slate, "2026-10-21", "pregame")).toBe(true);
    expect(slateMatches(slate, "2026-10-22", "pregame")).toBe(false);
    expect(slateMatches(slate, "2026-10-21", "all")).toBe(false);
    expect(slateMatches(null, "2026-10-21", "all")).toBe(false);
  });
  it("the book splits must answer the date on screen", () => {
    expect(booksMatch({ date: "2026-10-21" }, "2026-10-21")).toBe(true);
    expect(booksMatch({ date: "2026-10-20" }, "2026-10-21")).toBe(false);
    expect(booksMatch(null, "2026-10-21")).toBe(false);
  });
  it("finds a game's book entry, or none", () => {
    const books = { games: [bookGameOf({ ml: dkMl() })] };
    expect(bookGame(books, "26OCT21MINMIA")?.lines.ml).toBeTruthy();
    expect(bookGame(books, "other")).toBeUndefined();
    expect(bookGame(null, "26OCT21MINMIA")).toBeUndefined();
  });
  it("the detail must answer the game and the line; the rung is not compared (the backend may substitute its main one)", () => {
    const d = { game: "G", line: "spread", rung: "MIA5" };
    expect(detailMatches({ game: "G", line: "spread" }, d)).toBe(true);
    expect(detailMatches({ game: "G", line: "total" }, d)).toBe(false);
    expect(detailMatches({ game: "H", line: "spread" }, d)).toBe(false);
    expect(detailMatches({ game: "G", line: "spread" }, null)).toBe(false);
  });
  it("the team codes come out of the game code", () => {
    expect(gameCodeTeams("26OCT21MINMIA")).toEqual({ away: "MIN", home: "MIA" });
    expect(gameCodeTeams("nonsense")).toBeNull();
  });
  it("identical data keeps the same object, changed data does not", () => {
    const first = stabilize(null, { a: 1 });
    expect(stabilize(first, { a: 1 })).toBe(first);
    const next = stabilize(first, { a: 2 });
    expect(next).not.toBe(first);
    expect(next.value).toEqual({ a: 2 });
  });
  it("a past slate stops polling only when every game is final", () => {
    const g = (status: "final" | "live") => ({ status });
    expect(slateIsSettled({ date: "2026-10-20", games: [g("final"), g("final")] }, "2026-10-21")).toBe(true);
    expect(slateIsSettled({ date: "2026-10-20", games: [g("final"), g("live")] }, "2026-10-21")).toBe(false);
    expect(slateIsSettled({ date: "2026-10-21", games: [g("final")] }, "2026-10-21")).toBe(false);
    expect(slateIsSettled({ date: "2026-10-20", games: [] }, "2026-10-21")).toBe(false);
    expect(slateIsSettled(null, "2026-10-21")).toBe(false);
  });
});
