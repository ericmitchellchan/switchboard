#!/bin/sh
# The machine watcher, Docker piece (SWIT-92). Runs forever in a docker:cli
# container with the Docker socket mounted (see mw.sh). Every MW_CHECK_SECONDS:
#
#   1. /state/containers.json — ONE row per container, running or not: image,
#      compose project, restart policy, CPU/memory, bytes moved since the last
#      check, and the time it last moved real traffic. The `machine` MCP tool
#      reads this file; a view can too.
#   2. /state/ledger.jsonl — one line per RUNNING container per check, so
#      `why is this running` has history. Trimmed to MW_LEDGER_MAX_LINES.
#   3. ONE policy: a running container that has moved no traffic for
#      MW_IDLE_MINUTES is stopped. DRY RUN BY DEFAULT — it logs what it would
#      stop and touches nothing until MW_DRY_RUN=false. Every stop (or would-
#      stop) is a line in /state/actions.jsonl naming the rule.
#
# Traffic, not CPU or logs, is the idle signal — the same measure the
# kyde-local reaper settled on: an idle container moves a few hundred bytes
# a minute, one real request moves KB. A container whose bytes cannot be read
# (no shell in the image, exec refused) is `traffic unknown` and NEVER stopped
# by this rule.
#
# Skipped, on purpose: the kyde-local compose project (its own reaper owns it,
# ~/bin/kyde-local-shared/kl.sh), the two reapers themselves, and the watcher's
# own page container (it moves almost no traffic).
#
# Two clock rules copied from that reaper: a (re)start of the watcher gives
# every container a full idle window before the rule can fire (traffic.tsv
# persists across restarts, so without this a Docker Desktop boot would stop a
# quiet `restart: always` container a minute after you sat down), and a hold
# (state/hold-until, `mw hold`) PAUSES the clock rather than muting the rule,
# so the tick after a hold ends stops nothing. The ledger is JSONL, not the
# ticket's SQLite — enough for this first piece.
set -u

check_seconds=${MW_CHECK_SECONDS:-60}
idle_minutes=${MW_IDLE_MINUTES:-120}
min_bytes=${MW_MIN_BYTES:-4096}
dry_run=${MW_DRY_RUN:-true}
start_grace=${MW_START_GRACE:-1}   # 0 only in tests: no idle window after start
skip_projects=${MW_SKIP_PROJECTS:-"kyde-local"}
skip_names=${MW_SKIP_NAMES:-"kyde-local-idle-reaper machine-watcher machine-page"}
ledger_max=${MW_LEDGER_MAX_LINES:-20000}
request_poll=${MW_REQUEST_POLL_SECONDS:-5}
request_max_age=${MW_REQUEST_MAX_AGE_MINUTES:-2}   # older page requests are refused as stale
state=/state
tmp=/tmp/mw
mkdir -p "$state" "$state/requests" "$tmp"
case $request_poll in
  '' | *[!0-9]* | 0) log "MW_REQUEST_POLL_SECONDS='$request_poll' is not a whole number of seconds (>= 1); exiting"; exit 1 ;;
esac
started=$(date +%s)

log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"; }

case $idle_minutes in
  '' | *[!0-9]*) log "MW_IDLE_MINUTES='$idle_minutes' is not a whole number; exiting"; exit 1 ;;
esac

# Epoch seconds mw.sh leaves in state/hold-until (0 if absent).
hold_until() {
  [ -f "$state/hold-until" ] || { echo 0; return; }
  v=$(tr -dc 0-9 <"$state/hold-until"); echo "${v:-0}"
}

# One line per container, every container, in ONE inspect call:
#   id|name|state|startedAt|restart|image|project|service|workdir
inspect_all() {
  ids=$(docker ps -aq)
  [ -z "$ids" ] && return
  docker inspect --format '{{printf "%.12s" .Id}}|{{.Name}}|{{.State.Status}}|{{.State.StartedAt}}|{{.HostConfig.RestartPolicy.Name}}|{{.Config.Image}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}' $ids 2>/dev/null
}

# id|cpu%|mem used MiB|mem limit MiB for running containers.
stats_running() {
  docker stats --no-stream --format '{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}' 2>/dev/null
}

