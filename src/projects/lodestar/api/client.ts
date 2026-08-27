/**
 * Typed fetch client for the Lodestar backend (T2 FastAPI service).
 *
 * Shapes mirror `packages/backend/lodestar_backend` (PositionView, SessionState,
 * PortfolioRisk) and `packages/shared_model` (Opportunity). Money fields come
 * over the wire as JSON strings (Python Decimal) so we type them as `string`.
 */

// SWITCHBOARD COPY (platform evolution, SWIT-30). This module now runs INSIDE
// Switchboard's webview as a project surface, so there is no Vite proxy in
// front of it: it fetches the Lodestar backend DIRECTLY, and the backend sends
// CORS headers for the webview's origins (lodestar api.py create_app). Must
// match `SURFACES.lodestar.backend.url` in src/surfaces/registry.ts — the host
// probes the same origin this client talks to.
const BASE_URL = "http://127.0.0.1:8799";

/** A position plus its computed max-loss (backend PositionView). */
export interface PositionView {
  position_id: string;
  symbol: string;
  asset_class: string;
  /** "yes"/"no" for Kalshi, etc. Nullable. */
  venue_side: string | null;
  quantity: number;
  /** Decimal serialized as string. */
  avg_entry_price: string;
  stop_price: string | null;
  /** Decimal serialized as string; null when not computable. */
  max_loss: string | null;
  /** RiskKind: "bounded" | "stop_defined" | "undefined". */
  risk_kind: string;
  computable: boolean;
  source: string;
}

export interface ConcentrationFlag {
  position_id: string;
  symbol: string;
  max_loss: string;
  /** Fraction of gross_max_loss, 0..1 (Decimal as string). */
  share: string;
}

/** Aggregate portfolio risk (backend PortfolioRisk). */
export interface PortfolioRisk {
  gross_max_loss: string;
  fully_computable: boolean;
  undefined_positions: string[];
  concentration_flags: ConcentrationFlag[];
  concentration_threshold: string;
}

/** GET /portfolio response. */
export interface Portfolio {
  positions: PositionView[];
  risk: PortfolioRisk;
  /** Pre-rendered text table from the backend. */
  table: string;
}

export interface Account {
  [key: string]: unknown;
}

/** GET /session/state response (backend SessionState). */
export interface SessionState {
  session_id: string;
  generated_at: string;
  authority_stage: string;
  account: Account;
  position_count: number;
  gross_max_loss: string;
  fully_computable: boolean;
  undefined_positions: string[];
  opportunity_count: number;
  journal_entry_count: number;
}

/** Canonical Opportunity (shared_model). */
export interface Opportunity {
  opportunity_id: string;
  source: string;
  kind: string;
  instrument: Record<string, unknown> | null;
  direction: string | null;
  score: number | null;
  rationale: string | null;
  levels: Record<string, number>;
  meta: Record<string, number>;
  created_at: string | null;
}

export interface JournalEntry {
  entry_id: string;
  ts: string;
  kind: string;
  text: string | null;
  trade_ref: string | null;
  tags: string[];
  context: Record<string, unknown>;
}

export interface WriteJournalRequest {
  text: string;
  trade_ref?: string | null;
  tags?: string[];
  context?: Record<string, unknown>;
}

/** GET /metrics (backend SessionMetrics). Decimal-ish fields are strings. */
export interface SessionMetrics {
  generated_at: string;
  position_count: number;
  gross_max_loss: string;
  has_undefined_risk: boolean;
  concentration_count: number;
  realized_pnl: string;
  unrealized_pnl: string;
  net_pnl: string;
  orders_total: number;
  orders_in_window: number;
  window_seconds: number;
  journal_count: number;
}

/** A firing trigger (backend Trigger). */
export interface Trigger {
  rule_id: string;
  severity: string; // INFO | WARN | ALERT
  message: string;
  fired_at: string;
}

export interface MarketQuote {
  ticker: string;
  best_bid: number;
  best_ask: number;
  last: number;
  ts: string | null;
}

export interface SimQuoteRequest {
  ticker: string;
  best_bid: number;
  best_ask: number;
  last?: number | null;
}

export interface SimIntentRequest {
  ticker: string;
  venue_side: string; // YES | NO
  quantity: number;
  limit_price: number; // own-side premium, cents
  edge?: number | null;
}

export interface HistoricalMarket {
  ticker: string;
  label: string;
  title: string | null;
  rows: number;
  first_ts: string;
  last_ts: string;
}

export interface HistoricalSeriesPoint {
  ts: string;
  yes_bid: number | null;
  yes_ask: number | null;
  last_price: number | null;
}

/** Linked NBA game for a market (LODE-14). `linked` is false on collector gaps. */
export interface GameLink {
  linked: boolean;
  game_id: string | null;
  away_team: string | null;
  home_team: string | null;
  away_name: string | null;
  home_name: string | null;
  away_score: number | null;
  home_score: number | null;
  status: string | null;
  reason: string | null;
}

export interface HistoricalDetailPoint {
  ts: string;
  last_price: number | null;
  yes_bid: number | null;
  yes_ask: number | null;
  prob: number | null;
  open_interest: number | null;
  volume: number;
  trades: number;
  // Game state at this moment (LODE-14) — null pre-tip or when unlinked.
  away_score: number | null;
  home_score: number | null;
  clock: string | null;
  last_play: string | null;
}

export interface HistoricalDetail {
  ticker: string;
  label: string;
  n_ticks: number;
  first_ts: string | null;
  last_ts: string | null;
  total_trades: number;
  total_contracts: number;
  points: HistoricalDetailPoint[];
  game: GameLink | null;
}

// --- Trade page: index-futures candles + gamma overlay (LODE-34/36/37) ---
export interface Bar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface GammaLevels {
  symbol: string;
  date: string | null;
  underlying_price: number | null;
  zero_gamma: number | null;
  call_wall: number | null;
  put_wall: number | null;
  vol_trigger: number | null;
  max_gamma_strike: number | null;
  total_gex_net: number | null;
  source: string | null;
  available: boolean;
  reason: string | null;
}

// --- analysis tier (LODE-24): cross-market summaries ---
export interface MarketHistorySummary {
  ticker: string;
  label: string;
  n_ticks: number;
  open_prob: number | null;
  close_prob: number | null;
  min_prob: number | null;
  max_prob: number | null;
  max_swing: number | null;
  crossings_50: number;
  /** Coarse [{t, prob}] arc (~40 points) — feeds card sparklines. */
  points?: { t: string; prob: number | null }[];
  game?: GameLink | null;
}

export interface MarketOverview {
  markets: number;
  first_ts: string | null;
  last_ts: string | null;
  by_kind: Record<string, number>;
}

// --- cross-market (LODE Phase 1) ---
export interface RelatedMarket {
  ticker: string;
  label: string;
  kind: string; // KXNBAGAME | KXNBASPREAD | KXNBATOTAL
}

export interface RelatedMarkets {
  ticker: string;
  game_key: string | null;
  related: RelatedMarket[];
  reason: string | null;
}

export interface EdgeRow {
  ticker: string;
  label: string;
  side: string | null;
  kalshi_open_cents: number | null;
  book_fair_cents: number | null;
  edge_cents: number | null; // book_fair − kalshi_open (signed)
  books_count: number | null;
  captured_at: string | null;
}

export interface EdgeBoard {
  configured: boolean;
  rows: EdgeRow[];
  reason: string | null;
}

// --- NBA game context (LODE-16/18/19): math done server-side ---
export interface WinProbArc {
  open: number | null;
  close: number | null;
  min: number | null;
  max: number | null;
  max_swing: number | null;
  crossings_50: number;
}

export interface SwingMoment {
  ts: string;
  clock: string | null;
  away_score: number | null;
  home_score: number | null;
  prob: number | null;
  prob_delta: number;
  play: string | null;
}

