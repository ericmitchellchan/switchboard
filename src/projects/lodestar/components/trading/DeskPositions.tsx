/**
 * Kalshi Trading / Positions - the combo desk as a BOARD (SWIT-129): one row of
 * figures, then the desk's positions (its ledger against what Kalshi says), the
 * worst case held against each cap, the open requests, the fills, the
 * settlements, and the kill switch. No box per cell; one hairline between
 * rows; a section with nothing in it folds to one quiet line. Hook-free: the
 * page owns the poll and the kill state, this only draws what it is handed.
 */

import type { CSSProperties, ReactNode } from "react";
import type { ComboDeskEnv, ComboDeskView } from "../../api/client";
import { fetchErrorText } from "../../lib/kalshiFlow";
import {
  exposureBars,
  exposurePlayerLabel,
  fmtContracts,
  fmtCents,
  fmtSigned,
  fmtTime,
  fmtUsd,
  gameLabel,
  healthWord,
  legLabel,
  openCount,
  pnlTone,
  positionRows,
  riskText,
  settledPnl,
  tickerTail,
  type ExposureBar,
  type PositionRow,
} from "../../lib/comboDesk";
import { T } from "../../../../lib/typeScale";
import Seg from "./Seg";
import { HAIRLINE, SIDE_INK } from "./flowInk";

/** The kill button's life: nothing pending, asking "are you sure", waiting on the API, or failed. */
export type KillState = "idle" | "confirm" | "busy" | { error: string };

export interface DeskPositionsProps {
  view: ComboDeskView | null;
  /** The poll's last failure (any shape; drawn through fetchErrorText). */
  error: unknown;
  env: ComboDeskEnv;
  onEnv: (env: ComboDeskEnv) => void;
  onKill: () => void;
  onUnkill: () => void;
  killState: KillState;
  onKillState: (next: KillState) => void;
}

const MONO: CSSProperties = { ...T.mono, color: "var(--text-primary)" };
const QUIET: CSSProperties = { ...T.label, fontWeight: 400, letterSpacing: "normal", color: "var(--text-dim)" };
const AMBER: CSSProperties = { ...T.bodySm, color: "var(--tone-amber)" };
const INK = { up: "var(--up)", dn: "var(--dn)" } as const;

const POS_COLS = "minmax(0,2.2fr) 84px 64px 72px 72px 120px 64px";
const FILL_COLS = "92px minmax(0,1fr) 40px 150px 72px 110px";
const REQ_COLS = "92px minmax(0,1fr) 80px 80px 70px";
const SETTLE_COLS = "92px minmax(0,1fr) 50px 80px";

const row = (cols: string): CSSProperties => ({
  display: "grid",
  gridTemplateColumns: cols,
  columnGap: 12,
  alignItems: "baseline",
  padding: "8px 0",
  borderBottom: HAIRLINE,
});

function SectionHead({ title, meta }: { title: string; meta?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, margin: "28px 0 10px", flexWrap: "wrap" }}>
      <h3 style={{ ...T.heading, margin: 0, color: "var(--text-primary)" }}>{title}</h3>
      {meta ? <span style={QUIET}>{meta}</span> : null}
    </div>
  );
}

function Fig({ value, label, ink }: { value: string; label: string; ink?: string }) {
  return (
    <div>
      <div style={{ ...T.metric, color: ink ?? "var(--text-primary)" }}>{value}</div>
      <div style={{ ...T.bodySm, color: "var(--text-muted)" }}>{label}</div>
    </div>
  );
}

/** A section's one quiet line when it has nothing to show. */
const Empty = ({ children }: { children: string }) => <div style={{ ...QUIET, padding: "4px 0" }}>{children}</div>;

const HeadRow = ({ cols, labels }: { cols: string; labels: string[] }) => (
  <div style={{ display: "grid", gridTemplateColumns: cols, columnGap: 12, padding: "0 0 4px", borderBottom: HAIRLINE }}>
    {labels.map((l, i) => (
      <span key={`${l}${i}`} style={QUIET}>
        {l}
      </span>
    ))}
  </div>
);

function PositionLine({ r }: { r: PositionRow }) {
  const s = r.status;
  const wordInk = s.kind === "won" ? INK.up : s.kind === "lost" ? INK.dn : s.kind === "open" ? "var(--text-dim)" : "var(--tone-amber)";
  return (
    <div style={row(POS_COLS)} data-position={r.key}>
      <div style={{ minWidth: 0 }}>
        <div style={{ ...T.body, color: "var(--text-primary)" }}>{r.legs.join(" + ")}</div>
        <div style={{ ...T.bodySm, color: "var(--text-muted)" }}>{r.held}</div>
      </div>
      <div>
        <div style={MONO}>{r.contracts}</div>
        {r.contractsKalshi ? <div style={QUIET}>Kalshi {r.contractsKalshi}</div> : null}
      </div>
      <div style={MONO}>{r.price}</div>
      <div>
        <div style={MONO}>{r.cost}</div>
        {r.costKalshi ? <div style={QUIET}>Kalshi {r.costKalshi}</div> : null}
      </div>
      <div style={MONO}>{r.worst}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <span style={{ ...T.bodySm, color: wordInk }}>{s.word}</span>
        {s.pnl ? <span style={{ ...T.mono, color: s.pnlTone ? INK[s.pnlTone] : "var(--text-primary)" }}>{s.pnl}</span> : null}
      </div>
      <div title={r.note ?? undefined}>
        {r.agree ? (
          <span aria-label="ledger and Kalshi agree" style={{ ...T.bodySm, color: "var(--text-faint)" }}>
            {"✓"}
          </span>
        ) : (
          <span style={AMBER}>differs</span>
        )}
      </div>
    </div>
  );
}