# id bytes — in + out on every interface but loopback. A container without a
# readable /proc/net/dev prints nothing and is `traffic unknown`. Leading
# blanks are stripped first: the kernel pads the name to 6 chars, so a longer
# one (`docker0`, `ip6tnl0`) has none and the fields would shift by one.
bytes_running() {
  docker ps -q | while read -r id; do
    b=$(docker exec "$id" cat /proc/net/dev </dev/null 2>/dev/null |
      awk -F'[: ]+' '{ sub(/^[ \t]+/, "") } $1 != "lo" && NF > 9 { s += $2 + $10 } END { if (NR > 0) print s + 0 }')
    [ -n "$b" ] && echo "$(printf '%.12s' "$id") $b"
  done
}

# One request file → one docker stop (or a refusal), one actions.jsonl line, file
# gone. Sets served=1 when anything was handled so the caller takes a snapshot
# at once instead of waiting out the tick (the page reloads a few seconds after
# a request and should see the row gone, not a fresh stop button).
served=0
serve_requests() {
  [ -d "$state/requests" ] || return 0
  for f in "$state"/requests/*.stop; do
    [ -f "$f" ] || continue
    served=1
    name=${f##*/}; name=${name%.stop}
    at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    if ! printf '%s' "$name" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'; then
      log "page asked to stop an invalid name; refused"
      echo "{\"at\":\"$at\",\"name\":\"invalid\",\"action\":\"refused\",\"rule\":\"page stop\",\"reason\":\"not a container name\"}" >>"$state/actions.jsonl"
    elif [ -n "$(find "$f" -mmin +"$request_max_age" 2>/dev/null)" ]; then
      # Queued while the watcher was down (asleep, `mw down`, a crash): the page
      # said "stopping…" long ago and nothing happened; the container may since
      # have been started again on purpose. Never serve it late.
      log "page asked to stop $name more than ${request_max_age}m ago; refused (stale)"
      echo "{\"at\":\"$at\",\"name\":\"$name\",\"action\":\"refused\",\"rule\":\"page stop\",\"reason\":\"stale request\"}" >>"$state/actions.jsonl"
    elif case " $skip_names " in *" $name "*) true ;; *) false ;; esac; then
      log "page asked to stop $name; refused (a skipped container)"
      echo "{\"at\":\"$at\",\"name\":\"$name\",\"action\":\"refused\",\"rule\":\"page stop\",\"reason\":\"skipped container\"}" >>"$state/actions.jsonl"
    elif proj=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$name" 2>/dev/null) && [ -n "$proj" ] && case " $skip_projects " in *" $proj "*) true ;; *) false ;; esac; then
      # Same rule the page uses to hide the button: a skipped compose project (kyde-local) has its own reaper.
      log "page asked to stop $name; refused (project $proj has its own reaper)"
      echo "{\"at\":\"$at\",\"name\":\"$name\",\"action\":\"refused\",\"rule\":\"page stop\",\"reason\":\"skipped project\"}" >>"$state/actions.jsonl"
    elif docker stop "$name" >/dev/null 2>&1; then
      log "page asked to stop $name; stopped"
      echo "{\"at\":\"$at\",\"name\":\"$name\",\"action\":\"stopped\",\"rule\":\"page stop\"}" >>"$state/actions.jsonl"
    else
      log "page asked to stop $name; docker stop failed"
      echo "{\"at\":\"$at\",\"name\":\"$name\",\"action\":\"stop failed\",\"rule\":\"page stop\"}" >>"$state/actions.jsonl"
    fi
    rm -f "$f"
  done
}

log "watching every container: snapshot every ${check_seconds}s, idle rule ${idle_minutes}m without traffic, dry run: $dry_run, skipping projects [$skip_projects] names [$skip_names], page stop requests every ${request_poll}s"
touch "$state/traffic.tsv"

