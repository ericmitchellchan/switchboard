import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_SHELL_MODE,
  parseShellModeValue,
  parseShellModeParam,
  resolveShellMode,
  shellMode,
  isBare,
  applyConfigShellMode,
  __setShellModeForTests,
} from "./shellMode";

describe("shellMode — parse rules", () => {
  it("bare is the default", () => {
    expect(DEFAULT_SHELL_MODE).toBe("bare");
    expect(resolveShellMode({})).toBe("bare");
    expect(resolveShellMode({ search: "", config: undefined })).toBe("bare");
  });

  it("parses the two words, trimmed and case-insensitive; anything else is no opinion", () => {
    expect(parseShellModeValue("full")).toBe("full");
    expect(parseShellModeValue(" FULL ")).toBe("full");
    expect(parseShellModeValue("bare")).toBe("bare");
    expect(parseShellModeValue("")).toBeNull();
    expect(parseShellModeValue("everything")).toBeNull();
    expect(parseShellModeValue(undefined)).toBeNull();
    expect(parseShellModeValue(null)).toBeNull();
    expect(parseShellModeValue(1)).toBeNull();
  });

  it("reads ?shell= from a search string, with or without the leading ?", () => {
    expect(parseShellModeParam("?shell=full")).toBe("full");
    expect(parseShellModeParam("screen=kb&shell=full")).toBe("full");
    expect(parseShellModeParam("?screen=kb")).toBeNull();
    expect(parseShellModeParam("?shell=nope")).toBeNull();
  });

  it("URL wins over config, config wins over the default", () => {
    expect(resolveShellMode({ search: "?shell=full" })).toBe("full");
    expect(resolveShellMode({ search: "?shell=bare", config: "full" })).toBe("bare");
    expect(resolveShellMode({ search: "?screen=home", config: "full" })).toBe("full");
    // An unknown URL value falls through to config, not to bare.
    expect(resolveShellMode({ search: "?shell=maybe", config: "full" })).toBe("full");
    expect(resolveShellMode({ search: "?shell=maybe", config: "maybe" })).toBe("bare");
  });
});

describe("shellMode — the boot latch", () => {
  beforeEach(() => __setShellModeForTests(null));
  afterEach(() => __setShellModeForTests(null));

  it("boots bare with no URL value (tests have no ?shell=)", () => {
    expect(shellMode()).toBe("bare");
    expect(isBare()).toBe(true);
  });

  it("the first config value applies once, then latches", () => {
    expect(applyConfigShellMode("full")).toBe("full");
    expect(isBare()).toBe(false);
    // A re-fetch of config later in the session changes nothing.
    expect(applyConfigShellMode("bare")).toBe("full");
    expect(shellMode()).toBe("full");
  });

  it("an unrecognised config value neither latches nor changes the mode", () => {
    expect(applyConfigShellMode("nope")).toBe("bare");
    expect(applyConfigShellMode(undefined)).toBe("bare");
    // Still open: a later valid value is honoured.
    expect(applyConfigShellMode("full")).toBe("full");
  });

  it("a mode set by the URL (forced here) wins over config", () => {
    __setShellModeForTests("bare");
    expect(applyConfigShellMode("full")).toBe("bare");
    __setShellModeForTests("full");
    expect(applyConfigShellMode("bare")).toBe("full");
  });
});
