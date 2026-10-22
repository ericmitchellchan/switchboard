// The combo desk's Positions board (SWIT-129). No DOM in this repo's vitest, so
// the hook-free component is server-rendered to markup and read as text.

import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComboDeskPosition, ComboDeskView } from "../../api/client";
import DeskPositions, { type DeskPositionsProps } from "./DeskPositions";

const text = (markup: string) => markup.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const OPEN: ComboDeskPosition = {
  market_ticker: "KXMVE-COMBO1",
  event_ticker: "KXMVE-EVT1",
  legs: [
    { market_ticker: "KXNBAPTS-26OCT21ATLORL-ATLJJOHNSON1-20", event_ticker: "KXNBAPTS-26OCT21ATLORL", side: "yes" },
    { market_ticker: "KXNBAPTS-26OCT21ATLORL-ORLPBANCHERO5-25", event_ticker: "KXNBAPTS-26OCT21ATLORL", side: "yes" },
  ],
  label: "J.Johnson 20+ and P.Banchero 25+",
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
};

const LOST: ComboDeskPosition = {
  ...OPEN,
  market_ticker: "KXMVE-COMBO2",
  legs: [
    { market_ticker: "KXNBAPTS-26OCT20BOSNYK-BOSJTATUM0-30", event_ticker: "KXNBAPTS-26OCT20BOSNYK", side: "yes" },
    { market_ticker: "KXNBAREB-26OCT20BOSNYK-NYKKTOWNS0-10", event_ticker: "KXNBAREB-26OCT20BOSNYK", side: "yes" },
  ],
  contracts_ledger: 30,
  contracts_kalshi: 29.7,
  cost_ledger: 15,
  cost_kalshi: 14.85,
  status: "settled",
  result: "yes",
  settled_time: "2026-10-21T02:10:00Z",
  pnl_kalshi: -14.85,
  worst_case: 15,
  agree: false,
  note: "Kalshi filled 29.7 of 30",
};

const VIEW: ComboDeskView = {
  env: "demo",
  generated_at: "2026-10-21T18:00:00Z",
  available: true,
  reason: null,
  kalshi_error: null,
  balance: { dollars: 512.4, portfolio_value_dollars: 40, subaccount: 0 },
  health: { killed: false, kill_reason: "", pending: 1, unmatched: 0, unknown_fills: 0, errors: 0, failed_confirms: 0, ledger_events: 12, last_event_ts: null },
  limits: { max_loss_per_quote: 25, per_game: 40, per_player: 30, total_open: 200, daily_loss: 100 },
  exposure: {
    total_open: 157,
    by_game: [{ key: "26OCT21ATLORL", worst_case: 19.6, cap: 40 }],
    by_player: [{ key: "ATLJJOHNSON1", worst_case: 12, cap: 30 }],
  },
  positions: [OPEN, LOST],
  requests: [
    { rfq_id: "r1", market_ticker: "KXMVE-COMBO1", created_ts: "2026-10-21T17:00:00Z", target_cost: 10, contracts: 25, manual: false, accepted_quote: null, status: "open" },
    { rfq_id: "r2", market_ticker: "KXMVE-COMBO2", created_ts: "2026-10-21T16:00:00Z", target_cost: 9, contracts: 20, manual: true, accepted_quote: "q", status: "accepted" },
  ],
  fills: [
    { ts: "2026-10-21T15:00:00Z", ticker: "KXMVE-COMBO1", side: "no", contracts: 30, price: 0.4, cost: 12, fee: 0.2, in_ledger: true },
    { ts: "2026-10-21T17:30:00Z", ticker: "KXMVE-COMBO9", side: "no", contracts: 5, price: 0.5, cost: 2.5, fee: null, in_ledger: false },
  ],
  settlements: [
    { ticker: "KXMVE-COMBO2", event_ticker: "KXMVE-EVT2", result: "yes", settled_time: "2026-10-21T02:10:00Z", contracts: 29.7, cost: 14.85, revenue: 0, fee: 0.2, pnl: -14.85 },
  ],
  pnl: { realized_ledger: -15, realized_kalshi: -14.85, fees_kalshi: 0.4, by_day: { "2026-10-21": -14.85 } },
};

const props = (o: Partial<DeskPositionsProps> = {}): DeskPositionsProps => ({
  view: VIEW,
  error: null,
  env: "demo",
  onEnv: vi.fn(),
  onKill: vi.fn(),
  onUnkill: vi.fn(),
  killState: "idle",
  onKillState: vi.fn(),
  ...o,
});
const render = (o?: Partial<DeskPositionsProps>) => renderToStaticMarkup(createElement(DeskPositions, props(o)) as ReactElement);