function ExposureBars({ title, bars }: { title: string; bars: ExposureBar[] }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ ...QUIET, marginBottom: 2 }}>{title}</div>
      {bars.map((b) => (
        <div
          key={b.key}
          data-exposure={b.key}
          style={{ display: "grid", gridTemplateColumns: "150px minmax(0,1fr) 110px", columnGap: 12, alignItems: "center", padding: "4px 0" }}
        >
          <span style={{ ...T.mono, color: "var(--text-secondary)" }}>{b.label}</span>
          <span aria-hidden style={{ display: "block", height: 6, borderRadius: 3, background: "var(--bg-hover)" }}>
            <i style={{ display: "block", height: "100%", width: `${b.pct}%`, borderRadius: 3, background: b.over ? "var(--tone-amber)" : SIDE_INK.a }} />
          </span>
          <span style={{ ...T.mono, textAlign: "right", color: b.over ? "var(--tone-amber)" : "var(--text-secondary)" }}>{b.value}</span>
        </div>
      ))}
    </div>
  );
}

/** A button with no box: text only. */
function TextButton({ children, ink, onClick, name }: { children: string; ink: string; onClick: () => void; name: string }) {
  return (
    <button
      type="button"
      data-action={name}
      onClick={onClick}
      style={{ ...T.bodySm, background: "transparent", border: 0, padding: 0, cursor: "pointer", color: ink }}
    >
      {children}
    </button>
  );
}

function KillSwitch({
  view,
  onKill,
  onUnkill,
  killState,
  onKillState,
}: Pick<DeskPositionsProps, "onKill" | "onUnkill" | "killState" | "onKillState"> & { view: ComboDeskView }) {
  const killed = view.health.killed;
  let control: ReactNode;
  if (killState === "busy") {
    control = <span style={QUIET}>working</span>;
  } else if (killed) {
    control = (
      <TextButton name="unkill" ink="var(--accent)" onClick={onUnkill}>
        unkill
      </TextButton>
    );
  } else if (killState === "confirm") {
    control = (
      <span style={{ display: "inline-flex", gap: 10, alignItems: "baseline" }}>
        <span style={{ ...T.bodySm, color: "var(--text-secondary)" }}>cancel every open quote and request?</span>
        <TextButton name="kill-yes" ink="var(--tone-rose)" onClick={onKill}>
          yes
        </TextButton>
        <TextButton name="kill-no" ink="var(--text-muted)" onClick={() => onKillState("idle")}>
          no
        </TextButton>
      </span>
    );
  } else {
    control = (
      <TextButton name="kill" ink="var(--tone-rose)" onClick={() => onKillState("confirm")}>
        kill
      </TextButton>
    );
  }
  return (
    <>
      <SectionHead title="Kill switch" />
      <div style={{ display: "flex", gap: 14, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ ...T.mono, color: killed ? "var(--tone-rose)" : "var(--text-dim)" }}>{killed ? "killed" : "running"}</span>
        {killed && view.health.kill_reason ? <span style={{ ...T.bodySm, color: "var(--text-secondary)" }}>{view.health.kill_reason}</span> : null}
        {control}
      </div>
      {typeof killState === "object" ? <div style={{ ...AMBER, marginTop: 6 }}>{killState.error}</div> : null}
    </>
  );
}