while :; do
  now=$(date +%s)
  now_iso=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  inspect_all >"$tmp/inspect"
  stats_running >"$tmp/stats"
  bytes_running >"$tmp/bytes"

  # One awk pass merges the four inputs and writes: the snapshot and the next
  # traffic.tsv (as dot-files INSIDE /state so the mv below is a rename on the
  # same mount — /tmp is another filesystem and a cross-mount mv is a copy a
  # reader can catch half-done), the ledger lines and the policy targets.
  # Files are told apart by FILENAME (busybox awk has no ARGIND). Byte counters
  # go through %.0f: busybox awk's %d clamps at 2^31-1, and a container that
  # has moved 2 GiB since it started would then look busy forever.
  awk -v now="$now" -v now_iso="$now_iso" -v idle="$idle_minutes" -v minb="$min_bytes" \
      -v hold="$(hold_until)" -v skipp=" $skip_projects " -v skipn=" $skip_names " -v dry="$dry_run" \
      -v boot="$started" -v grace="$start_grace" \
      -v out_snap="$state/.containers.json.tmp" -v out_traffic="$state/.traffic.tsv.tmp" \
      -v out_ledger="$tmp/ledger" -v out_targets="$tmp/targets" '
    # JSON-safe without escape sequences (awk replacement strings eat one level
    # of backslash and busybox differs on the rest): a Windows path reads fine
    # with forward slashes, and nothing here legitimately holds a quote.
    function esc(s) { gsub(/\\/, "/", s); gsub(/"/, "'"'"'", s); gsub(/[\t\r\n]/, " ", s); return s }
    function num(s) { gsub(/[^0-9.]/, "", s); return s + 0 }
    function mib(s,  v, u) { # "1.2GiB" / "512MiB" / "884KiB" / "800kB" / "512B" -> MiB
      v = s; gsub(/[^0-9.]/, "", v); v += 0; u = s; gsub(/[0-9. ]/, "", u)
      if (u ~ /^[Gg]/) return v * 1024; if (u ~ /^[Kk]/) return v / 1024; if (u ~ /^B/) return v / 1048576; return v
    }
    FILENAME == traffic_file { prev_bytes[$1] = $2; prev_moved[$1] = $3; next }
    FILENAME == stats_file { split($0, s, "|"); cpu[s[1]] = num(s[2]); split(s[3], m, " / "); mem[s[1]] = mib(m[1]); memlim[s[1]] = mib(m[2]); next }
    FILENAME == bytes_file { bytes[$1] = $2; known[$1] = 1; next }
    FILENAME == inspect_file {
      gsub(/<no value>/, "", $0)   # Go templates print this for a missing label
      split($0, f, "|"); id = f[1]; name = f[2]; sub(/^\//, "", name)
      n++; ids[n] = id; nm[id] = name; st[id] = f[3]; started[id] = f[4]; restart[id] = f[5]
      image[id] = f[6]; project[id] = f[7]; service[id] = f[8]; workdir[id] = f[9]
      next
    }
    END {
      printf "" > out_targets; printf "" > out_ledger; printf "" > out_traffic
      printf "{\"version\":1,\"sampledAt\":\"%s\",\"idleMinutes\":%d,\"dryRun\":%s,\"holdUntil\":%d,\"containers\":[", now_iso, idle, (dry == "true" ? "true" : "false"), hold > out_snap
      for (i = 1; i <= n; i++) {
        id = ids[i]; running = (st[id] == "running")
        skipped = (index(skipp, " " project[id] " ") > 0 && project[id] != "") || index(skipn, " " nm[id] " ") > 0
        moved = 0; tknown = 0; last = 0
        if (running && known[id]) {
          tknown = 1
          if (id in prev_bytes && bytes[id] >= prev_bytes[id]) moved = bytes[id] - prev_bytes[id]; else moved = bytes[id]
          last = prev_moved[id] + 0
          if (moved >= minb || last == 0) last = now   # first sight counts as use: someone just started it
          if (grace == "1" && last < boot) last = boot   # a full idle window after the watcher (re)starts
          if (hold > now) last = now                            # a hold pauses the clock
          printf "%s %.0f %d\n", id, bytes[id], last >> out_traffic
        }
        idlemin = (tknown && last > 0) ? int((now - last) / 60) : -1
        policy = ""
        if (running && !skipped && tknown && idlemin >= idle && hold <= now) {
          policy = (dry == "true") ? "would stop" : "stop"
          print nm[id] " " idlemin >> out_targets
        }
        printf "%s{\"id\":\"%s\",\"name\":\"%s\",\"project\":\"%s\",\"service\":\"%s\",\"image\":\"%s\",\"state\":\"%s\",\"restart\":\"%s\",\"startedAt\":\"%s\",\"workdir\":\"%s\",\"cpuPct\":%s,\"memMb\":%d,\"memLimitMb\":%d,\"movedBytes\":%.0f,\"trafficKnown\":%s,\"lastTrafficAt\":%s,\"idleMinutes\":%s,\"skipped\":%s,\"policy\":\"%s\"}", \
          (i > 1 ? "," : ""), id, esc(nm[id]), esc(project[id]), esc(service[id]), esc(image[id]), st[id], restart[id], started[id], esc(workdir[id]), \
          (running ? cpu[id] + 0 : 0), (running ? mem[id] : 0), (running ? memlim[id] : 0), moved, (tknown ? "true" : "false"), \
          (last > 0 ? "\"" strftime("%Y-%m-%dT%H:%M:%SZ", last, 1) "\"" : "null"), (idlemin >= 0 ? idlemin : "null"), (skipped ? "true" : "false"), policy >> out_snap
        if (running) printf "{\"at\":\"%s\",\"name\":\"%s\",\"cpuPct\":%s,\"memMb\":%d,\"movedBytes\":%.0f,\"idleMinutes\":%s}\n", now_iso, esc(nm[id]), cpu[id] + 0, mem[id], moved, (idlemin >= 0 ? idlemin : "null") >> out_ledger
      }
      printf "]}\n" >> out_snap
    }' traffic_file="$state/traffic.tsv" stats_file="$tmp/stats" bytes_file="$tmp/bytes" inspect_file="$tmp/inspect" \
      "$state/traffic.tsv" "$tmp/stats" "$tmp/bytes" "$tmp/inspect"

  mv "$state/.containers.json.tmp" "$state/containers.json"
  mv "$state/.traffic.tsv.tmp" "$state/traffic.tsv"
  cat "$tmp/ledger" >>"$state/ledger.jsonl"
  lines=$(wc -l <"$state/ledger.jsonl")
  if [ "$lines" -gt "$ledger_max" ]; then
    tail -n "$ledger_max" "$state/ledger.jsonl" >"$state/.ledger.jsonl.tmp" && mv "$state/.ledger.jsonl.tmp" "$state/ledger.jsonl"
  fi

  # The idle rule. A real stop is one line; a DRY-RUN "would stop" is logged
  # ONCE per idle spell (state/would-stop remembers who was reported and is
  # rewritten to the current targets each tick, so a container that moves
  # traffic again and later goes quiet is reported again) — without this a
  # dry run wrote the same line every minute.
  : >"$tmp/reported.next"
  while read -r name mins; do
    [ -z "$name" ] && continue
    if [ "$dry_run" = true ]; then
      echo "$name" >>"$tmp/reported.next"
      if ! grep -qxF "$name" "$state/would-stop" 2>/dev/null; then
        log "DRY RUN: $name moved no traffic for ${mins}m; would stop it (rule: idle > ${idle_minutes}m)"
        echo "{\"at\":\"$now_iso\",\"name\":\"$name\",\"action\":\"would stop\",\"rule\":\"idle > ${idle_minutes}m\",\"idleMinutes\":$mins}" >>"$state/actions.jsonl"
      fi
    else
      log "$name moved no traffic for ${mins}m; stopping it (rule: idle > ${idle_minutes}m)"
      if docker stop "$name" >/dev/null 2>&1; then
        echo "{\"at\":\"$now_iso\",\"name\":\"$name\",\"action\":\"stopped\",\"rule\":\"idle > ${idle_minutes}m\",\"idleMinutes\":$mins}" >>"$state/actions.jsonl"
      else
        log "docker stop $name failed"
      fi
    fi
  done <"$tmp/targets"
  cp "$tmp/reported.next" "$state/.would-stop.tmp" && mv "$state/.would-stop.tmp" "$state/would-stop"

  # Between ticks, serve STOP REQUESTS from the page (state/requests/<name>.stop,
  # written by panel/cgi-bin/stop) every REQUEST_POLL_SECONDS. The name is
  # re-checked here — grammar, and never one of the skipped names (the watcher,
  # its page, the reapers) — and every outcome is a line in actions.jsonl.
  # A served request ends the wait early: the next snapshot follows at once.
  # (A check interval shorter than the poll simply stretches the tick to one poll.)
  slept=0; served=0
  while [ "$slept" -lt "$check_seconds" ]; do
    serve_requests
    [ "$served" = 1 ] && break
    sleep "$request_poll"
    slept=$((slept + request_poll))
  done
done
