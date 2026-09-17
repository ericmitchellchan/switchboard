// The machine page (SWIT-92): its pure core loaded straight from the file the
// browser runs (watcher/panel/panel.js), evaluated in a sandbox with a `self`
// the way a browser would (the repo is "type": "module", so Node would read a
// .js file as ESM and the CommonJS branch never runs here), plus one real run
// of the page's server — stock busybox httpd over the panel folder with a
// state folder mounted beside it, the way mw.sh starts it. Skips the server
// test with a note when Docker is unreachable.

import { describe, it, expect } from "vitest";
// @ts-expect-error — no @types/node in the frontend tsconfig; vitest's node runtime provides it.
import vm from "node:vm";
// @ts-expect-error — same.
import { execFileSync } from "node:child_process";
// @ts-expect-error — same.
import fs from "node:fs";
// @ts-expect-error — same.
import os from "node:os";
// @ts-expect-error — same.
import path from "node:path";
// @ts-expect-error — same.
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const panelDir = path.resolve(here, "../../watcher/panel");
const sandbox: { self: Record<string, unknown> } = { self: {} };
vm.runInNewContext(fs.readFileSync(path.join(panelDir, "panel.js"), "utf-8"), sandbox);
const panel = sandbox.self.MachinePanel as {
  esc: (s: unknown) => string;
  quietWord: (r: Row) => string;
  ageWord: (ms: number) => string;
  laneWord: (workdir: string) => string;
  ownerThread: (workdir: string, threads: unknown) => { title: string; archived: boolean } | null;
  parseActions: (text: string) => Action[];
  model: (snapshot: Snapshot | null, actions: Action[], nowMs: number, threads?: unknown) => Model;
  render: (m: Model) => string;
};

type Row = Record<string, unknown> & { name: string };
type Action = Record<string, unknown> & { name: string; action: string };
type Snapshot = { sampledAt: string; idleMinutes: number; dryRun: boolean; holdUntil: number; containers: Row[] };
type Model = { age: string; stale: boolean; dryRun: boolean; held: boolean; running: Row[]; idle: Row[]; stopped: Row[]; comesBack: number; actions: Action[] };

const NOW = Date.parse("2026-09-17T04:00:00Z");
const row = (o: Partial<Row> & { name: string }): Row => ({
  project: "", image: "img", state: "running", restart: "no", cpuPct: 0, memMb: 10, trafficKnown: true, idleMinutes: 1, skipped: false, policy: "", ...o,
});
const snap = (containers: Row[], o: Partial<Snapshot> = {}): Snapshot => ({
  sampledAt: "2026-09-17T03:59:20Z", idleMinutes: 120, dryRun: true, holdUntil: 0, containers, ...o,
});

describe("model", () => {
  it("sorts running hottest-first, applies the idle rule where it may, counts the come-back containers", () => {
    const m = panel.model(
      snap([
        row({ name: "cool", cpuPct: 1 }),
        row({ name: "hot", cpuPct: 30 }),
        row({ name: "abandoned", idleMinutes: 400, policy: "would stop" }),
        row({ name: "kyde", idleMinutes: 400, skipped: true }),
        row({ name: "mute", trafficKnown: false, idleMinutes: null }),
        row({ name: "gone", state: "exited" }),
        row({ name: "zombie", state: "exited", restart: "always" }),
      ]),
      [],
      NOW
    );
    expect(m.running.map((r) => r.name)).toEqual(["hot", "cool", "abandoned", "kyde", "mute"]);
    expect(m.idle.map((r) => r.name)).toEqual(["abandoned"]);
    expect(m.stopped.map((r) => r.name)).toEqual(["zombie", "gone"]);
    expect(m.comesBack).toBe(1);
    expect(m.age).toBe("40s ago");
    expect(m.stale).toBe(false);
    expect(m.dryRun).toBe(true);
  });

  it("flags a stale snapshot, a hold, and survives no snapshot at all", () => {
    expect(panel.model(snap([], { sampledAt: "2026-09-17T03:40:00Z" }), [], NOW).stale).toBe(true);
    const held = panel.model(snap([], { holdUntil: NOW / 1000 + 3600 }), [], NOW);
    expect(held.held).toBe(true);
    const none = panel.model(null, [], NOW);
    expect(none.stale).toBe(true);
    expect(none.age).toBe("age unknown");
    expect(none.running).toEqual([]);
  });

  it("keeps the last ten actions, newest first, and drops a torn line", () => {
    const text = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => JSON.stringify({ at: `2026-09-17T0${i % 10}:00:00Z`, name: `c${i}`, action: "would stop" })).join("\n") + "\n{torn";
    const actions = panel.parseActions(text);
    expect(actions.length).toBe(11);
    expect(actions[0].name).toBe("c11");
    expect(panel.model(snap([]), actions, NOW).actions.map((a) => a.name)).toEqual(["c11", "c10", "c9", "c8", "c7", "c6", "c5", "c4", "c3", "c2"]);
  });
});

