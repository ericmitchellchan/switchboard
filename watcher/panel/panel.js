// The machine page's pure core (SWIT-92): snapshot + actions → view model → HTML.
// No framework, no build step; index.html loads this file as a classic script and
// lib/machinePanel.test.ts evaluates the SAME file in a vm with a `self`, so the
// browser branch of the wrapper is the one that is tested. (The CommonJS branch is
// for a plain Node `require` outside this repo — vitest never takes it, because the
// repo is "type": "module" and a .js file reads as ESM there.)
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MachinePanel = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** "traffic unknown" · "just seen" · "12m quiet" · "3h 5m quiet" — exactly the `machine` tool's wording. */
  function quietWord(r) {
    if (!r.trafficKnown) return "traffic unknown";
    if (typeof r.idleMinutes !== "number") return "just seen";
    if (r.idleMinutes < 60) return r.idleMinutes + "m quiet";
    var h = Math.floor(r.idleMinutes / 60);
    return h + "h " + (r.idleMinutes - h * 60) + "m quiet";
  }

  function ageWord(ms) {
    if (!isFinite(ms) || ms < 0) return "age unknown";
    var s = Math.round(ms / 1000);
    if (s < 90) return s + "s ago";
    var min = Math.round(s / 60);
    if (min < 90) return min + " min ago";
    return Math.round(min / 60) + " h ago";
  }

  /** actions.jsonl → newest first. Line-wise; a torn last line drops alone. */
  function parseActions(text) {
    var out = [];
    String(text || "")
      .split("\n")
      .forEach(function (line) {
        if (!line.trim()) return;
        try {
          out.push(JSON.parse(line));
        } catch (e) {
          /* torn */
        }
      });
    return out.reverse();
  }

  function comesBack(r) {
    return r.restart === "always" || r.restart === "unless-stopped";
  }

  /** A folder as a key: forward slashes, lower case, no trailing slash. */
  function folderKey(p) {
    return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  /** The repo or lane a compose folder lives in — the path after `projects/`,
   *  at most three segments (`ky-lanes/jira/apps`), else the folder's last two. */
  function laneWord(workdir) {
    var p = String(workdir || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!p) return "";
    var i = p.toLowerCase().indexOf("/projects/");
    var tail = i >= 0 ? p.slice(i + 10) : p.split("/").slice(-2).join("/");
    return tail.split("/").slice(0, 3).join("/");
  }

  /** The Switchboard thread whose working folder contains this container's
   *  compose folder — the LONGEST match wins (a lane's thread over the repo's),
   *  a live thread over an archived one, then the most recently active.
   *  `threads` is Switchboard's threads.json (`{threads:[{title, workingDir,
   *  archivedAt, lastActivityAt}]}`); null when the page has no copy. */
  function ownerThread(workdir, threads) {
    var key = folderKey(workdir);
    if (!key || !threads || !Array.isArray(threads.threads)) return null;
    var best = null;
    threads.threads.forEach(function (t) {
      var tk = folderKey(t.workingDir);
      if (!tk || (key !== tk && key.indexOf(tk + "/") !== 0)) return;
      // A thread opened on the projects root, a drive root or a Windows home dir contains
      // everything and owns nothing. (threads.json is written by the Windows app.)
      if (/\/projects$/.test(tk) || (tk.indexOf("/projects/") < 0 && /^[a-z]:(\/users\/[^/]+)?$/.test(tk))) return;
      var live = !t.archivedAt;
      var at = Number(t.lastActivityAt) || 0;
      if (
        !best ||
        tk.length > best.key.length ||
        (tk.length === best.key.length && live && !best.live) ||
        (tk.length === best.key.length && live === best.live && at > best.at)
      ) {
        best = { key: tk, live: live, at: at, title: String(t.title || ""), archived: !live };
      }
    });
    return best ? { title: best.title, archived: best.archived } : null;
  }

  /** The view model. `stale` = the watcher has missed at least three ticks.
   *  Every container row gains `lane` (repo/lane from its compose folder) and
   *  `owner` (the Switchboard thread, or null). */
  function model(snapshot, actions, nowMs, threads) {
    var rows = ((snapshot && snapshot.containers) || []).map(function (r) {
      var out = {};
      for (var k in r) out[k] = r[k];
      out.lane = laneWord(r.workdir);
      out.owner = ownerThread(r.workdir, threads);
      return out;
    });
    var sampledMs = Date.parse(snapshot && snapshot.sampledAt);
    var ageMs = isFinite(sampledMs) ? nowMs - sampledMs : NaN;
    var held = Boolean(snapshot && snapshot.holdUntil) && snapshot.holdUntil * 1000 > nowMs;
    var running = rows
      .filter(function (r) { return r.state === "running"; })
      .sort(function (a, b) { return (b.cpuPct || 0) - (a.cpuPct || 0); });
    var idle = running.filter(function (r) {
      return r.trafficKnown && !r.skipped && typeof r.idleMinutes === "number" && r.idleMinutes >= (snapshot.idleMinutes || 0);
    });
    var stopped = rows
      .filter(function (r) { return r.state !== "running"; })
      .sort(function (a, b) {
        return Number(comesBack(b)) - Number(comesBack(a)) || String(a.name).localeCompare(String(b.name));
      });
    return {
      sampledAt: snapshot ? snapshot.sampledAt : "",
      age: ageWord(ageMs),
      stale: !isFinite(ageMs) || ageMs > 3 * 60 * 1000,
      dryRun: snapshot ? snapshot.dryRun !== false : true,
      held: held,
      holdUntil: held ? localClock(snapshot.holdUntil * 1000) : "",
      idleMinutes: snapshot ? snapshot.idleMinutes : 0,
      running: running,
      idle: idle,
      stopped: stopped,
      comesBack: stopped.filter(comesBack).length,
      actions: (actions || []).slice(0, 10),
    };
  }

  /** The second line of a row: where it came from and who owns it. */
  function whereHtml(r) {
    var bits = [];
    if (r.lane) bits.push('<span class="lane" title="' + esc(r.workdir) + '">' + esc(r.lane) + "</span>");
    else if (r.project) bits.push('<span class="lane">' + esc(r.project) + "</span>");
    if (r.owner) bits.push('<span class="owner">thread: ' + esc(r.owner.title) + (r.owner.archived ? " (archived)" : "") + "</span>");
    else if (r.lane) bits.push('<span class="owner dim">no thread on that folder</span>');
    return bits.length ? '<span class="where">' + bits.join(" · ") + "</span>" : "";
  }

  function rowHtml(r) {
    var meta = [];
    if (r.project && r.project !== r.lane) meta.push(esc(r.project));
    meta.push(((r.cpuPct || 0).toFixed(1)) + "% cpu");
    if (r.memMb) meta.push(Math.round(r.memMb) + " MB");
    var tone = r.policy ? "warn" : !r.trafficKnown ? "dim" : "";
    var tag = r.skipped ? "own reaper" : r.policy ? r.policy : "";
    return (
      '<li class="row ' + tone + '">' +
      '<span class="name">' + esc(r.name) + "</span>" +
      '<span class="meta">' + meta.join(" · ") + "</span>" +
      '<span class="quiet">' + esc(quietWord(r)) + "</span>" +
      (tag ? '<span class="tag">' + esc(tag) + "</span>" : "") +
      whereHtml(r) +
      "</li>"
    );
  }

  function stoppedHtml(r) {
    return (
      '<li class="row dim"><span class="name">' + esc(r.name) + "</span>" +
      '<span class="meta">' + esc(r.lane || r.project || "") + "</span>" +
      '<span class="quiet">' + esc(r.state) + (comesBack(r) ? " · comes back with Docker" : "") + "</span></li>"
    );
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /** An action's stamp in LOCAL time, `09-16 22:50`; an unparsable one is shown as written, a missing one is blank. */
  function localStamp(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  /** A clock time in LOCAL time, `22:50` — the hold pill, so the page has one time convention. */
  function localClock(ms) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function actionHtml(a) {
    var at = localStamp(a.at);
    return (
      '<li class="row ' + (a.action === "stopped" ? "warn" : "") + '"><span class="name">' + esc(a.name) + "</span>" +
      '<span class="meta">' + esc(a.action) + " · " + esc(a.rule || "") + "</span>" +
      '<span class="quiet">' + esc(at) + "</span></li>"
    );
  }

  function render(m) {
    var mode = m.dryRun ? '<span class="pill">dry run — the rule logs, never stops</span>' : '<span class="pill live">LIVE — the rule stops</span>';
    var hold = m.held ? '<span class="pill hold">hold until ' + esc(m.holdUntil) + " — clock paused</span>" : "";
    var head =
      '<header class="' + (m.stale ? "stale" : "") + '">' +
      "<h1>Machine</h1>" +
      '<div class="pills">' + mode + hold + '<span class="pill">idle rule ' + esc(m.idleMinutes) + "m</span>" +
      '<span class="pill age">snapshot ' + esc(m.age) + (m.stale ? " — watcher may be down" : "") + "</span></div>" +
      "</header>";
    var running =
      '<section><h2>Running <span class="n">' + m.running.length + "</span> <small>hottest first</small></h2><ul>" +
      (m.running.length ? m.running.map(rowHtml).join("") : '<li class="row dim"><span class="name">nothing running</span></li>') +
      "</ul></section>";
    var idle =
      '<section><h2>Idle by the rule <span class="n">' + m.idle.length + "</span> <small>" +
      (m.held ? "held, nothing stops" : m.dryRun ? "would be stopped" : "will be stopped") +
      "</small></h2><ul>" +
      (m.idle.length ? m.idle.map(rowHtml).join("") : '<li class="row dim"><span class="name">none</span></li>') +
      "</ul></section>";
    var actions =
      '<section><h2>Actions <span class="n">' + m.actions.length + '</span> <small>newest first</small></h2><ul>' +
      (m.actions.length ? m.actions.map(actionHtml).join("") : '<li class="row dim"><span class="name">nothing yet</span></li>') +
      "</ul></section>";
    var stopped =
      '<details><summary>Not running <span class="n">' + m.stopped.length + "</span> <small>" + m.comesBack +
      " come back with Docker</small></summary><ul>" + m.stopped.map(stoppedHtml).join("") + "</ul></details>";
    return head + running + idle + actions + stopped;
  }

  return { esc: esc, quietWord: quietWord, ageWord: ageWord, laneWord: laneWord, ownerThread: ownerThread, parseActions: parseActions, model: model, render: render };
});
