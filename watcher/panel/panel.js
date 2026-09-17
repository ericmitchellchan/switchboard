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

  /** The view model. `stale` = the watcher has missed at least three ticks. */
  function model(snapshot, actions, nowMs) {
    var rows = (snapshot && snapshot.containers) || [];
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
      holdUntil: held ? new Date(snapshot.holdUntil * 1000).toISOString().slice(11, 16) + "Z" : "",
      idleMinutes: snapshot ? snapshot.idleMinutes : 0,
      running: running,
      idle: idle,
      stopped: stopped,
      comesBack: stopped.filter(comesBack).length,
      actions: (actions || []).slice(0, 10),
    };
  }

  function rowHtml(r) {
    var meta = [];
    if (r.project) meta.push(esc(r.project));
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
      "</li>"
    );
  }

  function stoppedHtml(r) {
    return (
      '<li class="row dim"><span class="name">' + esc(r.name) + "</span>" +
      '<span class="meta">' + esc(r.project || "") + "</span>" +
      '<span class="quiet">' + esc(r.state) + (comesBack(r) ? " · comes back with Docker" : "") + "</span></li>"
    );
  }

  function actionHtml(a) {
    var at = String(a.at || "").slice(5, 16).replace("T", " ");
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

  return { esc: esc, quietWord: quietWord, ageWord: ageWord, parseActions: parseActions, model: model, render: render };
});