export default function DeskPositions({ view, error, env, onEnv, onKill, onUnkill, killState, onKillState }: DeskPositionsProps) {
  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
      <Seg
        label="account"
        value={env}
        onChange={onEnv}
        options={[
          { key: "demo", label: "Demo" },
          { key: "live", label: "Live" },
        ]}
      />
      {view?.available ? <span style={QUIET}>{fmtTime(view.generated_at)} ET</span> : null}
    </div>
  );
  const failure = error ? <div style={{ ...AMBER, marginTop: 12 }}>{fetchErrorText(String(error))}</div> : null;

  if (!view) {
    return (
      <div>
        {header}
        {failure ?? <div style={{ ...QUIET, marginTop: 14 }}>loading the combo desk</div>}
      </div>
    );
  }
  if (!view.available) {
    return (
      <div>
        {header}
        {failure}
        <div style={{ ...QUIET, marginTop: 14 }}>{view.reason ?? `the ${env} desk is not available`}</div>
      </div>
    );
  }

  const health = healthWord(view);
  const healthInk = health.tone === "kill" ? "var(--tone-rose)" : health.tone === "warn" ? "var(--tone-amber)" : undefined;
  const pnl = settledPnl(view);
  const pnlInk = pnlTone(pnl);
  const rows = positionRows(view);
  const games = exposureBars(view.exposure.by_game, gameLabel);
  const players = exposureBars(view.exposure.by_player, exposurePlayerLabel);
  const openReqs = view.requests.filter((r) => r.status === "open");
  const labelFor = (ticker: string): string => {
    const p = view.positions.find((x) => x.market_ticker === ticker);
    return p ? (p.legs.length ? p.legs.map((l) => legLabel(l.market_ticker)).join(" + ") : legLabel(ticker)) : tickerTail(ticker);
  };
  const fills = [...view.fills].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  return (
    <div>
      {header}
      {failure}
      {view.kalshi_error ? (
        <div style={{ ...AMBER, marginTop: 12 }}>Kalshi unreachable ({view.kalshi_error}): showing the ledger only</div>
      ) : null}

      <div style={{ display: "flex", gap: 44, flexWrap: "wrap", marginTop: 18 }}>
        <Fig value={fmtUsd(view.balance.dollars)} label="balance" />
        <Fig value={riskText(view)} label="at risk" />
        <Fig value={String(openCount(view))} label="open positions" />
        <Fig value={fmtSigned(pnl)} label="settled P&L" ink={pnlInk ? INK[pnlInk] : undefined} />
        <Fig value={fmtUsd(view.pnl.fees_kalshi)} label="fees" />
        <Fig value={health.text} label="health" ink={healthInk} />
      </div>

      <SectionHead title="Positions" meta="ledger vs Kalshi" />
      {rows.length ? (
        <>
          <HeadRow cols={POS_COLS} labels={["combo", "contracts", "price", "cost", "worst case", "result", ""]} />
          {rows.map((r) => (
            <PositionLine key={r.key} r={r} />
          ))}
        </>
      ) : (
        <Empty>no positions</Empty>
      )}

      <SectionHead title="Exposure" meta="worst case against each cap" />
      {games.length || players.length ? (
        <>
          {games.length ? <ExposureBars title="by game" bars={games} /> : null}
          {players.length ? <ExposureBars title="by player" bars={players} /> : null}
        </>
      ) : (
        <Empty>nothing at risk</Empty>
      )}

      <SectionHead title="Requests" />
      {openReqs.length ? (
        <>
          <HeadRow cols={REQ_COLS} labels={["sent", "combo", "target", "contracts", ""]} />
          {openReqs.map((r) => (
            <div key={r.rfq_id} style={row(REQ_COLS)} data-request={r.rfq_id}>
              <span style={MONO}>{fmtTime(r.created_ts)}</span>
              <span style={{ ...T.body, color: "var(--text-primary)" }}>{labelFor(r.market_ticker)}</span>
              <span style={MONO}>{fmtUsd(r.target_cost)}</span>
              <span style={MONO}>{fmtContracts(r.contracts)}</span>
              <span style={QUIET}>{r.manual ? "manual" : ""}</span>
            </div>
          ))}
        </>
      ) : (
        <Empty>no open requests</Empty>
      )}

      <SectionHead title="Fills" />
      {fills.length ? (
        fills.map((f, i) => (
          <div key={`${f.ts}${f.ticker}${i}`} style={row(FILL_COLS)}>
            <span style={MONO}>{fmtTime(f.ts)}</span>
            <span style={{ ...T.mono, color: "var(--text-secondary)" }}>{labelFor(f.ticker)}</span>
            <span style={QUIET}>{f.side}</span>
            <span style={MONO}>{`${fmtContracts(f.contracts)} @ ${fmtCents(f.price)}`}</span>
            <span style={MONO}>{fmtUsd(f.cost)}</span>
            {f.in_ledger ? (
              <span style={{ ...T.bodySm, color: "var(--text-faint)" }}>{"in ledger ✓"}</span>
            ) : (
              <span style={AMBER}>not in ledger</span>
            )}
          </div>
        ))
      ) : (
        <Empty>no fills</Empty>
      )}

      <SectionHead title="Settlements" />
      {view.settlements.length ? (
        view.settlements.map((s, i) => {
          const tone = pnlTone(s.pnl);
          return (
            <div key={`${s.ticker}${i}`} style={row(SETTLE_COLS)}>
              <span style={MONO}>{fmtTime(s.settled_time)}</span>
              <span style={{ ...T.mono, color: "var(--text-secondary)" }}>{labelFor(s.ticker)}</span>
              <span style={QUIET}>{s.result}</span>
              <span style={{ ...T.mono, textAlign: "right", color: tone ? INK[tone] : "var(--text-primary)" }}>{fmtSigned(s.pnl)}</span>
            </div>
          );
        })
      ) : (
        <Empty>no settlements</Empty>
      )}

      <KillSwitch view={view} onKill={onKill} onUnkill={onUnkill} killState={killState} onKillState={onKillState} />
    </div>
  );
}
