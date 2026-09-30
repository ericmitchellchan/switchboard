import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  LAUNCH_LOOKBACK_ROWS,
  RESUME_HEAL_BOUNCE_GAP_MS,
  RESUME_HEAL_MAX_BOUNCES,
  RESUME_HEAL_MIN_GAP_MS,
  RESUME_HEAL_SETTLE_MS,
  RESUME_HEAL_WINDOW_MS,
  claudeDrewAfterLaunch,
  midTurnOnScreen,
  planResumeHeal,
  resumeHealOpen,
  type ResumeHealInput,
} from "./resumeHeal";
import {
  __resetResumeHealForTests,
  configureResumeHealIO,
  forgetResumeHeal,
  markSessionResumed,
  noteResumeHealOutput,
  type ResumeHealTerminal,
} from "./resumeHealRunner";

const T0 = 1_000_000;

function input(over: Partial<ResumeHealInput> = {}): ResumeHealInput {
  return {
    firstOutputAt: T0,
    now: T0 + 5_000,
    bounces: 0,
    lastBounceAt: 0,
    drawn: true,
    midTurn: false,
    ...over,
  };
}

/** A terminal whose buffer is `lines`, cursor on the last one. */
function screen(lines: string[], rows = 40, cols = 100): ResumeHealTerminal {
  const baseY = Math.max(0, lines.length - rows);
  return {
    cols,
    rows,
    buffer: {
      active: {
        baseY,
        cursorY: lines.length - 1 - baseY,
        getLine: (y: number) =>
          y >= 0 && y < lines.length ? { translateToString: () => lines[y] } : undefined,
      },
    },
  };
}

const LAUNCH = "PS C:\\Users\\ericm\\projects\\lodestar> claude --resume 4e7e51f4 --mcp-config x.json";
const RULE = "─".repeat(98);
const IDLE_FRAME = [" Claude Code v2.1.278", "● Where things stand: the lane is waiting on your review.", RULE, "❯ ", RULE];

describe("planResumeHeal", () => {
  it("bounces at a quiet settle inside the window once claude has drawn", () => {
    expect(planResumeHeal(input())).toEqual({ bounce: true });
  });

  it("waits for the first output", () => {
    expect(planResumeHeal(input({ firstOutputAt: 0 }))).toEqual({ bounce: false, why: "no-output" });
  });

  it("stops once the window after the first output has closed", () => {
    expect(planResumeHeal(input({ now: T0 + RESUME_HEAL_WINDOW_MS }))).toEqual({ bounce: true });
    expect(planResumeHeal(input({ now: T0 + RESUME_HEAL_WINDOW_MS + 1 }))).toEqual({
      bounce: false,
      why: "window-closed",
    });
  });

  it("caps the bounces", () => {
    expect(planResumeHeal(input({ bounces: RESUME_HEAL_MAX_BOUNCES - 1 }))).toEqual({ bounce: true });
    expect(planResumeHeal(input({ bounces: RESUME_HEAL_MAX_BOUNCES }))).toEqual({
      bounce: false,
      why: "cap",
    });
  });

  it("refuses the settle of its own bounce's repaint", () => {
    const lastBounceAt = T0 + 3_000;
    expect(
      planResumeHeal(input({ bounces: 1, lastBounceAt, now: lastBounceAt + RESUME_HEAL_MIN_GAP_MS - 1 }))
    ).toEqual({ bounce: false, why: "too-soon" });
    expect(
      planResumeHeal(input({ bounces: 1, lastBounceAt, now: lastBounceAt + RESUME_HEAL_MIN_GAP_MS }))
    ).toEqual({ bounce: true });
  });

  it("does not spend a bounce on the shell echoing the launch line", () => {
    expect(planResumeHeal(input({ drawn: false }))).toEqual({ bounce: false, why: "booting" });
  });

  it("never bounces while the agent owns the frame", () => {
    expect(planResumeHeal(input({ midTurn: true }))).toEqual({ bounce: false, why: "mid-turn" });
  });
});

describe("resumeHealOpen", () => {
  it("is open before any output and inside the window", () => {
    expect(resumeHealOpen({ firstOutputAt: 0, now: T0, bounces: 0 })).toBe(true);
    expect(resumeHealOpen({ firstOutputAt: T0, now: T0 + RESUME_HEAL_WINDOW_MS, bounces: 0 })).toBe(true);
  });

  it("closes with the window or the cap", () => {
    expect(resumeHealOpen({ firstOutputAt: T0, now: T0 + RESUME_HEAL_WINDOW_MS + 1, bounces: 0 })).toBe(false);
    expect(resumeHealOpen({ firstOutputAt: T0, now: T0 + 1, bounces: RESUME_HEAL_MAX_BOUNCES })).toBe(false);
  });
});

