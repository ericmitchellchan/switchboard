// The combo desk's pure helpers (SWIT-129): leg labels from the real ticker
// shapes, the money and count formats, the health word, the risk text, and the
// row a position draws as.

import { describe, expect, it } from "vitest";
import type { ComboDeskPosition, ComboDeskView } from "../api/client";
import {
  exposureBars,
  fmtCents,
  fmtContracts,
  fmtSigned,
  fmtUsd,
  gameLabel,
  healthWord,
  heldText,
  killErrorText,
  legLabel,
  openCount,
  positionRows,
  riskText,
  settledPnl,
  tickerTail,
} from "./comboDesk";

const pos = (o: Partial<ComboDeskPosition> = {}): ComboDeskPosition => ({
  market_ticker: "KXMVE-COMBO1",
  event_ticker: "KXMVE-EVT1",
  legs: [
    { market_ticker: "KXNBAPTS-26OCT21ATLORL-ATLJJOHNSON1-20", event_ticker: "KXNBAPTS-26OCT21ATLORL", side: "yes" },
    { market_ticker: "KXNBAREB-26OCT21ATLORL-ORLPBANCHERO5-8", event_ticker: "KXNBAREB-26OCT21ATLORL", side: "yes" },
  ],
  label: "combo",
  side: "no",
  contracts_ledger: 30,
  cost_ledger: 12,
  price_ledger: 0.4,
  contracts_kalshi: 30,
  cost_kalshi: 12,
  fees_kalshi: 0.2,
  status: "open",
  result: null,
  settled_time: null,
  pnl_kalshi: null,
  worst_case: 12,
  agree: true,
  note: null,
  ...o,
});

const view = (o: Partial<ComboDeskView> = {}): ComboDeskView => ({
  env: "demo",
  generated_at: "2026-10-21T18:00:00Z",
  available: true,
  reason: null,
  kalshi_error: null,
  balance: { dollars: 512.4, portfolio_value_dollars: 40, subaccount: 0 },
  health: { killed: false, kill_reason: "", pending: 0, unmatched: 0, unknown_fills: 0, errors: 0, failed_confirms: 0, ledger_events: 9, last_event_ts: null },
  limits: { max_loss_per_quote: 25, per_game: 40, per_player: 30, total_open: 200, daily_loss: 100 },
  exposure: { total_open: 157, by_game: [], by_player: [] },
  positions: [],
  requests: [],
  fills: [],
  settlements: [],
  pnl: { realized_ledger: -3, realized_kalshi: null, fees_kalshi: null, by_day: {} },
  ...o,
});

describe("legLabel", () => {
  it("reads a points prop as team, initial and surname, threshold plus", () => {
    expect(legLabel("KXNBAPTS-26OCT21ATLORL-ATLJJOHNSON1-20")).toBe("ATL J.Johnson 20+");
  });
  it("strips the trailing digits of the name and names a non-points stat", () => {
    expect(legLabel("KXNBAREB-26OCT21ATLORL-ORLPBANCHERO5-8")).toBe("ORL P.Banchero 8+ reb");
    expect(legLabel("KXNBAPTS-26OCT21ATLORL-ORLPBANCHERO-25")).toBe("ORL P.Banchero 25+");
  });
  it("falls back to the ticker tail for a shape it does not know", () => {
    expect(legLabel("KXNBAGAME-26OCT21ATLORL-ATL")).toBe("26OCT21ATLORL-ATL");
    expect(legLabel("KXMVE-COMBO1")).toBe("KXMVE-COMBO1");
    expect(legLabel("KXNBAPTS-26OCT21ATLORL-123-20")).toBe("123-20");
  });
  it("tickerTail is the last two segments", () => {
    expect(tickerTail("A-B-C-D")).toBe("C-D");
    expect(tickerTail("A-B")).toBe("A-B");
  });
});

describe("formats", () => {
  it("dollars drop empty decimals and keep one or two", () => {
    expect(fmtUsd(157)).toBe("$157");
    expect(fmtUsd(19.6)).toBe("$19.6");
    expect(fmtUsd(3.47)).toBe("$3.47");
    expect(fmtUsd(40)).toBe("$40");
    expect(fmtUsd(1240.4)).toBe("$1,240");
    expect(fmtUsd(null)).toBe("-");
  });
  it("a P&L carries its sign", () => {
    expect(fmtSigned(12.4)).toBe("+$12.4");
    expect(fmtSigned(-3.1)).toBe("-$3.1");
    expect(fmtSigned(0)).toBe("$0");
  });
  it("counts and prices", () => {
    expect(fmtContracts(30)).toBe("30");
    expect(fmtContracts(29.7)).toBe("29.7");
    expect(fmtCents(0.375)).toBe("37.5c");
    expect(fmtCents(0.4)).toBe("40c");
  });
  it("a game key reads away @ home", () => {
    expect(gameLabel("26OCT21ATLORL")).toBe("ATL @ ORL");
    expect(gameLabel("whatever")).toBe("whatever");
  });
});

