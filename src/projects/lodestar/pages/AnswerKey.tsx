/**
 * Answer Key audit — the P5 hand-audit gate (SWIT-12, regime-truth spec §1.7.1).
 *
 * Eric judges labeled segments: 50 deterministic samples per (instrument, label), each drawn
 * as candles with the segment window shaded, and a fast verdict — Agree (A) / Disagree (D) /
 * Unsure (U) — that auto-advances to the next unjudged segment. The gate needs >=90% agree
 * per label. Verdicts append to hand_audit.jsonl NEXT TO the L4 version they judge; a
 * rebuilt key starts a fresh audit by construction.
 *
 * Built for judging speed: keyboard-first, no scrolling between segments. Hand-rolled SVG.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSurfaceKeydown } from "../../../surfaces/page-api";
import {
  api,
  type AuditLabelRow,
  type AuditOverview,
  type AuditSample,
  type AuditSegment,
} from "../api/client";
import { etTime, ptDate, ptTime } from "../lib/time";

const OK = "#4ea96a";
const WARN = "#d9a441";
const FAIL = "#e0645b";
const SEL = "#8ab4f8";

const LABEL_TONE: Record<string, string> = {
  TREND_UP: OK,
  TREND_DOWN: FAIL,
  RANGE: WARN,
  DEAD: "#6b7280",
  MIXED: "#a78bfa",
};

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border border-line bg-surface/40 px-3 py-1.5">
      <div className="font-mono text-[9px] uppercase tracking-wider text-dim">{label}</div>
      <div className="font-mono text-sm" style={tone ? { color: tone } : undefined}>{value}</div>
    </div>
  );
}

/** The audit chart: context bars dimmed, segment window shaded + railed. */
function SegmentChart({ seg }: { seg: AuditSegment }) {
  const W = 1180;
  const H = 340;
  const PAD_L = 52;
  const PAD_B = 24;
  const bars = seg.bars;
  if (!bars.length) return <div className="text-xs text-dim">no bars.</div>;

  const lo = Math.min(...bars.map((b) => b.low));
  const hi = Math.max(...bars.map((b) => b.high));
  const span = hi - lo || 1;
  const bw = (W - PAD_L - 8) / bars.length;
  const y = (p: number) => 8 + (1 - (p - lo) / span) * (H - PAD_B - 12);
  const xOf = (i: number) => PAD_L + i * bw + bw / 2;
  const segFrom = bars.findIndex((b) => b.in_segment);
  const segTo = bars.length - 1 - [...bars].reverse().findIndex((b) => b.in_segment);
  const tone = LABEL_TONE[seg.label] ?? SEL;

  // The reference the labeler judged against: the segment's own mean close, banded by the
  // typical deviation (MAD). MEAN_REVERT's claim is "price oscillates through this line".
  const inSeg = bars.filter((b) => b.in_segment).map((b) => b.close);
  const segMean = inSeg.reduce((a, b) => a + b, 0) / Math.max(inSeg.length, 1);
  const devs = inSeg.map((v) => Math.abs(v - segMean)).sort((a, b) => a - b);
  // p90 envelope — the labeler's amplitude gate. (±MAD read as "too tight" to Eric: it
  // counts time near the mean, not the swings a trader would actually fade.)
  const mad = devs.length ? devs[Math.floor(devs.length * 0.9)] : 0;
  const showRef = seg.label === "RANGE" || seg.label === "DEAD";

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="select-none">
      {segFrom >= 0 && (
        <>
          <rect x={PAD_L + segFrom * bw} y={4} width={Math.max((segTo - segFrom + 1) * bw, 1)}
                height={H - PAD_B - 4} fill={tone} opacity={0.08} />
          <line x1={PAD_L + segFrom * bw} x2={PAD_L + segFrom * bw} y1={4} y2={H - PAD_B}
                stroke={tone} strokeWidth={1.2} />
          <line x1={PAD_L + (segTo + 1) * bw} x2={PAD_L + (segTo + 1) * bw} y1={4} y2={H - PAD_B}
                stroke={tone} strokeWidth={1.2} />
        </>
      )}
      {showRef && segFrom >= 0 && (
        <g>
          <rect
            x={PAD_L + segFrom * bw}
            y={y(segMean + mad)}
            width={Math.max((segTo - segFrom + 1) * bw, 1)}
            height={Math.max(y(segMean - mad) - y(segMean + mad), 1)}
            fill={SEL}
            opacity={0.07}
          />
          <line
            x1={PAD_L + segFrom * bw}
            x2={PAD_L + (segTo + 1) * bw}
            y1={y(segMean)}
            y2={y(segMean)}
            stroke={SEL}
            strokeWidth={1}
            strokeDasharray="5 4"
            opacity={0.8}
          />
          <text
            x={PAD_L + (segTo + 1) * bw + 4}
            y={y(segMean) + 3}
            fill={SEL}
            fontFamily="monospace"
            fontSize={9}
            opacity={0.9}
          >
            mean ± range
          </text>
        </g>
      )}
      {[0, 0.25, 0.5, 0.75, 1].map((f) => {
        const p = lo + f * span;
        return (
          <g key={f}>
            <line x1={PAD_L} x2={W - 4} y1={y(p)} y2={y(p)} stroke="#2a2f3a" strokeWidth={1} opacity={0.5} />
            <text x={2} y={y(p) + 3} fill="#6b7280" fontFamily="monospace" fontSize={9}>{p.toFixed(2)}</text>
          </g>
        );
      })}
      {bars.map((b, i) => {
        const x = xOf(i);
        const up = b.close >= b.open;
        const color = b.suspect ? FAIL : up ? OK : "#e0645b";
        return (
          <g key={b.ts} opacity={b.in_segment ? 1 : 0.35}>
            <line x1={x} x2={x} y1={y(b.high)} y2={y(b.low)} stroke={color} strokeWidth={Math.min(bw * 0.5, 1)} />
            <line x1={x} x2={x} y1={y(Math.max(b.open, b.close))} y2={y(Math.min(b.open, b.close))}
                  stroke={color} strokeWidth={Math.max(Math.min(bw * 0.8, 3), 0.7)} />
            <title>{`${ptTime(b.ts)} PT / ${etTime(b.ts)} ET  O ${b.open} H ${b.high} L ${b.low} C ${b.close}`}</title>
          </g>
        );
      })}
      <text x={PAD_L} y={H - 8} fill="#6b7280" fontFamily="monospace" fontSize={9}>
        {ptDate(bars[0].ts)} {ptTime(bars[0].ts)} PT
      </text>
      <text x={W - 4} y={H - 8} textAnchor="end" fill="#6b7280" fontFamily="monospace" fontSize={9}>
        {ptTime(bars[bars.length - 1].ts)} PT
      </text>
    </svg>
  );
}