describe("DeskPositions", () => {
  it("draws the figures, the positions with their legs, and both account switches", () => {
    const out = render();
    const t = text(out);
    for (const w of ["balance", "at risk", "open positions", "settled P&amp;L", "fees", "health"]) expect(t).toContain(w);
    expect(t).toContain("$157 / $200");
    expect(t).toContain("1 pending");
    expect(t).toContain("ATL J.Johnson 20+ + ORL P.Banchero 25+");
    expect(t).toContain("NO wins if either misses");
    expect(out).toMatch(/aria-pressed="true"[^>]*data-seg="demo"/);
    expect(out).toContain('data-seg="live"');
  });

  it("marks a settled loss and a ledger-vs-Kalshi disagreement", () => {
    const t = text(render());
    expect(t).toContain("lost");
    expect(t).toContain("-$14.85");
    expect(t).toContain("differs");
    expect(t).toContain("Kalshi 29.7");
    // the agreeing open position reads open, with a check and no 'differs' of its own
    expect(t).toContain("open");
    expect(text(render({ view: { ...VIEW, positions: [OPEN] } }))).not.toContain("differs");
  });

  it("draws exposure bars against their caps", () => {
    const out = render();
    expect(text(out)).toContain("ATL @ ORL");
    expect(text(out)).toContain("$19.6 / $40");
    expect(out).toContain('data-exposure="ATLJJOHNSON1"');
  });

  it("lists open requests only, fills newest first, flags a fill the ledger lacks, and settlements", () => {
    const out = render();
    const t = text(out);
    expect(out).toContain('data-request="r1"');
    expect(out).not.toContain('data-request="r2"');
    expect(t).toContain("not in ledger");
    expect(t).toContain("in ledger");
    // the 17:30 fill (unknown combo -> ticker tail) comes before the 15:00 one
    expect(t).toContain("KXMVE-COMBO9");
    expect(t.indexOf("5 @ 50c")).toBeGreaterThan(-1);
    expect(t.indexOf("5 @ 50c")).toBeLessThan(t.indexOf("30 @ 40c"));
  });

  it("folds empty sections to one quiet line each", () => {
    const t = text(render({ view: { ...VIEW, positions: [], requests: [], fills: [], settlements: [], exposure: { total_open: 0, by_game: [], by_player: [] } } }));
    for (const w of ["no positions", "nothing at risk", "no open requests", "no fills", "no settlements"]) expect(t).toContain(w);
  });

  it("says Kalshi is unreachable and that it shows the ledger only, still drawing the board", () => {
    const t = text(render({ view: { ...VIEW, kalshi_error: "timeout" } }));
    expect(t).toContain("Kalshi unreachable (timeout): showing the ledger only");
    expect(t).toContain("Positions");
  });

  it("an unavailable desk is its reason and nothing else", () => {
    const out = render({ view: { ...VIEW, available: false, reason: "no demo credentials in the API process" } });
    const t = text(out);
    expect(t).toContain("no demo credentials in the API process");
    expect(t).not.toContain("balance");
    expect(t).not.toContain("Kill switch");
  });

  it("loads before it draws, and shows a poll failure", () => {
    expect(text(render({ view: null }))).toContain("loading the combo desk");
    expect(text(render({ view: null, error: "Error: GET /combos/desk?env=demo -> 500 Internal Server Error" }))).toContain("endpoint returned 500");
  });

  it("has a kill button, then asks before it cancels, then shows a refusal in one line", () => {
    const idle = render();
    expect(idle).toMatch(/<button[^>]*data-action="kill"[^>]*>kill<\/button>/);
    expect(text(idle)).toContain("running");

    const ask = render({ killState: "confirm" });
    expect(text(ask)).toContain("cancel every open quote and request?");
    expect(ask).toContain('data-action="kill-yes"');
    expect(ask).toContain('data-action="kill-no"');

    const refused = render({ killState: { error: "live kill is not armed in this API process; run: x" } });
    expect(text(refused)).toContain("live kill is not armed in this API process; run: x");
  });

  it("a killed desk shows its reason and offers unkill instead", () => {
    const out = render({ view: { ...VIEW, health: { ...VIEW.health, killed: true, kill_reason: "daily loss limit" } } });
    expect(text(out)).toContain("killed");
    expect(text(out)).toContain("daily loss limit");
    expect(out).toContain('data-action="unkill"');
    expect(out).not.toContain('data-action="kill"');
  });
});