describe("lane and owner", () => {
  const threads = {
    threads: [
      { title: "switchboard · Aug 2", workingDir: "C:\\Users\\ericm\\projects\\switchboard", archivedAt: null, lastActivityAt: "1" },
      { title: "jira lane (old)", workingDir: "C:\\Users\\ericm\\projects\\ky-lanes\\jira", archivedAt: "2026-09-01", lastActivityAt: "5" },
      { title: "jira lane", workingDir: "C:/Users/ericm/projects/ky-lanes/jira/", archivedAt: null, lastActivityAt: "3" },
      { title: "all lanes", workingDir: "C:\\Users\\ericm\\projects\\ky-lanes", archivedAt: null, lastActivityAt: "9" },
    ],
  };

  it("laneWord is the path after projects/, at most three segments", () => {
    expect(panel.laneWord("C:\\Users\\ericm\\projects\\ky-lanes\\jira\\apps\\cloud")).toBe("ky-lanes/jira/apps");
    expect(panel.laneWord("C:/Users/ericm/projects/switchboard")).toBe("switchboard");
    expect(panel.laneWord("/opt/stacks/lc-data-collector/")).toBe("stacks/lc-data-collector");
    expect(panel.laneWord("")).toBe("");
  });

  it("ownerThread picks the longest containing folder, live over archived, then most recent", () => {
    expect(panel.ownerThread("C:\\Users\\ericm\\projects\\ky-lanes\\jira\\apps\\cloud", threads)).toEqual({ title: "jira lane", archived: false });
    expect(panel.ownerThread("C:\\Users\\ericm\\projects\\ky-lanes\\other", threads)).toEqual({ title: "all lanes", archived: false });
    expect(panel.ownerThread("C:\\Users\\ericm\\projects\\switchboard", threads)).toEqual({ title: "switchboard · Aug 2", archived: false });
    // a sibling that merely shares a prefix string is not inside the folder
    expect(panel.ownerThread("C:\\Users\\ericm\\projects\\switchboard-release", threads)).toBeNull();
    // a thread opened on the projects root (or the home dir) contains everything and owns nothing
    const roots = { threads: [{ title: "projects · Aug 6", workingDir: "C:\\Users\\ericm\\projects" }, { title: "home", workingDir: "C:\\Users\\ericm" }] };
    expect(panel.ownerThread("C:\\Users\\ericm\\projects\\ky-lanes\\jira", roots)).toBeNull();
    // folders differing only by case are the same folder on Windows (the real snapshot has Cursor/ and cursor/)
    const cased = { threads: [{ title: "lc", workingDir: "C:\\Users\\ericm\\Cursor\\lc-data-collector" }] };
    expect(panel.ownerThread("c:/users/ericm/cursor/lc-data-collector/infra", cased)).toEqual({ title: "lc", archived: false });
    // two LIVE threads on the same folder: the most recently active wins (the real file has three on projects/switchboard)
    const twins = { threads: [{ title: "older", workingDir: "C:\\p\\projects\\x", lastActivityAt: 10 }, { title: "newer", workingDir: "C:\\p\\projects\\x", lastActivityAt: 20 }] };
    expect(panel.ownerThread("C:\\p\\projects\\x\\sub", twins)).toEqual({ title: "newer", archived: false });
    expect(panel.ownerThread("C:\\elsewhere", threads)).toBeNull();
    expect(panel.ownerThread("C:\\elsewhere", null)).toBeNull();
  });

  it("the model carries lane + owner onto every row and render prints them", () => {
    const m = panel.model(
      snap([row({ name: "ky-cloud-postgres", project: "cloud", workdir: "C:\\Users\\ericm\\projects\\ky-lanes\\jira\\apps\\cloud" }), row({ name: "loose", workdir: "C:\\Users\\ericm\\projects\\orbit" })]),
      [],
      NOW,
      threads
    );
    expect(m.running[0].lane).toBe("ky-lanes/jira/apps");
    expect(m.running[0].owner).toEqual({ title: "jira lane", archived: false });
    expect(m.running[1].owner).toBeNull();
    const html = panel.render(m);
    expect(html).toContain('<span class="lane" title="C:\\Users\\ericm\\projects\\ky-lanes\\jira\\apps\\cloud">ky-lanes/jira/apps</span>');
    expect(html).toContain("thread: jira lane");
    expect(html).toContain("no thread on that folder");
    // a thread title is escaped like everything else
    const hostile = panel.render(panel.model(snap([row({ name: "a", workdir: "C:\\x" })]), [], NOW, { threads: [{ title: "<b>t</b>", workingDir: "C:\\x" }] }));
    expect(hostile).toContain("thread: &lt;b&gt;t&lt;/b&gt;");
    expect(hostile).not.toContain("<b>t</b>");
  });
});

