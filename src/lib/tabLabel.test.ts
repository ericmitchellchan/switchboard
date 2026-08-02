// Pure Node tests for the tab-chrome de-duplication rules (tabLabel.ts).

import { describe, it, expect } from "vitest";
import { nameLeadsWith, tabGroupLabel, tabRepoSuffix } from "./tabLabel";

describe("nameLeadsWith", () => {
  it("matches an exact name, case-insensitively", () => {
    expect(nameLeadsWith("switchboard", "switchboard")).toBe(true);
    expect(nameLeadsWith("Switchboard", "SWITCHBOARD")).toBe(true);
  });

  it("matches the synced default title `<repo> · <date>`", () => {
    expect(nameLeadsWith("switchboard · Aug 2", "switchboard")).toBe(true);
    expect(nameLeadsWith("lodestar · Jul 31", "lodestar")).toBe(true);
  });

  it("matches across the other separators a tab name can use", () => {
    expect(nameLeadsWith("orbit - api", "orbit")).toBe(true);
    expect(nameLeadsWith("orbit_api", "orbit")).toBe(true);
    expect(nameLeadsWith("orbit/api", "orbit")).toBe(true);
    expect(nameLeadsWith("orbit: notes", "orbit")).toBe(true);
  });

  it("does NOT match a longer word that merely starts the same", () => {
    expect(nameLeadsWith("switchboarding", "switchboard")).toBe(false);
    expect(nameLeadsWith("orbital", "orbit")).toBe(false);
  });

  it("does not match mid-name occurrences — this is a PREFIX rule", () => {
    expect(nameLeadsWith("fix switchboard", "switchboard")).toBe(false);
  });

  it("empty inputs never match", () => {
    expect(nameLeadsWith("", "switchboard")).toBe(false);
    expect(nameLeadsWith("switchboard", "")).toBe(false);
    expect(nameLeadsWith("switchboard", "   ")).toBe(false);
  });
});

describe("tabRepoSuffix", () => {
  it("drops the chip when the name already leads with the repo", () => {
    expect(tabRepoSuffix("switchboard", "switchboard")).toBeNull();
    expect(tabRepoSuffix("switchboard · Aug 2", "switchboard")).toBeNull();
  });

  it("keeps the chip when it adds information", () => {
    expect(tabRepoSuffix("api server", "orbit")).toBe("orbit");
    expect(tabRepoSuffix("scratch", "lodestar")).toBe("lodestar");
  });

  it("no repo → no chip", () => {
    expect(tabRepoSuffix("plain shell", undefined)).toBeNull();
    expect(tabRepoSuffix("plain shell", "")).toBeNull();
    expect(tabRepoSuffix("plain shell", "   ")).toBeNull();
  });
});

describe("tabGroupLabel", () => {
  it("drops the label when the next tab's name already says it", () => {
    expect(tabGroupLabel("switchboard", "switchboard")).toBeNull();
    expect(tabGroupLabel("switchboard", "switchboard · Aug 2")).toBeNull();
  });

  it("keeps (and uppercases) the label when the tab name does not say it", () => {
    expect(tabGroupLabel("kyde", "admin panel")).toBe("KYDE");
  });

  it("empty group → no label", () => {
    expect(tabGroupLabel("", "anything")).toBeNull();
    expect(tabGroupLabel("  ", "anything")).toBeNull();
  });
});
