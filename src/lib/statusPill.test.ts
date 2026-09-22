import { describe, expect, it } from "vitest";
import { ago, itemPill, statusTone, titleCase } from "./statusPill";

describe("statusTone", () => {
  it("reads the amber words", () => {
    expect(statusTone("waiting")).toBe("amber");
    expect(statusTone("needs you")).toBe("amber");
    expect(statusTone("blocked")).toBe("amber");
  });
  it("reads the green words", () => {
    expect(statusTone("done")).toBe("green");
    expect(statusTone("merged")).toBe("green");
    expect(statusTone("passed")).toBe("green");
    expect(statusTone("decided")).toBe("green");
    expect(statusTone("settled")).toBe("green");
    expect(statusTone("released")).toBe("green");
  });
  it("reads the blue words", () => {
    expect(statusTone("in progress")).toBe("blue");
    expect(statusTone("open")).toBe("blue");
    expect(statusTone("running")).toBe("blue");
    expect(statusTone("review")).toBe("blue");
  });
  it("reads the dim words", () => {
    expect(statusTone("closed")).toBe("dim");
    expect(statusTone("dropped")).toBe("dim");
    expect(statusTone("rejected")).toBe("dim");
    expect(statusTone("stale")).toBe("dim");
    expect(statusTone("mentioned")).toBe("dim");
    expect(statusTone("seen in thread")).toBe("dim");
  });
  it("falls back to neutral for anything else", () => {
    expect(statusTone("todo")).toBe("neutral");
    expect(statusTone("")).toBe("neutral");
    expect(statusTone("something odd")).toBe("neutral");
  });
  it("is case- and whitespace-insensitive", () => {
    expect(statusTone("  Waiting  ")).toBe("amber");
    expect(statusTone("DONE")).toBe("green");
    expect(statusTone("In Progress")).toBe("blue");
  });
});

describe("titleCase", () => {
  it("capitalizes each word", () => {
    expect(titleCase("in progress")).toBe("In Progress");
    expect(titleCase("waiting")).toBe("Waiting");
  });
  it("leaves already-capital letters alone", () => {
    expect(titleCase("CI Running")).toBe("CI Running");
  });
  it("handles empty text", () => {
    expect(titleCase("")).toBe("");
  });
});

describe("itemPill", () => {
  it("prints todo as-is with a neutral tone", () => {
    expect(itemPill({ state: "todo", owner: "agent" })).toEqual({ word: "todo", tone: "neutral" });
  });
  it("renders in_progress as the two-word form with a blue tone", () => {
    expect(itemPill({ state: "in_progress", owner: "agent" })).toEqual({ word: "in progress", tone: "blue" });
  });
  it("is amber when the state is waiting", () => {
    expect(itemPill({ state: "waiting", owner: "agent" })).toEqual({ word: "waiting", tone: "amber" });
  });
  it("is amber when the owner is the user, whatever the state word's own tone would be", () => {
    expect(itemPill({ state: "in_progress", owner: "user" })).toEqual({ word: "in progress", tone: "amber" });
  });
  it("reads done and dropped through statusTone", () => {
    expect(itemPill({ state: "done", owner: "agent" })).toEqual({ word: "done", tone: "green" });
    expect(itemPill({ state: "dropped", owner: "agent" })).toEqual({ word: "dropped", tone: "dim" });
  });
});

describe("ago", () => {
  const now = Date.parse("2026-09-22T12:00:00.000Z");
  it("reads under a minute as now", () => {
    expect(ago(new Date(now - 10_000).toISOString(), now)).toBe("now");
  });
  it("reads minutes", () => {
    expect(ago(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5m");
  });
  it("reads hours", () => {
    expect(ago(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3h");
  });
  it("reads days", () => {
    expect(ago(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe("2d");
  });
  it("is empty for an unparseable stamp", () => {
    expect(ago("not a date", now)).toBe("");
  });
  it("floors a future stamp at now rather than going negative", () => {
    expect(ago(new Date(now + 60_000).toISOString(), now)).toBe("now");
  });
});