export interface GameRun {
  kind: string; // "run" | "lead_change"
  team: string | null;
  team_name: string | null;
  points: number | null;
  period: number | null;
  start_clock: string | null;
  end_clock: string | null;
  away_score: number | null;
  home_score: number | null;
  prob_before: number | null;
  prob_after: number | null;
  prob_delta: number | null;
  ts: string | null;
}

export interface PlayRow {
  ts: string | null;
  period: number | null;
  clock: string | null;
  away_score: number | null;
  home_score: number | null;
  description: string | null;
}

export interface NbaPbp {
  ticker: string;
  source: string; // "live" | "backfill" | "none"
  plays: PlayRow[];
}

export interface QuarterLine {
  period: number;
  label: string;
  away_score: number | null;
  home_score: number | null;
  prob_end: number | null;
  prob_delta: number | null;
}

export interface BookLines {
  books: number;
  spread_home: number | null;
  total: number | null;
  implied_home_score: number | null;
  implied_away_score: number | null;
  home_fair_prob: number | null;
  away_fair_prob: number | null;
  side: string | null;
  side_fair_cents: number | null;
  kalshi_open_cents: number | null;
  edge_cents: number | null;
  source: string;
}

export interface NbaGameContext {
  ticker: string;
  label: string;
  game: GameLink | null;
  win_prob: WinProbArc | null;
  swings: SwingMoment[];
  runs: GameRun[];
  lead_changes: GameRun[];
  quarters: QuarterLine[];
  odds: Record<string, unknown> | null;
  book_lines: BookLines | null;
  note: string | null;
}

// --- tennis match context (LODE-53): math done server-side ---
export interface TennisPlayer {
  num: number; // 1 | 2
  code: string | null;
  /** tennis_player key — joins directly to the profile API (T9). */
  player_key: string | null;
  name: string | null;
  rank: number | null;
  country: string | null;
}

export interface TennisMatchInfo {
  match_id: string;
  level: string | null; // ATP | WTA | ATP Challenger | WTA Challenger
  tournament: string | null;
  round: string | null;
  surface: string | null;
  best_of: number | null;
  status: string | null;
  winner: number | null;
  winner_name: string | null;
  final_score: string | null;
  scheduled_start: string | null;
}

export interface SetLine {
  set_no: number;
  games_p1: number | null;
  games_p2: number | null;
  winner: number | null;
  winner_name: string | null;
  prob_end: number | null;
  prob_delta: number | null;
  ts: string | null;
}

export interface BreakMoment {
  kind: string; // "break"
  set_no: number | null;
  games: string | null;
  player: number | null;
  player_name: string | null;
  prob_before: number | null;
  prob_after: number | null;
  prob_delta: number | null;
  ts: string | null;
}

export interface TennisSwing {
  ts: string;
  prob: number | null;
  prob_delta: number;
  sets: string | null;
  games: string | null;
}

export interface ServeStats {
  player: number;
  name: string | null;
  aces: number | null;
  double_faults: number | null;
  first_serve_pct: number | null;
  first_serve_won: number | null;
  first_serve_total: number | null;
  bp_saved: number | null;
  bp_save_total: number | null;
  bp_converted: number | null;
  bp_convert_total: number | null;
  total_points_won: number | null;
  total_points_total: number | null;
}

export interface H2hMeeting {
  date: string | null;
  tournament: string | null;
  round: string | null;
  winner: string | null; // "p1" | "p2"
  score: string | null;
}

export interface HeadToHead {
  p1_wins: number;
  p2_wins: number;
  meetings: H2hMeeting[];
}

export interface TennisMatchContext {
  ticker: string;
  label: string;
  side: string | null;
  side_player: number | null;
  match: TennisMatchInfo | null;
  players: TennisPlayer[];
  win_prob: WinProbArc | null;
  sets: SetLine[];
  breaks: BreakMoment[];
  swings: TennisSwing[];
  stats: ServeStats[];
  h2h: HeadToHead | null;
  note: string | null;
}

// --- financial session context (LODE-58): math done server-side ---
export interface SessionSummary {
  symbol: string; // ES | NQ
  contract: string; // @ES | @NQ
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  prev_close: number | null;
  change_pct: number | null;
  gap_pct: number | null;
  range_pct: number | null;
  has_options: boolean;
  has_flow: boolean;
}

export interface LevelLine {
  key: string; // zero_gamma | call_wall | put_wall | vol_trigger
  label: string;
  price: number;
}

export interface LevelCross {
  key: string;
  label: string;
  price: number;
  direction: string; // "up" | "down"
  ts: string;
  bar_close: number;
}

export interface SessionSwing {
  ts: string;
  open: number;
  close: number;
  move: number;
  move_pct: number | null;
}

export interface GexSummary {
  open_gex: number | null;
  close_gex: number | null;
  min_gex: number | null;
  max_gex: number | null;
  sign_flips: number;
  first_flip_ts: string | null;
}

export interface HiroSummary {
  cum_end: number | null;
  cum_min: number | null;
  cum_max: number | null;
  burst_ts: string | null;
  burst_value: number | null;
}

export interface FlowSummary {
  nope_last: number | null;
  nope_min: number | null;
  nope_max: number | null;
  net_call_premium: number | null;
  net_put_premium: number | null;
  call_volume: number | null;
  put_volume: number | null;
}

export interface GexPoint {
  ts: string;
  price: number | null;
  gamma_oi: number | null;
}

export interface HiroPoint {
  ts: string;
  hiro: number | null;
  cumulative: number | null;
}

export interface RegimeSpan {
  ts: string;
  timeframe: string | null;
  regime: string | null;
  confidence: number | null;
}

export interface MarketSessionContext {
  symbol: string;
  contract: string;
  etf: string | null;
  date: string | null;
  day: SessionSummary | null;
  levels: LevelLine[];
  levels_source: string | null;
  crossings: LevelCross[];
  swings: SessionSwing[];
  gex: GexSummary | null;
  hiro: HiroSummary | null;
  flow: FlowSummary | null;
  gex_timeline: GexPoint[];
  hiro_timeline: HiroPoint[];
  regimes: RegimeSpan[];
  note: string | null;
}

export interface LevelHistoryPoint {
  date: string;
  zero_gamma: number | null;
  call_wall: number | null;
  put_wall: number | null;
  vol_trigger: number | null;
  total_gex_net: number | null;
  spot: number | null;
  source: string | null;
}

export interface ThreadMessage {
  role: string; // "you" | "agent"
  text: string;
  ts: string;
}

export interface Thread {
  thread_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  session_id: string | null;
  messages: ThreadMessage[];
  // Research grounding (LODE Phase 1).
  reference_ticker: string | null;
  hypothesis: string | null;
  labels: string[];
  // Case membership (research-streams T2): null = free-floating ("unfiled").
  case_id: string | null;
  archived: boolean;
}

export interface CreateThreadRequest {
  title?: string;
  messages?: { role: string; text: string }[];
  session_id?: string | null;
  reference_ticker?: string | null;
  hypothesis?: string | null;
  labels?: string[];
}

/** PATCH /threads/{id}: omit a field to leave it unchanged; labels:[] clears. */
export interface UpdateThreadMetaRequest {
  title?: string;
  reference_ticker?: string | null;
  hypothesis?: string | null;
  labels?: string[];
  archived?: boolean;
}

// --- research cases (research-streams T3): the durable unit of investigation ---

export type CaseStream = "trading" | "tennis" | "mlb" | "generic";
export type CaseDisposition =
  | "open" | "supported" | "refuted" | "watch" | "parked" | "traded" | "live";