describe("what the screen says", () => {
  it("claude has not drawn while the launch line is the last thing on screen", () => {
    expect(claudeDrewAfterLaunch(screen(["PS C:\\x> ", LAUNCH, "--append-system-prompt wrapped tail"]))).toBe(false);
  });

  it("a restored frame ABOVE the launch line is history, not claude", () => {
    expect(claudeDrewAfterLaunch(screen([...IDLE_FRAME, "", LAUNCH]))).toBe(false);
  });

  it("claude drew once its banner or an input-box rule follows the launch line", () => {
    expect(claudeDrewAfterLaunch(screen([LAUNCH, " Claude Code v2.1.278"]))).toBe(true);
    expect(claudeDrewAfterLaunch(screen([LAUNCH, "● replayed text", RULE, "❯ ", RULE]))).toBe(true);
  });

  it("a launch line scrolled out of the lookback means claude drew", () => {
    const replay = Array.from({ length: LAUNCH_LOOKBACK_ROWS + 60 }, (_, i) => `● replayed line ${i}`);
    expect(claudeDrewAfterLaunch(screen([LAUNCH, ...replay]))).toBe(true);
  });

  it("reads a working footer or a permission gate as mid-turn, an idle frame as not", () => {
    expect(midTurnOnScreen(screen([...IDLE_FRAME]))).toBe(false);
    expect(midTurnOnScreen(screen(["✻ Pondering… (12s · esc to interrupt)", RULE, "❯ ", RULE]))).toBe(true);
    expect(midTurnOnScreen(screen(["Do you want to proceed?", "❯ 1. Yes", "  2. No"]))).toBe(true);
  });
});

describe("resumeHealRunner", () => {
  let lines: string[];
  let resizes: Array<[number, number]>;
  let failRestoreOnce: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    __resetResumeHealForTests();
    lines = [LAUNCH];
    resizes = [];
    failRestoreOnce = false;
    configureResumeHealIO({
      getTerminal: () => screen(lines),
      resizePty: async (_id, cols, rows) => {
        if (failRestoreOnce && rows === 40) {
          failRestoreOnce = false;
          throw new Error("pty busy");
        }
        resizes.push([cols, rows]);
      },
    });
  });

  afterEach(() => {
    __resetResumeHealForTests();
    vi.useRealTimers();
  });

  const settleNow = () => vi.advanceTimersByTimeAsync(RESUME_HEAL_SETTLE_MS);
  const bounceDone = () => vi.advanceTimersByTimeAsync(RESUME_HEAL_BOUNCE_GAP_MS + 10);

  it("does nothing for a session that was never marked resumed", async () => {
    lines = [LAUNCH, ...IDLE_FRAME];
    noteResumeHealOutput("s1");
    await settleNow();
    expect(resizes).toEqual([]);
  });

  it("skips the launch-line echo, then bounces rows-1 → rows once claude is at rest", async () => {
    markSessionResumed("s1");
    noteResumeHealOutput("s1"); // the shell echoes the launch line
    await settleNow();
    expect(resizes).toEqual([]); // booting — no bounce spent

    lines = [LAUNCH, ...IDLE_FRAME]; // claude replayed and sits at its prompt
    noteResumeHealOutput("s1");
    await settleNow();
    await bounceDone();
    expect(resizes).toEqual([
      [100, 39],
      [100, 40],
    ]);
  });

  it("waits out a working frame and heals at the settle after the turn ends", async () => {
    markSessionResumed("s1");
    lines = [LAUNCH, " Claude Code v2.1.278", "✻ Pondering… (3s · esc to interrupt)"];
    noteResumeHealOutput("s1");
    await settleNow();
    expect(resizes).toEqual([]);

    lines = [LAUNCH, ...IDLE_FRAME];
    noteResumeHealOutput("s1");
    await settleNow();
    await bounceDone();
    expect(resizes).toHaveLength(2);
  });

  it("refuses the settle of its own repaint, and output keeps pushing the settle out", async () => {
    markSessionResumed("s1");
    lines = [LAUNCH, ...IDLE_FRAME];
    noteResumeHealOutput("s1");
    await vi.advanceTimersByTimeAsync(RESUME_HEAL_SETTLE_MS - 100);
    noteResumeHealOutput("s1"); // still streaming — the settle moves
    await vi.advanceTimersByTimeAsync(200);
    expect(resizes).toEqual([]);
    await settleNow();
    await bounceDone();
    expect(resizes).toHaveLength(2);

    noteResumeHealOutput("s1"); // claude's repaint from the bounce
    await settleNow();
    await bounceDone();
    expect(resizes).toHaveLength(2); // too soon — not bounced again
  });

  it("retries the restore leg so the PTY is not left a row short", async () => {
    markSessionResumed("s1");
    lines = [LAUNCH, ...IDLE_FRAME];
    failRestoreOnce = true;
    noteResumeHealOutput("s1");
    await settleNow();
    await bounceDone();
    expect(resizes).toEqual([
      [100, 39],
      [100, 40],
    ]);
  });

  it("forgets a session on request and never bounces it afterwards", async () => {
    markSessionResumed("s1");
    lines = [LAUNCH, ...IDLE_FRAME];
    noteResumeHealOutput("s1");
    forgetResumeHeal("s1");
    await settleNow();
    expect(resizes).toEqual([]);
  });
});
