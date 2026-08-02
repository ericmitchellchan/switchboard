import { describe, it, expect } from "vitest";
import {
  chipLabel,
  initialUpdaterState,
  isChipClickable,
  progressPercent,
  reduceUpdater,
  type UpdaterEvent,
  type UpdaterUiState,
} from "./updaterState";

function run(events: UpdaterEvent[], from = initialUpdaterState): UpdaterUiState {
  return events.reduce(reduceUpdater, from);
}

describe("reduceUpdater", () => {
  it("idle → available on update-found", () => {
    const s = run([{ type: "update-found", version: "0.3.0" }]);
    expect(s.phase).toBe("available");
    expect(s.version).toBe("0.3.0");
  });

  it("update-found during download is ignored (periodic re-check race)", () => {
    const downloading = run([
      { type: "update-found", version: "0.3.0" },
      { type: "download-started", contentLength: 100 },
      { type: "download-progress", chunkBytes: 50 },
    ]);
    const s = reduceUpdater(downloading, {
      type: "update-found",
      version: "0.3.1",
    });
    expect(s).toBe(downloading);
  });

  it("update-found during install is ignored", () => {
    const installing = run([
      { type: "update-found", version: "0.3.0" },
      { type: "download-started", contentLength: 100 },
      { type: "install-started" },
    ]);
    const s = reduceUpdater(installing, {
      type: "update-found",
      version: "0.3.1",
    });
    expect(s).toBe(installing);
  });

  it("no-update clears an available chip but not an in-flight download", () => {
    const available = run([{ type: "update-found", version: "0.3.0" }]);
    expect(reduceUpdater(available, { type: "no-update" })).toEqual(
      initialUpdaterState
    );

    const downloading = run([
      { type: "update-found", version: "0.3.0" },
      { type: "download-started", contentLength: 100 },
    ]);
    expect(reduceUpdater(downloading, { type: "no-update" })).toBe(downloading);
  });

  it("no-update in idle is a no-op (same reference)", () => {
    expect(reduceUpdater(initialUpdaterState, { type: "no-update" })).toBe(
      initialUpdaterState
    );
  });

  it("download-started only transitions from available or error", () => {
    expect(
      reduceUpdater(initialUpdaterState, {
        type: "download-started",
        contentLength: 100,
      })
    ).toBe(initialUpdaterState);

    const s = run([
      { type: "update-found", version: "0.3.0" },
      { type: "download-started", contentLength: 1234 },
    ]);
    expect(s.phase).toBe("downloading");
    expect(s.contentLength).toBe(1234);
    expect(s.downloadedBytes).toBe(0);
  });

  it("retry path: error → downloading resets byte count and clears error", () => {
    const s = run([
      { type: "update-found", version: "0.3.0" },
      { type: "download-started", contentLength: 100 },
      { type: "download-progress", chunkBytes: 40 },
      { type: "update-failed", message: "network reset" },
      { type: "download-started", contentLength: 100 },
    ]);
    expect(s.phase).toBe("downloading");
    expect(s.downloadedBytes).toBe(0);
    expect(s.error).toBeNull();
  });

  it("download-progress accumulates chunks; ignored outside downloading", () => {
    const s = run([
      { type: "update-found", version: "0.3.0" },
      { type: "download-started", contentLength: 100 },
      { type: "download-progress", chunkBytes: 30 },
      { type: "download-progress", chunkBytes: 25 },
    ]);
    expect(s.downloadedBytes).toBe(55);

    const available = run([{ type: "update-found", version: "0.3.0" }]);
    expect(
      reduceUpdater(available, { type: "download-progress", chunkBytes: 10 })
    ).toBe(available);
  });

  it("install-started only transitions from downloading", () => {
    const s = run([
      { type: "update-found", version: "0.3.0" },
      { type: "download-started", contentLength: 100 },
      { type: "install-started" },
    ]);
    expect(s.phase).toBe("installing");

    const available = run([{ type: "update-found", version: "0.3.0" }]);
    expect(reduceUpdater(available, { type: "install-started" })).toBe(
      available
    );
  });

  it("update-failed keeps the version and records the message", () => {
    const s = run([
      { type: "update-found", version: "0.3.0" },
      { type: "download-started", contentLength: 100 },
      { type: "update-failed", message: "boom" },
    ]);
    expect(s.phase).toBe("error");
    expect(s.version).toBe("0.3.0");
    expect(s.error).toBe("boom");
  });

  it("update-failed in idle is ignored (no chip for an unseen update)", () => {
    expect(
      reduceUpdater(initialUpdaterState, {
        type: "update-failed",
        message: "boom",
      })
    ).toBe(initialUpdaterState);
  });

  it("reset returns to initial from any phase", () => {
    const s = run([
      { type: "update-found", version: "0.3.0" },
      { type: "download-started", contentLength: 100 },
      { type: "update-failed", message: "boom" },
      { type: "reset" },
    ]);
    expect(s).toEqual(initialUpdaterState);
  });
});