describe("render", () => {
  it("escapes everything it prints and marks the rule's mode, holds and staleness", () => {
    const p = (n: number) => (n < 10 ? "0" : "") + n;
    const m = panel.model(
      snap(
        [
          row({ name: '<img src=x onerror="1">', project: "a&b", idleMinutes: 400, policy: "<p>" }),
          row({ name: "<q>", state: "<x>", restart: "<r>", project: "<pr>" }),
        ],
        { holdUntil: NOW / 1000 + 600 }
      ),
      [
        { at: "2026-09-17T03:00:00Z", name: "x", action: "stopped", rule: "idle > 120m" },
        { at: "<s>", name: "<b>", action: "<i>", rule: "<u>" },
      ],
      NOW
    );
    const html = panel.render(m);
    // every hostile value — a running row's name/project/policy, a stopped row's name/state/project,
    // an action's name/action/rule/at — comes out escaped
    for (const raw of ["<img", "<p>", "<q>", "<x>", "<pr>", "<b>", "<i>", "<u>", "<s>"]) expect(html).not.toContain(raw);
    expect(html).toContain("&lt;img src=x onerror=&quot;1&quot;&gt;");
    expect(html).toContain("a&amp;b");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("dry run — the rule logs, never stops");
    const h = new Date((NOW / 1000 + 600) * 1000);
    expect(html).toContain(`hold until ${p(h.getHours())}:${p(h.getMinutes())} — clock paused`);
    expect(html).toContain("held, nothing stops");
    expect(html).toContain('class="row warn"');
    expect(html).toContain("stopped · idle &gt; 120m");
    // action stamps print in LOCAL time as MM-DD HH:MM — computed here through the same API the page
    // uses, so the assertion is TZ-independent and, on any non-UTC host, differs from a UTC slice;
    // an unparsable one is shown as written (escaped)
    const d = new Date("2026-09-17T03:00:00Z");
    expect(html).toContain(`<span class="quiet">${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}</span>`);
    expect(html).not.toContain("2026-09-17T03:00:00Z");
    expect(html).toContain("&lt;s&gt;");
    const live = panel.render(panel.model(snap([], { dryRun: false, sampledAt: "2026-09-17T03:00:00Z" }), [], NOW));
    expect(live).toContain("LIVE — the rule stops");
    expect(live).toContain("watcher may be down");
  });

  it("a running row gets a stop button (name escaped) unless it is a skipped container; refusals print their reason", () => {
    const html = panel.render(
      panel.model(
        snap([row({ name: 'a"b' }), row({ name: "machine-watcher", skipped: true }), row({ name: "gone", state: "exited" })]),
        [{ at: "2026-09-17T03:00:00Z", name: "machine-watcher", action: "refused", rule: "page stop", reason: "skipped container" }],
        NOW
      )
    );
    expect(html).toContain('<button class="stop" type="button" data-name="a&quot;b">stop</button>');
    expect(html).not.toContain('data-name="machine-watcher">stop');
    expect(html).not.toContain('data-name="gone"');
    expect(html).toContain("refused · page stop (skipped container)");
  });

  it("quietWord matches the machine tool's wording", () => {
    expect(panel.quietWord(row({ name: "a", idleMinutes: 5 }))).toBe("5m quiet");
    expect(panel.quietWord(row({ name: "a", idleMinutes: 125 }))).toBe("2h 5m quiet");
    expect(panel.quietWord(row({ name: "a", idleMinutes: 2000 }))).toBe("33h 20m quiet"); // the tool's own pinned example
    expect(panel.quietWord(row({ name: "a", trafficKnown: false }))).toBe("traffic unknown");
    expect(panel.quietWord(row({ name: "a", idleMinutes: null }))).toBe("just seen");
  });
});