export default function AnswerKey() {
  const [overview, setOverview] = useState<AuditOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [instrument, setInstrument] = useState("ES");
  const [label, setLabel] = useState<string | null>(null);
  const [sample, setSample] = useState<AuditSample | null>(null);
  const [idx, setIdx] = useState(0);
  const [seg, setSeg] = useState<AuditSegment | null>(null);
  const [busy, setBusy] = useState(false);
  // D opens the correction row: "what would you call it instead?"
  const [correcting, setCorrecting] = useState(false);

  const refreshOverview = useCallback(() => {
    api.auditOverview().then(setOverview).catch((e) => setErr(String(e)));
  }, []);
  useEffect(refreshOverview, [refreshOverview]);

  useEffect(() => {
    if (!label) return;
    setSample(null);
    setSeg(null);
    api.auditSample(instrument, label).then((s) => {
      setSample(s);
      const first = s.items.findIndex((i) => !i.verdict);
      setIdx(first >= 0 ? first : 0);
    }).catch((e) => setErr(String(e)));
  }, [instrument, label]);

  const item = sample?.items[idx];
  useEffect(() => {
    if (!sample || !item) return;
    setSeg(null);
    api.auditSegment(sample.instrument, item.segment_id).then(setSeg).catch((e) => setErr(String(e)));
  }, [sample, item]);

  const judge = useCallback(
    (verdict: "agree" | "disagree" | "unsure", correction?: string) => {
      if (!sample || !item || busy) return;
      setBusy(true);
      setCorrecting(false);
      api
        .auditVerdict({
          instrument: sample.instrument, segment_id: item.segment_id,
          label: sample.label, verdict, correction,
        })
        .then(() => {
          item.verdict = verdict; // local echo
          const next = sample.items.findIndex((i, j) => j > idx && !i.verdict);
          const wrap = sample.items.findIndex((i) => !i.verdict);
          setIdx(next >= 0 ? next : wrap >= 0 ? wrap : idx);
          refreshOverview();
        })
        .catch((e) => setErr(String(e)))
        .finally(() => setBusy(false));
    },
    [sample, item, idx, busy, refreshOverview],
  );

  const CORRECTIONS = useMemo(
    () => ["TREND_UP", "TREND_DOWN", "RANGE", "DEAD", "MIXED", "NEEDS_SPLIT"]
      .filter((c) => c !== sample?.label),
    [sample?.label],
  );

  // keyboard-first: A agree, D -> correction row (1-6 pick, Enter plain-D, Esc cancel), U unsure
  // SWITCHBOARD: surface-scoped shortcuts (page-api), never window-scoped.
  useSurfaceKeydown((e) => {
      if (!sample) return;
      const k = e.key.toLowerCase();
      if (correcting) {
        const n = parseInt(e.key, 10);
        if (n >= 1 && n <= CORRECTIONS.length) judge("disagree", CORRECTIONS[n - 1]);
        else if (e.key === "Enter") judge("disagree");
        else if (e.key === "Escape") setCorrecting(false);
        return;
      }
      if (k === "a") judge("agree");
      else if (k === "d") setCorrecting(true);
      else if (k === "u") judge("unsure");
      else if (e.key === "ArrowRight") setIdx((i) => Math.min(i + 1, sample.items.length - 1));
      else if (e.key === "ArrowLeft") setIdx((i) => Math.max(i - 1, 0));
  });

  useEffect(() => setCorrecting(false), [idx, label, instrument]);

  const rows = useMemo(
    () => (overview?.labels ?? []).filter((r) => r.instrument === instrument),
    [overview, instrument],
  );
  const judgedCount = sample ? sample.items.filter((i) => i.verdict).length : 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 font-mono text-sm uppercase tracking-wider">Answer key · hand audit</h1>
        {["ES", "NQ"].map((s) => (
          <button key={s} type="button" onClick={() => { setInstrument(s); setLabel(null); }}
                  className={`rounded border border-line px-2 py-0.5 font-mono text-[10px] uppercase ${instrument === s ? "text-accent" : "text-dim hover:text-text"}`}>
            {s}
          </button>
        ))}
        {overview?.available && (
          <>
            <Tile label="key version" value={overview.l4_version ?? "—"} />
            <Tile label="target" value={`≥90% agree · ${overview.sample_target}/label`} />
          </>
        )}
        <div className="ml-auto max-w-md text-right font-mono text-[10px] leading-tight text-dim">
          judge with A (agree) · D (disagree) · U (unsure) — auto-advances · ←/→ browse
        </div>
      </div>

      {err && <div className="rounded border border-line bg-surface/40 p-2 text-xs" style={{ color: FAIL }}>{err}</div>}
      {overview && !overview.available && (
        <div className="rounded border border-line bg-surface/40 p-2 text-xs text-dim">
          {overview.reason} — run the Orbit-side L4 build.
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        {/* label board */}
        <div className="flex w-[330px] shrink-0 flex-col gap-1 rounded-lg border border-line bg-surface/20 p-2">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-dim">
            labels — the premise is "obvious in hindsight"; judge exactly that
          </div>
          {rows.map((r: AuditLabelRow) => (
            <button key={r.label} type="button" onClick={() => setLabel(r.label)}
                    className={`rounded border px-2 py-1.5 text-left ${label === r.label ? "border-accent/60 bg-surface" : "border-line hover:bg-surface/60"}`}>
              <div className="flex items-baseline justify-between font-mono text-[11px]">
                <span style={{ color: LABEL_TONE[r.label] }}>{r.label}</span>
                <span className="text-dim">{r.uniform} uniform · {r.leaf} leaf</span>
              </div>
              <div className="mt-0.5 flex items-baseline justify-between font-mono text-[10px] text-dim">
                <span>{r.judged} judged</span>
                {r.agree_pct != null && (
                  <span style={{ color: r.agree_pct >= 90 ? OK : r.agree_pct >= 75 ? WARN : FAIL }}>
                    {r.agree_pct}% agree
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>

        {/* judging surface */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          {!label && (
            <div className="flex h-full items-center justify-center rounded-lg border border-line bg-surface/20 p-6 text-center">
              <p className="max-w-md text-xs leading-relaxed text-dim">
                Pick a label. You'll see its 50 sampled segments one at a time — shaded window on
                the chart, context dimmed either side. The only question: <em>is this obviously
                what you'd call {`{label}`}?</em> A to agree, D to disagree, U to skip. The gate
                needs ≥90% agree per label; disagreements are the sweep's food, not failures.
              </p>
            </div>
          )}
          {label && sample && item && (
            <div className="rounded-lg border border-line bg-surface/20 p-3">
              <div className="mb-1.5 flex flex-wrap items-baseline gap-3 font-mono text-[11px]">
                <span style={{ color: LABEL_TONE[sample.label] }} className="text-sm">{sample.label}</span>
                <span className="text-dim">#{idx + 1}/{sample.items.length} · {judgedCount} judged</span>
                <span>{item.session_date} {item.dow} · {item.bucket} · {item.n_bars} bars · {item.purity}</span>
                <span className="text-dim">
                  ER {item.er} · D {item.d_points}pts · ρ1 {item.rho1} · dead {item.dead_frac}
                </span>
                {seg?.facts?.cross_per_100 != null && (
                  <span className="text-dim">
                    cross {Number(seg.facts.cross_per_100).toFixed(1)}/100
                    {seg.facts.amp_bar_ranges != null && ` · amp ${Number(seg.facts.amp_bar_ranges).toFixed(1)}×bar`}
                    {seg.facts.drift_mads != null && ` · drift ${Number(seg.facts.drift_mads).toFixed(1)}×mad`}
                  </span>
                )}
                {item.near_roll && <span style={{ color: WARN }}>near-roll</span>}
                {item.news_adjacent && <span style={{ color: WARN }}>news±15m</span>}
                {item.gap_day && <span className="text-dim">gap-day</span>}
                {item.verdict && <span style={{ color: SEL }}>judged: {item.verdict}</span>}
              </div>
              {seg ? <SegmentChart seg={seg} /> : <div className="py-10 text-center text-xs text-dim">loading…</div>}
              <div className="mt-2 flex items-center gap-2">
                {correcting ? (
                  <>
                    <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: FAIL }}>
                      what would you call it?
                    </span>
                    {CORRECTIONS.map((c, i) => (
                      <button key={c} type="button" onClick={() => judge("disagree", c)}
                              className="rounded border border-line px-2 py-1 font-mono text-[10px] hover:bg-surface"
                              style={{ color: c === "NEEDS_SPLIT" ? WARN : LABEL_TONE[c] }}>
                        {i + 1}·{c === "NEEDS_SPLIT" ? "needs split" : c.toLowerCase()}
                      </button>
                    ))}
                    <button type="button" onClick={() => judge("disagree")}
                            className="rounded border border-line px-2 py-1 font-mono text-[10px] text-dim hover:bg-surface">
                      ⏎·just wrong
                    </button>
                    <button type="button" onClick={() => setCorrecting(false)}
                            className="rounded border border-line px-2 py-1 font-mono text-[10px] text-dim hover:bg-surface">
                      esc
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => judge("agree")}
                            className="rounded border border-line px-3 py-1 font-mono text-xs hover:bg-surface" style={{ color: OK }}>
                      A · agree
                    </button>
                    <button type="button" onClick={() => setCorrecting(true)}
                            className="rounded border border-line px-3 py-1 font-mono text-xs hover:bg-surface" style={{ color: FAIL }}>
                      D · disagree…
                    </button>
                    <button type="button" onClick={() => judge("unsure")}
                            className="rounded border border-line px-3 py-1 font-mono text-xs text-dim hover:bg-surface">
                      U · unsure
                    </button>
                  </>
                )}
                {seg && (
                  <span className="ml-auto font-mono text-[10px] text-dim">
                    prev {seg.tags.prev_label ?? "—"} · next {seg.tags.next_label ?? "—"} ·
                    {" "}{seg.tags.trend_day ? "trend day" : "range day"}
                  </span>
                )}
              </div>
            </div>
          )}
          {label && sample && (
            <div className="flex flex-wrap gap-[3px] rounded-lg border border-line bg-surface/20 p-2">
              {sample.items.map((it, i) => (
                <button key={it.segment_id} type="button" onClick={() => setIdx(i)}
                        title={`${it.session_date} · ${it.verdict ?? "unjudged"}`}
                        className="h-4 w-4 rounded-sm border"
                        style={{
                          borderColor: i === idx ? SEL : "#2a2f3a",
                          background: it.verdict === "agree" ? OK : it.verdict === "disagree" ? FAIL
                            : it.verdict === "unsure" ? "#6b7280" : "transparent",
                          opacity: it.verdict ? 0.9 : 0.6,
                        }} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