/** What a case is about — a typed union discriminated by `kind`. */
export interface CaseSubject {
  kind: "market" | "player" | "situation" | "pattern";
  ticker?: string | null;        // kind=market
  player_key?: string | null;    // kind=player
  params?: Record<string, unknown> | null;  // kind=situation
  descriptor?: Record<string, unknown> | null; // kind=pattern (confirmed vision read)
  image_path?: string | null;    // kind=pattern (original screenshot)
  label?: string | null;         // display name (player name, "big inning", …)
}

/** Immutable evidence snapshot. Provenance is always present and typed. */
export interface CasePin {
  pin_id: string;
  kind: "analysis" | "profile" | "chart" | "case_set";
  title: string;
  payload: Record<string, unknown>;
  provenance: {
    tool: string;
    params: Record<string, unknown>;
    data_window: string;
    sample_size: number;
    computed_at: string;
    [k: string]: unknown;
  };
  ts: string;
}

export interface CaseNote {
  note_id: string;
  text: string;
  ts: string;
}

/** One block of a case's synthesis (its report) — promotion ladder, top rung.
 * A `claim` carries prose; an `evidence` block references a promoted pin. */
/** The ambient agent's transient chart, rendered in the open case's Study view.
 *  One global slot; the Study view clears it when the case changes. */
export interface ExploreChart {
  widgets: { type: string; params: Record<string, unknown>; title?: string }[];
  note: string | null;
}

/** One month of a player's results, for the arc line. */
export interface TennisArcPoint {
  period: string; // 'YYYY-MM'
  matches: number;
  wins: number;
}

/** A player's form/trajectory over the 2-year history. */
export interface TennisArc {
  player: string;
  player_id: string;
  series: TennisArcPoint[];
  arc_class: "rising" | "fading" | "peak" | "steady" | "unrated";
  n: number;
  periods: number;
  earlier_wr: number | null;
  recent_wr: number | null;
  delta: number | null;
}

/** Player typeahead row over the match history (keyed by stable Sackmann id). */
export interface TennisHistPlayer {
  player_id: string;
  name: string;
  matches: number;
}

/** A user-defined tennis cohort (custom segment) — a named set of players. */
export interface TennisCohort {
  cohort_id: string;
  name: string;
  player_keys: string[];
  created_at: string;
}

/** Ground-truth data behind a screenshot window (the exact bars + summary). */
export interface PriceWindow {
  symbol: string;
  timeframe: string;
  requested: { start: string; end: string };
  summary: {
    n_bars: number;
    start: string | null;
    end: string | null;
    open: number | null;
    close: number | null;
    high: number | null;
    low: number | null;
    volume: number;
    move_pct: number | null;
    range_pct: number | null;
  };
  bars: Bar[];
}

export interface LegConfig {
  close: number | null;
  rsi: number | null;
  macd_hist: number | null;
  ema20_dist_pct: number | null;
  vwap_dist_pct: number | null;
  atr_pct: number | null;
  vol_z: number | null;
  session_low_dist_pct: number | null;
  session_range_pct: number | null;
  tod: string | null;
  date: string | null;
}

export interface InstanceLeg {
  name: string;
  start: number;
  end: number;
  decision: number;
  decision_ts: string;
  config: LegConfig;
}

/** Edge-engine Stage 1: a grounded instance decomposed into legs with per-leg leading config. */
export interface InstanceAnalysis {
  symbol: string;
  timeframe: string;
  requested: { start: string; end: string };
  n_bars: number;
  instance_start: number;
  legs: InstanceLeg[];
  note: string;
  bars: Bar[];
}

export interface HypCondition {
  feature: string;
  op: string;
  value: number;
  value2?: number | null;
  unit?: string;
  label: string;
}
export interface HypTarget {
  direction: string;
  horizon_bars: number;
  tp_pct?: number | null;
  tp_atr?: number | null;
  stop_atr?: number | null;
  stop_label?: string | null;
}
export interface Hypothesis {
  id: string;
  title: string;
  leg: string;
  symbol: string;
  timeframe: string;
  trigger: string;
  rationale?: string;
  conditions: HypCondition[];
  target: HypTarget;
  origin: string;
  from_note: boolean;
  edited_by_human: boolean;
  status: string;
}
export interface HypLevels {
  swing_low: number;
  bounce_est: number;
  retest_low: number;
  retest_high: number;
  invalidation: number;
}
/** Edge-engine Stage 2: a menu of hypotheses proposed from an instance + note. */
export interface HypothesesProposal {
  symbol: string;
  timeframe: string;
  note?: string | null;
  window?: { start: string; end: string } | null;
  levels?: HypLevels | null;
  hypotheses: Hypothesis[];
}

export interface BacktestSetup {
  ts: string;
  close: number;
  fwd_ret_pct: number | null;
  fwd_up_pct?: number | null;
  fwd_dn_pct?: number | null;
  atr_pct?: number | null;
  rsi: number | null;
  session_low_dist: number | null;
  vwap_dist: number | null;
  run: number;
  outcome?: "win" | "stop" | "open" | null;
}
/** Edge-engine Stage 3: a hypothesis scored against the bar_features store. */
export interface BacktestResult {
  n: number;
  hit_rate: number | null;
  avg_fwd: number | null;
  median_fwd: number | null;
  avg_max_up: number | null;
  avg_max_dn: number | null;
  horizon_bars: number;
  direction: string;
  hit_threshold?: number;
  applied: string[];
  skipped: string[];
  symbol: string;
  timeframe: string;
  note?: string | null;
  metric?: string;
  win_rate?: number | null;
  stop_rate?: number | null;
  open_rate?: number | null;
  rr?: number | null;
  expectancy_r?: number | null;
  tp_atr?: number | null;
  stop_atr?: number | null;
  setups: BacktestSetup[];
  error?: string;
}

/** Result of the tennis exploration pivot — group-by-dimension × measure. */
export interface TennisAggregate {
  group_by: string;
  measure: string;
  min_matches: number;
  groups: { key: string; value: number | null; n: number; players: number }[];
}

export interface SynthesisBlock {
  block_id: string;
  kind: "claim" | "evidence";
  text: string | null;
  pin_id: string | null;
  ts: string;
}

export interface Case {
  case_id: string;
  title: string;
  stream: CaseStream;
  subject: CaseSubject;
  hypothesis: string | null;
  disposition: CaseDisposition;
  archived: boolean;
  watch: Record<string, unknown> | null; // watch-condition spec (nudge engine, later)
  /** Agent-composed widget layout — the case's home surface (set_case_workbench). */
  workbench?: { type: string; params: Record<string, unknown>; title?: string }[] | null;
  labels: string[];
  thread_ids: string[];
  pins: CasePin[];
  notes: CaseNote[];
  archived_ids: string[];
  synthesis: SynthesisBlock[];
  created_at: string;
  updated_at: string;
}

export interface CreateCaseRequest {
  title?: string;
  stream?: CaseStream;
  subject: CaseSubject;
  hypothesis?: string | null;
  labels?: string[];
}

/** PATCH /cases/{id}: OMIT a field to leave it unchanged; explicit null CLEARS
 * hypothesis/watch; labels:[] clears labels; a 400 applies nothing. */
export interface PatchCaseRequest {
  title?: string;
  hypothesis?: string | null;
  labels?: string[];
  subject?: CaseSubject;
  disposition?: CaseDisposition;
  archived?: boolean;
  watch?: Record<string, unknown> | null;
}

export interface CasePinRequest {
  kind: CasePin["kind"];
  title: string;
  payload?: Record<string, unknown>;
  provenance: CasePin["provenance"];
}

// --- research artifacts (research-streams T9): profiles + anomaly boards ---

/** One cohort row of a tennis player profile. Rates are None-able; sample
 * counts always ride beside them (matches, set1_matches, service_games, ...). */