/** A daemon that runs LINUX containers (GitHub's Windows runners answer `docker version`
 *  in Windows-container mode, where no Linux image can run). */
function dockerReachable(): boolean {
  try {
    const os = execFileSync("docker", ["version", "--format", "{{.Server.Os}}"], { stdio: "pipe", timeout: 15000, encoding: "utf-8" });
    return os.trim() === "linux";
  } catch {
    return false;
  }
}
const reachable = dockerReachable();
const maybe = reachable ? describe : describe.skip;
if (!reachable) console.warn("machinePanel.test.ts: Docker is not reachable — the page-server test is skipped");

maybe("the page's server (busybox httpd) over the panel folder + a state folder", () => {
  it("serves index.html, panel.js and state/containers.json the way the page fetches them", () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "sb-page-"));
    fs.writeFileSync(path.join(state, "containers.json"), JSON.stringify(snap([row({ name: "served" })])));
    try {
      const out = execFileSync(
        "docker",
        [
          "run", "--rm",
          "-v", `${panelDir}:/www:ro`,
          "-v", `${state}:/www/state:ro`,
          "busybox:stable", "sh", "-c",
          "httpd -p 8090 -h /www && sleep 1 && wget -qO- http://127.0.0.1:8090/ | head -c 60 && echo && echo ---JS--- && wget -qO- http://127.0.0.1:8090/panel.js | head -c 40 && echo && echo ---STATE--- && wget -qO- http://127.0.0.1:8090/state/containers.json",
        ],
        { encoding: "utf-8", timeout: 90000 }
      );
      expect(out).toContain("<!doctype html>");
      expect(out).toContain("---JS---");
      expect(out).toContain("The machine page");
      expect(out).toContain('"name":"served"');
    } finally {
      fs.rmSync(state, { recursive: true, force: true });
    }
  }, 120000);

  it("cgi-bin/stop writes ONE request file into the writable requests mount; a bad name, a GET and a POST without the page's header are refused", () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "sb-page-"));
    const requests = path.join(state, "requests");
    fs.mkdirSync(requests);
    try {
      const out = execFileSync(
        "docker",
        [
          "run", "--rm",
          "-v", `${panelDir}:/www:ro`,
          "-v", `${state}:/www/state:ro`,
          "-v", `${requests}:/www/state/requests`,
          "busybox:stable", "sh", "-c",
          [
            // the httpd calls hit the MOUNTED script, exactly as the page does (the repo pins it to LF in .gitattributes)
            "httpd -p 8090 -h /www",
            "sleep 1",
            "echo ---OK---; wget -qO- --header 'X-Machine-Page: 1' --post-data 'name=busy-db' http://127.0.0.1:8090/cgi-bin/stop; echo",
            "echo ---BAD---; wget -qO- --header 'X-Machine-Page: 1' --post-data 'name=bad name' http://127.0.0.1:8090/cgi-bin/stop 2>&1 || echo refused-bad",
            "echo ---GET---; wget -qO- 'http://127.0.0.1:8090/cgi-bin/stop?name=via-get' 2>&1 || echo refused-get",
            "echo ---NOHEADER---; wget -qO- --post-data 'name=no-header' http://127.0.0.1:8090/cgi-bin/stop 2>&1 || echo refused-noheader",
            "echo ---FILES---; ls /www/state/requests; cat /www/state/requests/busy-db.stop",
          ].join(" && "),
        ],
        { encoding: "utf-8", timeout: 90000 }
      );
      expect(out).toContain('{"queued":"busy-db"');
      expect(out).toMatch(/---BAD---[\s\S]*refused-bad/);
      expect(out).toMatch(/---GET---[\s\S]*refused-get/);
      expect(out).toMatch(/---NOHEADER---[\s\S]*refused-noheader/);
      expect(out).toMatch(/---FILES---\s*busy-db\.stop/);
      expect(out).toContain('"name":"busy-db","action":"stop","by":"page"');
      // only the one legitimate request was written — the GET and the header-less POST left nothing
      expect(fs.readdirSync(requests)).toEqual(["busy-db.stop"]);
    } finally {
      fs.rmSync(state, { recursive: true, force: true });
    }
  }, 120000);
});