describe("progressPercent", () => {
  it("null outside downloading and when total size unknown", () => {
    expect(progressPercent(initialUpdaterState)).toBeNull();
    const unknownLength = run([
      { type: "update-found", version: "0.3.0" },
      { type: "download-started", contentLength: null },
      { type: "download-progress", chunkBytes: 500 },
    ]);
    expect(progressPercent(unknownLength)).toBeNull();
  });

  it("rounds and caps at 100", () => {
    const base = run([
      { type: "update-found", version: "0.3.0" },
      { type: "download-started", contentLength: 300 },
    ]);
    expect(progressPercent(base)).toBe(0);
    expect(
      progressPercent(
        reduceUpdater(base, { type: "download-progress", chunkBytes: 100 })
      )
    ).toBe(33);
    // Overshoot (chunk sums past contentLength) caps at 100
    expect(
      progressPercent(
        reduceUpdater(base, { type: "download-progress", chunkBytes: 400 })
      )
    ).toBe(100);
  });
});

describe("manual check", () => {
  it("check-started only from a resting phase", () => {
    expect(run([{ type: "check-started" }]).phase).toBe("checking");
    expect(
      run([{ type: "check-started" }, { type: "no-update" }, { type: "check-started" }]).phase,
    ).toBe("checking"); // from uptodate

    // must NOT interrupt a live flow
    const downloading = run([
      { type: "update-found", version: "0.3.0" },
      { type: "download-started", contentLength: 10 },
    ]);
    expect(reduceUpdater(downloading, { type: "check-started" })).toBe(downloading);

    // must not hide an install affordance the user is reaching for
    const available = run([{ type: "update-found", version: "0.3.0" }]);
    expect(reduceUpdater(available, { type: "check-started" })).toBe(available);
  });

  it("a user-run check reports both outcomes", () => {
    expect(run([{ type: "check-started" }, { type: "no-update" }]).phase).toBe("uptodate");

    const found = run([{ type: "check-started" }, { type: "update-found", version: "0.4.0" }]);
    expect(found.phase).toBe("available");
    expect(found.version).toBe("0.4.0");
  });

  it("check-failed surfaces (unlike the silent background check)", () => {
    const s = run([{ type: "check-started" }, { type: "check-failed", message: "offline" }]);
    expect(s.phase).toBe("error");
    expect(s.error).toBe("offline");
    expect(isChipClickable(s)).toBe(true); // retry is reachable
  });

  it("a stray check-failed outside a check is ignored", () => {
    expect(
      reduceUpdater(initialUpdaterState, { type: "check-failed", message: "x" }),
    ).toBe(initialUpdaterState);
  });
});

describe("chipLabel / isChipClickable", () => {
  it("hidden in idle", () => {
    expect(chipLabel(initialUpdaterState)).toBeNull();
    expect(isChipClickable(initialUpdaterState)).toBe(false);
  });

  it("available: install wording, clickable", () => {
    const s = run([{ type: "update-found", version: "0.3.0" }]);
    // "install", not "restart to install" — the click does the whole thing.
    expect(chipLabel(s)).toBe("update v0.3.0 — install");
    expect(isChipClickable(s)).toBe(true);
  });

  it("checking / up-to-date are shown but not clickable", () => {
    const checking = run([{ type: "check-started" }]);
    expect(chipLabel(checking)).toBe("checking for updates…");
    expect(isChipClickable(checking)).toBe(false);

    const uptodate = run([{ type: "check-started" }, { type: "no-update" }]);
    expect(chipLabel(uptodate)).toBe("up to date");
    expect(isChipClickable(uptodate)).toBe(false);
  });

  it("downloading: percent when total known, ellipsis when not", () => {
    const known = run([
      { type: "update-found", version: "0.3.0" },
      { type: "download-started", contentLength: 200 },
      { type: "download-progress", chunkBytes: 100 },
    ]);
    expect(chipLabel(known)).toBe("downloading v0.3.0 50%");
    expect(isChipClickable(known)).toBe(false);

    const unknown = run([
      { type: "update-found", version: "0.3.0" },
      { type: "download-started", contentLength: null },
    ]);
    expect(chipLabel(unknown)).toBe("downloading v0.3.0…");
  });

  it("installing: not clickable", () => {
    const s = run([
      { type: "update-found", version: "0.3.0" },
      { type: "download-started", contentLength: 100 },
      { type: "install-started" },
    ]);
    expect(chipLabel(s)).toBe("installing v0.3.0…");
    expect(isChipClickable(s)).toBe(false);
  });

  it("error: dim retry label, clickable", () => {
    const s = run([
      { type: "update-found", version: "0.3.0" },
      { type: "download-started", contentLength: 100 },
      { type: "update-failed", message: "boom" },
    ]);
    expect(chipLabel(s)).toBe("update failed — retry");
    expect(isChipClickable(s)).toBe(true);
  });
});