describe("healthWord", () => {
  it("is ok when nothing is waiting", () => {
    expect(healthWord(view())).toEqual({ text: "ok", tone: "ok" });
  });
  it("killed wins over everything", () => {
    const v = view();
    v.health = { ...v.health, killed: true, pending: 3 };
    expect(healthWord(v)).toEqual({ text: "killed", tone: "kill" });
  });
  it("names what is waiting, in severity order", () => {
    const v = view();
    v.health = { ...v.health, pending: 2, unmatched: 1 };
    expect(healthWord(v)).toEqual({ text: "2 pending · 1 unmatched", tone: "warn" });
    v.health = { ...v.health, pending: 0, unmatched: 0, unknown_fills: 1, errors: 2 };
    expect(healthWord(v).text).toBe("1 unknown fill · 2 errors");
  });
});

describe("riskText and the figures", () => {
  it("is the worst case held against the total-open limit", () => {
    expect(riskText(view())).toBe("$157 / $200");
  });
  it("settled P&L is Kalshi's number, else the ledger's", () => {
    expect(settledPnl(view())).toBe(-3);
    const v = view();
    v.pnl = { ...v.pnl, realized_kalshi: 8 };
    expect(settledPnl(v)).toBe(8);
  });
  it("counts only open positions", () => {
    expect(openCount(view({ positions: [pos(), pos({ status: "settled" })] }))).toBe(1);
  });
});

describe("positionRows", () => {
  it("an agreeing open position has no second line and a check", () => {
    const [r] = positionRows(view({ positions: [pos()] }));
    expect(r.legs).toEqual(["ATL J.Johnson 20+", "ORL P.Banchero 8+ reb"]);
    expect(r.held).toBe("NO wins if either misses");
    expect(r.contracts).toBe("30");
    expect(r.contractsKalshi).toBeNull();
    expect(r.price).toBe("40c");
    expect(r.status.kind).toBe("open");
  });
  it("a disagreement carries Kalshi's count", () => {
    const [r] = positionRows(view({ positions: [pos({ agree: false, contracts_kalshi: 29.7 })] }));
    expect(r.contractsKalshi).toBe("29.7");
  });
  it("a settled position is won or lost by its side against the result, with the pnl", () => {
    const [lost] = positionRows(view({ positions: [pos({ status: "settled", side: "no", result: "yes", pnl_kalshi: -12 })] }));
    expect(lost.status).toMatchObject({ kind: "lost", word: "lost", pnl: "-$12", pnlTone: "dn" });
    const [won] = positionRows(view({ positions: [pos({ status: "settled", side: "no", result: "no", pnl_kalshi: 18 })] }));
    expect(won.status).toMatchObject({ kind: "won", pnl: "+$18", pnlTone: "up" });
  });
  it("a one-sided position says which side has it", () => {
    const [r] = positionRows(view({ positions: [pos({ status: "kalshi_only", contracts_ledger: null, cost_ledger: null, price_ledger: null, agree: false })] }));
    expect(r.status.word).toBe("Kalshi only");
    expect(r.contracts).toBe("30");
  });
  it("held text for yes and for more legs", () => {
    expect(heldText("yes", 2)).toBe("YES wins if both hit");
    expect(heldText("yes", 3)).toBe("YES wins if all 3 hit");
    expect(heldText("no", 3)).toBe("NO wins if any misses");
  });
});

describe("exposureBars", () => {
  it("is worst case over cap, flagged when over", () => {
    const [a, b] = exposureBars(
      [
        { key: "26OCT21ATLORL", worst_case: 19.6, cap: 40 },
        { key: "x", worst_case: 50, cap: 40 },
      ],
      gameLabel,
    );
    expect(a).toMatchObject({ label: "ATL @ ORL", value: "$19.6 / $40", over: false });
    expect(a.pct).toBeCloseTo(49, 0);
    expect(b).toMatchObject({ pct: 100, over: true });
  });
});

describe("killErrorText", () => {
  it("keeps the backend's detail, which carries the CLI command", () => {
    expect(killErrorText("Error: POST /combos/desk/kill?env=live -> 409 Conflict · live kill is not armed in this API process; run: x")).toBe(
      "live kill is not armed in this API process; run: x",
    );
    expect(killErrorText("TypeError: Failed to fetch")).toBe("TypeError: Failed to fetch");
  });
});