// ── MLB pitcher explorer (deep-dive by season/team/pitcher/matchup + K-prop lines) ──
export interface MlbPitcherRow {
  pitcher_id: number;
  pitcher: string;
  hand: string;
  team: string;
  starts: number;
  K_total: number;
  avg_K: number;
  krate: number;
  avg_ip: number;
  best_K: number;
  has_lines: boolean;
}

export interface MlbPitcherLine {
  line: number;              // N+ strikeouts threshold
  implied: number;           // opening two-sided mid, 0-1
  yes_ask: number;           // first executable ask (cents)
  spread: number;            // cents
  settled_yes: boolean;      // true K >= line
}

export interface MlbGameLogEntry {
  date: string;
  season: number;
  opp: string;
  is_home: boolean;
  ip: string;                // "6.1"
  bf: number;
  K: number;
  pitches: number;
  krate: number;
  lines?: MlbPitcherLine[];  // present only for priced starts
}

export interface MlbPitcherDetail {
  pitcher_id: number;
  pitcher: string;
  hand: string;
  team: string;
  seasons: number[];
  summary: {
    starts: number; K_total: number; avg_K: number; krate: number;
    avg_ip: number; avg_bf: number; avg_pitches: number; best_K: number;
    home: { starts: number; avg_K: number | null };
    away: { starts: number; avg_K: number | null };
  };
  k_series: { x: string; K: number; krate: number; roll5_K: number }[];
  game_log: MlbGameLogEntry[];
  opponent_splits: { opp: string; starts: number; avg_K: number; K_total: number }[];
  month_trend: { month: string; starts: number; avg_K: number }[];
  lines_summary: {
    games_priced: number; thresholds_priced: number;
    yes_hit_rate: number | null; note: string;
  };
}

export interface TennisProfileRow {
  player_key: string;
  player_name: string;
  level: string;              // 'all' | atp | wta | atp_challenger | wta_challenger
  surface: string;            // 'all' | Hard | Clay | Grass (capitalized source values)
  matches: number;
  wins: number;
  win_rate: number | null;
  set1_matches: number;
  close_rate_after_set1: number | null;
  deciders: number;
  decider_win_rate: number | null;
  service_games: number;
  hold_rate: number | null;
  return_games: number;
  break_rate: number | null;
  avg_breaks_per_match: number | null;
  swing_matches: number;
  avg_market_swing: number | null;
  aces_per_match: number | null;
  dfs_per_match: number | null;
  first_serve_pct: number | null;
  bp_save_rate: number | null;
  bp_convert_rate: number | null;
  serve_pts_won_rate: number | null;
  return_pts_won_rate: number | null;
  peer_pct_hold: number | null;
  peer_pct_break: number | null;
  peer_pct_close: number | null;
  peer_pct_decider: number | null;
}

/** One row of the flow-vs-state anomaly board. score_ratio is the
 * liquidity-calibrated cross-match comparable; raw score kept for
 * transparency. Ranking only — never a conclusion. */
export interface AnomalyMatch {
  match_id: string;
  /** A real market ticker for the match — click-through never depends on the
   * capped market list. */
  ticker: string | null;
  level: string | null;
  player1_name: string | null;
  player2_name: string | null;
  winner: number | null;
  score: number;
  n_trades: number;
  n_sized_trades: number;
  n_moments: number;
  n_flagged: number;
  flag_rate: number;
  expected_max_z: number;
  score_ratio: number;
  n_state_rows: number;
  first_trade: string | null;
  last_trade: string | null;
}

/** A decomposed anomalous moment: what the flow did vs what the state was. */
export interface AnomalyMoment {
  match_id: string;
  ts: string;
  ticker: string;
  price: number | null;
  count: number | null;
  backs_player: number;
  size_z: number;
  tilt: number;
  disagreement: number;
  side_inferred: boolean;
  score: number;
  sets_p1: number | null;
  sets_p2: number | null;
  games_p1: number | null;
  games_p2: number | null;
}

// --- MLB situation study (research-streams T11) ---
export interface SituationParams {
  run_threshold: number;
  min_scoreless_before: number;
  inning_min: number;
  inning_max: number; // 9 = extras excluded
  batting_side: "any" | "home" | "away";
  include_market_overlay: boolean;
}

export interface SituationStudy {
  params: SituationParams;
  games: number;
  transitions: number;
  events: number;
  response_rate: number | null;
  response_se: number | null;
  avg_response_runs: number | null;
  response_dist: Record<string, number>;
  baseline_n: number;
  baseline_rate: number | null;
  baseline_se: number | null;
  baseline_avg_runs: number | null;
  games_excluded_overcount: number;
  games_undercount: number;
  runs_capture_pct: number | null;
  overlay_events: number;
  overlay_sampled: boolean;
  avg_abs_move_cents: number | null;
  avg_move_vs_big_team_cents: number | null;
  data_window: string;
  note: string | null;
}

export interface PatternMatch {
  symbol: string;
  timeframe: string;
  start_ts: string;
  end_ts: string;
  distance: number;
  net_move: number;
  volatility: number;
  path_range: number;
  fwd_ret_pct: number | null;
  fwd_max_up_pct: number | null;
  fwd_max_dn_pct: number | null;
}

export interface PatternSearchResult {
  matches: PatternMatch[];
  what_happened_next?: { n: number; continued_up_rate: number | null; avg_fwd_ret_pct: number | null };
  prefiltered_from?: number;
  index_total?: number;
  data_window?: string | null;
  reason?: string;
}

export interface ResearchStatus {
  available: boolean;
  datasets: { dataset: string; built_at: string; data_window: string; rows: number }[];
}

/** POST /sim/intent response (backend ExecutionResult). Order kept loose. */
export interface ExecutionResult {
  order: {
    order_id: string;
    status: string;
    filled_quantity: number;
    avg_fill_price: string | null;
    fills: { fill_id: string; price: string; quantity: number }[];
  };
  filled: boolean;
  reject_reason: string | null;
}

export async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    // Include the backend's `detail` so callers can distinguish failure modes
    // (e.g. "historical DB unavailable" vs a genuine 404) instead of guessing.
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* non-JSON body — status line is all we have */
    }
    throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${res.statusText}${detail ? ` · ${detail}` : ""}`);
  }
  return (await res.json()) as T;
}

export type KnowledgeType = "idea" | "report" | "research" | "link";
export interface KnowledgeDoc {
  id: string;
  title: string;
  type: KnowledgeType;
  tags: string[];
  case_id: string | null;
  url: string | null;
  body: string;
  created: string;
  updated: string;
}
export type KnowledgeListItem = Omit<KnowledgeDoc, "body"> & {
  excerpt: string;
  sections: string[];
  n_attachments: number;
  n_comments: number;
};
export interface KnowledgeCreate {
  title: string;
  body?: string;
  type?: KnowledgeType;
  tags?: string[];
  case_id?: string | null;
  url?: string | null;
}
export type KnowledgePatch = Partial<KnowledgeCreate>;
export interface KnowledgeComment {
  id: string;
  author: string; // "you" | "agent"
  text: string;
  ts: string;
}
export interface KnowledgeFile {
  name: string;
  size: number;
  path: string; // on-disk path (the agent reads it directly)
}
export type KnowledgeDocFull = KnowledgeDoc & { comments: KnowledgeComment[]; attachments: KnowledgeFile[] };

// --- Desk dashboards (desk-dashboards epic, phase 1) ---

export interface StreakRow {
  team: string;
  streak: string; // "W7" / "L4"
  wins: number;
  losses: number;
}
// phase 3 — the StatsAPI lanes (collect_mlb_statsapi); empty until it has run
export interface InjuryRow {
  player: string;
  team: string;
  move: "placed" | "activated" | "transferred" | string;
  il_kind: string | null; // "10-day" / "60-day" / "full-season"
  date: string | null;
  detail: string; // the API sentence — carries the body part when public
}
export interface TiredArm {
  player: string;
  appearances: number;
  pitches: number;
  last: string | null;
  why: string[]; // which published rule fired
}
export interface BullpenRow {
  team: string;
  flagged: number;
  arms: TiredArm[];
}
export interface BatterFormRow {
  player: string;
  avg: number;
  slg: number;
  at_bats: number;
  home_runs: number;
  rbi: number;
}
export interface ProbableRow {
  home: string;
  away: string;
  home_pitcher: string | null;
  away_pitcher: string | null;
  game_time_utc: string | null;
  state: string | null;
}
export interface ScratchRow {
  player: string;
  team: string;
  recent_games: number;
  of_games: number;
  /** set only when an IL move explains the absence; null = genuinely unexplained */
  reason: string | null;
}
export interface SportsDashboard {
  as_of: string;
  sport: string;
  /** the windows the payload was computed over — subtitles read these */
  windows: { injury_days: number; form_days: number; bullpen_days: number; scratch_days: number };
  streaks: { hot: StreakRow[]; cold: StreakRow[] };
  standings: { division: string; teams: { team: string; wins: number; losses: number }[] }[];
  upcoming: { home: string; away: string; tip_off_utc: string }[];
  hit_rates: { label: string; n: number; hit_rate: number }[];
  injuries: InjuryRow[];
  bullpens: BullpenRow[];
  trending_bats: { hot: BatterFormRow[]; cold: BatterFormRow[] };
  probables: ProbableRow[];
  scratches: ScratchRow[];
  notes: string[];
}

// --- Screen annotations (annotate mode pins; consumed by an outside Claude session) ---

export type AnnotationStatus = "open" | "resolved";
export interface Annotation {
  id: string;
  page: string; // route path, e.g. "/markets"
  text: string;
  status: AnnotationStatus;
  x_frac: number;
  y_frac: number;
  viewport_w: number;
  viewport_h: number;
  scroll_x: number;
  scroll_y: number;
  target: string;
  target_text: string;
  screenshot: string | null;
  resolution_note: string;
  created: string;
  updated: string;
}
export interface AnnotationCreate {
  page: string;
  text: string;
  x_frac?: number;
  y_frac?: number;
  viewport_w?: number;
  viewport_h?: number;
  scroll_x?: number;
  scroll_y?: number;
  target?: string;
  target_text?: string;
  screenshot_b64?: string | null;
}

// --- Trading self-audit + exit sandbox (NinjaTrader decode) ---

/** A tweakable exit policy. All legs optional; omit (undefined) to disable. */
/** One decoded flat-to-flat trade + its look-ahead-free entry context (LODE-60). */
export interface TradeRow {
  trade_id: number;
  date: string;
  start: string; // Pacific wall-clock, as exported
  start_utc: string; // naive-UTC ISO — chart alignment
  end_utc: string;
  symbol: string;
  direction: string;
  peak_contracts: number;
  hold_min: number;
  entry_vwap: number;
  exit_vwap: number;
  pnl_points: number;
  pnl_usd: number;
  mom30_pts: number | null;
  trend_align: string | null; // with | against | flat
  pos4h: number | null;
  sess_pos: string | null; // near_low | mid | near_high
  atr5_entry: number | null;
  vol_regime: string | null; // low | normal | high
  tod: string; // pre | open | morning | noon | afternoon | late
  trade_no: number;
  seq_bucket: string; // 1 | 2-3 | 4-6 | 7+
  after: string; // first | win | loss
  day_state: string; // flat | green | red
  setup: string;
  mom10_pts: number | null;
  temp: number | null; // |mom10| / atr5 — tape temperature at entry
  temp_bucket: string | null; // cold | warm | hot
  act10: string | null; // fade | join | flat (vs the last 10 minutes)
  archetype: string | null; // quiet counter | knife catch | … | chase
  ses_hr: number; // hours into the session (since the day's first entry)
  edge_book: string; // "edge" (the proven pockets, first 3h) | "cloud"
}

export interface ContextBucket {
  bucket: string;
  n: number;
  net_usd: number;
  win_rate: number;
  avg_usd: number;
  worst_usd: number;
}
export type ContextTables = Record<string, ContextBucket[]>;

export interface TradeSlice {
  filters: Record<string, string>;
  n: number;
  net_usd?: number;
  win_rate?: number;
  avg_usd?: number;
  payoff?: number | null;
  monthly_net?: Record<string, number>;
  worst?: Record<string, unknown>[];
  best?: Record<string, unknown>[];
}

/** Today's live tape + tilt-guardrail state (from the NinjaScript AddOn stream). */
export interface LiveNudge {
  id: number;
  ts: string;
  level: string; // info | warn
  kind: string; // revenge | cooldown | session_clock | trade_count | after_win
  text: string;
}
export interface LiveTradeState {
  date: string | null;
  session_start: string | null;
  trade_no: number;
  trades_closed: number;
  day_pts: number;
  day_usd: number;
  position: { symbol: string; direction: string; qty: number; avg_price: number; since: string | null } | null;
  cooldown_until: string | null;
  episodes: { start: string; end: string; symbol: string; direction: string; pnl_points: number; pnl_usd: number; peak_contracts: number }[];
  nudges: LiveNudge[];
}

export interface ExitPolicy {
  name?: string;
  stop_pts?: number;
  stop_atr?: number;
  trail_pts?: number;
  trail_atr?: number;
  tp_pts?: number;
  tp_atr?: number;
  be_after_pts?: number;
  time_min?: number;
  horizon_min?: number;
}

export interface ExitSimTrade {
  date: string;
  symbol: string;
  direction: string;
  pnl_usd: number;
  sim_pnl_usd: number;
  sim_reason: string;
  hold_min: number;
}

export interface ExitSimResult {
  policy: string;
  n: number;
  actual_net_usd: number;
  sim_net_usd: number;
  delta_usd: number;
  sim_win_rate: number | null;
  exit_reasons: Record<string, number>;
  per_trade: ExitSimTrade[];
}

export interface TradeAnalysis {
  headline: {
    n_trades: number;
    total_pnl_usd: number;
    win_rate: number | null;
    payoff_ratio: number | null;
    profit_factor: number | null;
    largest_loss_usd: number | null;
  };
  excursion?: {
    runners_to_losers: { n: number; pct_of_losers: number | null; usd_lost: number };
    profit_given_back: { n: number; pct_of_winners: number | null; left_on_table_usd: number };
    alignment: { covered: number; uncovered: number; median_align_residual_pts: number | null };
  };
  has_bars?: boolean;
}

export const api = {
  getTradesAnalysis: (): Promise<TradeAnalysis> => getJson<TradeAnalysis>("/trades/analysis"),
  getTradeContextEpisodes: (limit = 2000): Promise<{ episodes: TradeRow[]; has_data: boolean }> =>
    getJson(`/trades/context-episodes?limit=${limit}`),
  getTradeContextTables: (): Promise<ContextTables> => getJson<ContextTables>("/trades/context-tables"),
  queryTrades: (filters: Record<string, string>, limit = 25): Promise<TradeSlice> =>
    getJson<TradeSlice>("/trades/query", { method: "POST", body: JSON.stringify({ filters, limit }) }),
  getLiveTradeState: (): Promise<LiveTradeState> => getJson<LiveTradeState>("/trades/live/state"),
  runExitSim: (policy: ExitPolicy): Promise<ExitSimResult> =>
    getJson<ExitSimResult>("/trades/exit-sim", { method: "POST", body: JSON.stringify(policy) }),
  getExitMenu: (): Promise<{ policies: ExitSimResult[] }> =>
    getJson<{ policies: ExitSimResult[] }>("/trades/exit-menu"),
  getSessionState: (): Promise<SessionState> => getJson<SessionState>("/session/state"),
  listKnowledge: (filters?: { type?: KnowledgeType; tag?: string; case_id?: string; q?: string }): Promise<KnowledgeListItem[]> => {
    const qs = new URLSearchParams(
      Object.entries(filters ?? {}).filter(([, v]) => v != null) as [string, string][],
    ).toString();
    return getJson<KnowledgeListItem[]>(`/knowledge${qs ? `?${qs}` : ""}`);
  },
  getKnowledge: (id: string): Promise<KnowledgeDocFull> => getJson<KnowledgeDocFull>(`/knowledge/${id}`),
  createKnowledge: (req: KnowledgeCreate): Promise<KnowledgeDoc> =>
    getJson<KnowledgeDoc>("/knowledge", { method: "POST", body: JSON.stringify(req) }),
  updateKnowledge: (id: string, req: KnowledgePatch): Promise<KnowledgeDoc> =>
    getJson<KnowledgeDoc>(`/knowledge/${id}`, { method: "PATCH", body: JSON.stringify(req) }),
  deleteKnowledge: (id: string): Promise<{ ok: boolean; id: string }> =>
    getJson(`/knowledge/${id}`, { method: "DELETE" }),
  addKnowledgeComment: (id: string, text: string): Promise<KnowledgeComment> =>
    getJson<KnowledgeComment>(`/knowledge/${id}/comments`, { method: "POST", body: JSON.stringify({ text }) }),
  deleteKnowledgeComment: (id: string, commentId: string): Promise<{ ok: boolean }> =>
    getJson(`/knowledge/${id}/comments/${commentId}`, { method: "DELETE" }),
  addKnowledgeFile: (id: string, filename: string, contentBase64: string): Promise<KnowledgeFile> =>
    getJson<KnowledgeFile>(`/knowledge/${id}/files`, { method: "POST", body: JSON.stringify({ filename, content_base64: contentBase64 }) }),
  deleteKnowledgeFile: (id: string, filename: string): Promise<{ ok: boolean }> =>
    getJson(`/knowledge/${id}/files/${encodeURIComponent(filename)}`, { method: "DELETE" }),
  /** Download URL for an attachment (served by the backend through the /api proxy). */
  knowledgeFileUrl: (id: string, filename: string): string => `${BASE_URL}/knowledge/${id}/files/${encodeURIComponent(filename)}`,

  getSportsDashboard: (refresh = false): Promise<SportsDashboard> =>
    getJson<SportsDashboard>(`/dashboard/sports${refresh ? "?refresh=true" : ""}`),

  listAnnotations: (filters?: { page?: string; status?: AnnotationStatus }): Promise<Annotation[]> => {
    const params = new URLSearchParams();
    Object.entries(filters ?? {}).forEach(([k, v]) => v != null && params.set(k, v));
    const qs = params.toString();
    return getJson<Annotation[]>(`/annotations${qs ? `?${qs}` : ""}`);
  },
  createAnnotation: (req: AnnotationCreate): Promise<Annotation> =>
    getJson<Annotation>("/annotations", { method: "POST", body: JSON.stringify(req) }),
  patchAnnotation: (id: string, req: { text?: string; status?: AnnotationStatus; resolution_note?: string }): Promise<Annotation> =>
    getJson<Annotation>(`/annotations/${id}`, { method: "PATCH", body: JSON.stringify(req) }),
  deleteAnnotation: (id: string): Promise<{ ok: boolean; id: string }> =>
    getJson(`/annotations/${id}`, { method: "DELETE" }),
  getPortfolio: (): Promise<Portfolio> => getJson<Portfolio>("/portfolio"),
  getPositions: (): Promise<PositionView[]> => getJson<PositionView[]>("/positions"),
  getOpportunities: (): Promise<Opportunity[]> => getJson<Opportunity[]>("/opportunities"),
  getMetrics: (): Promise<SessionMetrics> => getJson<SessionMetrics>("/metrics"),
  getTriggers: (): Promise<Trigger[]> => getJson<Trigger[]>("/triggers"),
  getJournal: (): Promise<JournalEntry[]> => getJson<JournalEntry[]>("/journal"),
  writeJournal: (req: WriteJournalRequest): Promise<JournalEntry> =>
    getJson<JournalEntry>("/journal", {
      method: "POST",
      body: JSON.stringify(req),
    }),

  // --- Kalshi cockpit (human, sim) ---
  setQuote: (req: SimQuoteRequest): Promise<MarketQuote> =>
    getJson<MarketQuote>("/sim/quote", { method: "POST", body: JSON.stringify(req) }),
  getQuote: (ticker: string): Promise<MarketQuote> =>
    getJson<MarketQuote>(`/sim/quote/${ticker}`),
  submitIntent: (req: SimIntentRequest): Promise<ExecutionResult> =>
    getJson<ExecutionResult>("/sim/intent", { method: "POST", body: JSON.stringify(req) }),
  closePosition: (positionId: string): Promise<{ position_id: string; realized_pnl: string }> =>
    getJson(`/sim/positions/${positionId}/close`, { method: "POST" }),

  // --- historical Kalshi data ---
  getHistoricalMarkets: (prefixes?: string[]): Promise<HistoricalMarket[]> =>
    getJson<HistoricalMarket[]>(
      `/historical/markets${prefixes?.length ? `?prefix=${prefixes.join(",")}` : ""}`,
    ),
  getHistoricalSeries: (ticker: string): Promise<HistoricalSeriesPoint[]> =>
    getJson<HistoricalSeriesPoint[]>(`/historical/markets/${encodeURIComponent(ticker)}/series`),
  getHistoricalDetail: (ticker: string, points?: number): Promise<HistoricalDetail> =>
    getJson<HistoricalDetail>(
      `/historical/markets/${encodeURIComponent(ticker)}/detail${points ? `?points=${points}` : ""}`,
    ),
  getNbaContext: (ticker: string): Promise<NbaGameContext> =>
    getJson<NbaGameContext>(`/nba/context/${encodeURIComponent(ticker)}`),
  getNbaPbp: (ticker: string): Promise<NbaPbp> =>
    getJson<NbaPbp>(`/nba/pbp/${encodeURIComponent(ticker)}`),
  getTennisContext: (ticker: string): Promise<TennisMatchContext> =>
    getJson<TennisMatchContext>(`/tennis/context/${encodeURIComponent(ticker)}`),
  getMovers: (limit = 10, prefix?: string): Promise<MarketHistorySummary[]> =>
    getJson<MarketHistorySummary[]>(
      `/historical/movers?limit=${limit}${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ""}`,
    ),
  getMarketHistorySummary: (ticker: string): Promise<MarketHistorySummary> =>
    getJson<MarketHistorySummary>(`/historical/markets/${encodeURIComponent(ticker)}/summary`),
  getMarketOverview: (): Promise<MarketOverview> =>
    getJson<MarketOverview>("/historical/overview"),
  getRelatedMarkets: (ticker: string): Promise<RelatedMarkets> =>
    getJson<RelatedMarkets>(`/historical/related/${encodeURIComponent(ticker)}`),
  getEdges: (limit = 15, prefix?: string): Promise<EdgeBoard> =>
    getJson<EdgeBoard>(
      `/historical/edges?limit=${limit}${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ""}`,
    ),
  getBars: (symbol: string, timeframe = "1d", limit = 180): Promise<Bar[]> =>
    getJson<Bar[]>(`/bars/${symbol}?timeframe=${timeframe}&limit=${limit}`),
  getGammaFuture: (symbol: string): Promise<GammaLevels> =>
    getJson<GammaLevels>(`/gamma/future/${symbol}`),

  // --- financial sessions (LODE-58) ---
  getMarketSessions: (symbol = "ES", limit = 30, order = "recent"): Promise<SessionSummary[]> =>
    getJson<SessionSummary[]>(`/markets/sessions?symbol=${symbol}&limit=${limit}&order=${order}`),
  /** Ground a screenshot/exact moment in the real data — bars + summary for a window. */
  getPriceWindow: (symbol: string, start: string, end: string, timeframe = "5m"): Promise<PriceWindow> =>
    getJson<PriceWindow>(
      `/markets/window?symbol=${symbol}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(
        end,
      )}&timeframe=${timeframe}`,
    ),
  getInstanceAnalysis: (symbol: string, start: string, end: string, timeframe = "5m"): Promise<InstanceAnalysis> =>
    getJson<InstanceAnalysis>(
      `/markets/instance-analysis?symbol=${symbol}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(
        end,
      )}&timeframe=${timeframe}`,
    ),
  proposeHypotheses: (symbol: string, start: string, end: string, timeframe = "5m", note?: string): Promise<HypothesesProposal> =>
    getJson<HypothesesProposal>(
      `/research/hypotheses/propose?symbol=${symbol}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&timeframe=${timeframe}${
        note ? `&note=${encodeURIComponent(note)}` : ""
      }`,
    ),
  backtestHypothesis: (
    hypothesis: Record<string, unknown>,
    symbol: string,
    timeframe = "5m",
    since?: string,
    until?: string,
  ): Promise<BacktestResult> =>
    getJson<BacktestResult>("/research/hypotheses/backtest", {
      method: "POST",
      body: JSON.stringify({ hypothesis, symbol, timeframe, since, until }),
    }),
  getSessionContext: (symbol: string, date: string): Promise<MarketSessionContext> =>
    getJson<MarketSessionContext>(`/markets/session/${symbol}/${date}`),
  getSessionBars: (symbol: string, date: string, timeframe = "5m"): Promise<Bar[]> =>
    getJson<Bar[]>(`/markets/session/${symbol}/${date}/bars?timeframe=${timeframe}`),
  getGammaHistory: (symbol: string, days = 30): Promise<LevelHistoryPoint[]> =>
    getJson<LevelHistoryPoint[]>(`/gamma/${symbol}/history?days=${days}`),

  // --- agent threads (Playground) ---
  getThreads: (includeArchived = false): Promise<Thread[]> =>
    getJson<Thread[]>(`/threads${includeArchived ? "?include_archived=true" : ""}`),
  getThread: (id: string): Promise<Thread> => getJson<Thread>(`/threads/${id}`),
  createThread: (req: CreateThreadRequest): Promise<Thread> =>
    getJson<Thread>("/threads", { method: "POST", body: JSON.stringify(req) }),
  appendThread: (id: string, role: string, text: string): Promise<Thread> =>
    getJson<Thread>(`/threads/${id}/messages`, { method: "POST", body: JSON.stringify({ role, text }) }),
  setThreadSession: (id: string, sessionId: string): Promise<Thread> =>
    getJson<Thread>(`/threads/${id}/session`, { method: "POST", body: JSON.stringify({ session_id: sessionId }) }),
  updateThreadMeta: (id: string, req: UpdateThreadMetaRequest): Promise<Thread> =>
    getJson<Thread>(`/threads/${id}`, { method: "PATCH", body: JSON.stringify(req) }),
  // --- cases ---
  createCase: (req: CreateCaseRequest): Promise<Case> =>
    getJson<Case>("/cases", { method: "POST", body: JSON.stringify(req) }),
  listCases: (filters?: {
    stream?: CaseStream;
    disposition?: CaseDisposition;
    label?: string;
    include_archived?: boolean;
  }): Promise<Case[]> => {
    const qs = new URLSearchParams(
      Object.entries(filters ?? {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
    ).toString();
    return getJson<Case[]>(`/cases${qs ? `?${qs}` : ""}`);
  },
  getCase: (id: string): Promise<Case> => getJson<Case>(`/cases/${id}`),
  patchCase: (id: string, req: PatchCaseRequest): Promise<Case> =>
    getJson<Case>(`/cases/${id}`, { method: "PATCH", body: JSON.stringify(req) }),
  pinToCase: (id: string, req: CasePinRequest): Promise<Case> =>
    getJson<Case>(`/cases/${id}/pins`, { method: "POST", body: JSON.stringify(req) }),
  addCaseNote: (id: string, text: string): Promise<Case> =>
    getJson<Case>(`/cases/${id}/notes`, { method: "POST", body: JSON.stringify({ text }) }),
  deleteCasePin: (id: string, pinId: string): Promise<Case> =>
    getJson<Case>(`/cases/${id}/pins/${pinId}`, { method: "DELETE" }),
  deleteCaseNote: (id: string, noteId: string): Promise<Case> =>
    getJson<Case>(`/cases/${id}/notes/${noteId}`, { method: "DELETE" }),
  /** Archive/unarchive an evidence pin or note (curate in place; stays retrievable). */
  archiveCaseItem: (id: string, itemId: string, archived = true): Promise<Case> =>
    getJson<Case>(`/cases/${id}/archive`, {
      method: "POST",
      body: JSON.stringify({ item_id: itemId, archived }),
    }),
  /** Attach an existing thread (threadId), or create a new one inside the case
   * (omit threadId, optional title). Re-parenting detaches from the old case. */
  attachCaseThread: (id: string, opts: { threadId?: string; title?: string }): Promise<Case> =>
    getJson<Case>(`/cases/${id}/threads`, {
      method: "POST",
      body: JSON.stringify({ thread_id: opts.threadId ?? null, title: opts.title ?? null }),
    }),
  detachCaseThread: (id: string, threadId: string): Promise<Case> =>
    getJson<Case>(`/cases/${id}/threads/${threadId}`, { method: "DELETE" }),
  deleteCase: (id: string): Promise<{ deleted: string; threads_deleted: number }> =>
    getJson(`/cases/${id}`, { method: "DELETE" }),
  deleteThread: (id: string): Promise<{ deleted: string }> =>
    getJson(`/threads/${id}`, { method: "DELETE" }),
  aggregateTennis: (group_by: string, measure: string, min_matches = 3): Promise<TennisAggregate> =>
    getJson<TennisAggregate>(
      `/research/tennis/aggregate?group_by=${encodeURIComponent(group_by)}&measure=${encodeURIComponent(
        measure,
      )}&min_matches=${min_matches}`,
    ),
  listCohorts: (): Promise<TennisCohort[]> => getJson<TennisCohort[]>("/research/tennis/cohorts"),
  createCohort: (name: string, player_keys: string[]): Promise<TennisCohort> =>
    getJson<TennisCohort>("/research/tennis/cohorts", {
      method: "POST",
      body: JSON.stringify({ name, player_keys }),
    }),
  deleteCohort: (id: string): Promise<{ cohort_id: string }> =>
    getJson(`/research/tennis/cohorts/${id}`, { method: "DELETE" }),
  searchTennisPlayers: (q: string, limit = 20): Promise<TennisHistPlayer[]> =>
    getJson<TennisHistPlayer[]>(`/research/tennis/players?q=${encodeURIComponent(q)}&limit=${limit}`),
  getPlayerArc: (playerId: string, name?: string): Promise<TennisArc> =>
    getJson<TennisArc>(
      `/research/tennis/arc?player_id=${encodeURIComponent(playerId)}` +
        (name ? `&player=${encodeURIComponent(name)}` : ""),
    ),
  getExploreChart: (): Promise<ExploreChart> => getJson<ExploreChart>("/explore/chart"),
  clearExploreChart: (): Promise<{ cleared: boolean }> =>
    getJson("/explore/chart", { method: "DELETE" }),
  addSynthesisBlock: (
    id: string,
    req: { kind: "claim" | "evidence"; text?: string | null; pin_id?: string | null },
  ): Promise<Case> =>
    getJson<Case>(`/cases/${id}/synthesis`, { method: "POST", body: JSON.stringify(req) }),
  updateSynthesisBlock: (id: string, blockId: string, text: string): Promise<Case> =>
    getJson<Case>(`/cases/${id}/synthesis/${blockId}`, {
      method: "PATCH",
      body: JSON.stringify({ text }),
    }),
  deleteSynthesisBlock: (id: string, blockId: string): Promise<Case> =>
    getJson<Case>(`/cases/${id}/synthesis/${blockId}`, { method: "DELETE" }),
  // --- research artifacts ---
  getResearchStatus: (): Promise<ResearchStatus> =>
    getJson<ResearchStatus>("/research/status"),
  listTennisProfiles: (opts?: {
    level?: string; surface?: string; sort?: string; limit?: number;
  }): Promise<TennisProfileRow[]> => {
    const qs = new URLSearchParams(
      Object.entries(opts ?? {})
        .filter(([, v]) => v != null)
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    return getJson<TennisProfileRow[]>(`/research/tennis/profiles${qs ? `?${qs}` : ""}`);
  },
  getTennisProfile: (playerKey: string): Promise<TennisProfileRow[]> =>
    getJson<TennisProfileRow[]>(`/research/tennis/profiles/${encodeURIComponent(playerKey)}`),
  mlbPitcherFacets: (): Promise<{ seasons: number[]; teams: string[] }> =>
    getJson<{ seasons: number[]; teams: string[] }>("/research/mlb/pitchers/facets"),
  listMlbPitchers: (opts?: {
    season?: number; team?: string; q?: string; sort?: string; limit?: number;
  }): Promise<MlbPitcherRow[]> => {
    const qs = new URLSearchParams(
      Object.entries(opts ?? {})
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    return getJson<MlbPitcherRow[]>(`/research/mlb/pitchers${qs ? `?${qs}` : ""}`);
  },
  getMlbPitcher: (pitcherId: number, season?: number): Promise<MlbPitcherDetail> =>
    getJson<MlbPitcherDetail>(
      `/research/mlb/pitchers/${pitcherId}${season ? `?season=${season}` : ""}`,
    ),
  topAnomalies: (limit = 20, level?: string): Promise<AnomalyMatch[]> =>
    getJson<AnomalyMatch[]>(
      `/research/tennis/anomalies?limit=${limit}${level ? `&level=${encodeURIComponent(level)}` : ""}`,
    ),
  patternSearch: (req: {
    shape: number[]; symbol?: string; timeframe?: string; limit?: number; since?: string; until?: string;
  }): Promise<PatternSearchResult> =>
    getJson<PatternSearchResult>("/research/pattern/search", {
      method: "POST",
      body: JSON.stringify(req),
    }),
  runSituationStudy: (params: SituationParams): Promise<SituationStudy> =>
    getJson<SituationStudy>("/research/mlb/situation", {
      method: "POST",
      body: JSON.stringify(params),
    }),
  runSituationStudyHistory: (params: SituationParams, seasons: number[]): Promise<SituationStudy> =>
    getJson<SituationStudy>(`/research/mlb/situation/history?seasons=${seasons.join(",")}`, {
      method: "POST",
      body: JSON.stringify(params),
    }),
  getMatchAnomaly: (matchId: string): Promise<{ match: AnomalyMatch | null; moments: AnomalyMoment[] }> =>
    getJson(`/research/tennis/anomalies/${encodeURIComponent(matchId)}`),

  // --- Sextant data health (the P1 review surface over the L1 foundation) ---
  sextantQuality: (): Promise<SextantQuality> => getJson<SextantQuality>("/sextant/quality"),
  sextantCoverage: (contract: string): Promise<SextantCoverage> =>
    getJson<SextantCoverage>(`/sextant/contract/${encodeURIComponent(contract)}/coverage`),
  sextantDay: (contract: string, date: string): Promise<SextantDay> =>
    getJson<SextantDay>(`/sextant/contract/${encodeURIComponent(contract)}/day/${date}`),

  // --- Sextant answer-key hand-audit (the P5 gate: Eric judges labeled segments) ---
  auditOverview: (): Promise<AuditOverview> => getJson<AuditOverview>("/sextant/audit/overview"),
  auditSample: (instrument: string, label: string): Promise<AuditSample> =>
    getJson<AuditSample>(`/sextant/audit/sample/${instrument}/${label}`),
  auditSegment: (instrument: string, segmentId: number): Promise<AuditSegment> =>
    getJson<AuditSegment>(`/sextant/audit/segment/${instrument}/${segmentId}`),
  auditVerdict: (req: {
    instrument: string; segment_id: number; label: string; verdict: string; note?: string;
    correction?: string;
  }): Promise<{ ok: boolean }> =>
    getJson<{ ok: boolean }>("/sextant/audit/verdict", { method: "POST", body: JSON.stringify(req) }),
};

export interface AuditLabelRow {
  instrument: string;
  label: string;
  uniform: number;
  leaf: number;
  judged: number;
  agree: number;
  agree_pct: number | null;
}

export interface AuditOverview {
  available: boolean;
  reason?: string;
  l4_version?: string;
  l2_version?: string;
  sample_target?: number;
  labels: AuditLabelRow[];
}

export interface AuditSampleItem {
  segment_id: number;
  t0: string;
  t1: string;
  n_bars: number;
  purity: string;
  depth: number;
  er: number;
  d_points: number;
  rho1: number;
  dead_frac: number;
  session_date: string;
  dow: string;
  bucket: string;
  near_roll: boolean;
  gap_day: boolean;
  news_adjacent: boolean;
  verdict: string | null;
}

export interface AuditSample {
  instrument: string;
  label: string;
  items: AuditSampleItem[];
  l4_version: string;
}

export interface AuditSegment {
  instrument: string;
  segment_id: number;
  label: string;
  purity: string;
  depth: number;
  t0: string;
  t1: string;
  n_bars: number;
  facts: Record<string, number | null>;
  tags: {
    session_date: string; dow: string; bucket: string; near_roll: boolean;
    gap_day: boolean; news_adjacent: boolean; trend_day: boolean | null;
    prev_label: string | null; next_label: string | null;
  };
  bars: {
    ts: string; open: number; high: number; low: number; close: number;
    volume: number; in_segment: boolean; in_rth: boolean; suspect: boolean;
  }[];
}

/** One contract's quality-gate row from the foundation's BUILD.json. */
export interface SextantGates {
  contract: string;
  symbol: string;
  rows_1m: number;
  rows_5m: number;
  ohlc_violations: number;
  ts_monotonic: boolean;
  duplicate_bars: number;
  parity_5m: boolean;
  suspect_frac: number | null;
  outside_session_frac: number | null;
  hard_pass: boolean;
  l0_sha256: string | null;
}

export interface SextantQuality {
  available: boolean;
  reason: string | null;
  contracts: SextantGates[];
  meta: {
    built_utc?: string;
    code_sha?: string;
    manifest_hash?: string;
    l1_dir?: string;
    calendar_available?: boolean;
  } | null;
  summary?: { n_contracts: number; n_pass: number; total_rows_1m: number };
}

export interface SextantCoverageDay {
  date: string;
  rth_bars: number;
  expected: number;
  coverage_pct: number | null;
  total_bars: number;
  session_kind: string;
  suspect: number;
  outside: number;
}

export interface SextantCoverage {
  contract: string;
  symbol: string;
  days: SextantCoverageDay[];
}

export interface SextantBar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  suspect: boolean;
  source_grade: string;
  in_rth: boolean;
}

export interface SextantDay {
  contract: string;
  symbol: string;
  date: string;
  session: {
    session_kind: string;
    is_half_day: boolean;
    rth_open_utc: string;
    rth_close_utc: string;
    expected_rth_minutes: number;
  } | null;
  n_bars: number;
  n_suspect: number;
  bars: SextantBar[];
}

export { BASE_URL };
