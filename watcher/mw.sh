#!/bin/bash
# mw — the machine watcher's host-side control (SWIT-92, Docker piece).
#
#   mw ensure          start the watcher container if it is not running (safe any time)
#   mw status          is it running, the last snapshot's age, its last log lines
#   mw hold [hours]    no idle-stops for N hours (default 2) — for a long test
#   mw log             the watcher's log (docker logs)
#   mw actions         what the idle rule stopped or would have stopped
#   mw live | mw dry   flip the idle rule between stopping and logging (restarts the container)
#   mw stop <name>     stop one container by hand, recorded like the MCP tool does
#   mw down            stop the watcher itself
#
# The watcher (docker-watch.sh) runs in a docker:cli container with the Docker
# socket, this folder (read-only) and the state dir mounted. State lives where
# the Switchboard app keeps its data — %LOCALAPPDATA%\switchboard\machine — so
# the `machine` MCP tool (handed SWITCHBOARD_MACHINE_DIR by the app) and this
# script read the same files. Same shape as ~/bin/kyde-local-shared/kl.sh.
set -euo pipefail
# Git Bash rewrites `/var/run/docker.sock` into a C:\Program Files\Git\... path
# before docker sees it; this keeps the container-side paths as written.
export MSYS_NO_PATHCONV=1

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
name=${MW_NAME:-machine-watcher}
data=${MW_DATA_DIR:-"${LOCALAPPDATA:-$HOME/.local/share}/switchboard/machine"}
mode_file=$data/mode   # "live" or absent (= dry run)

hostpath() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = true ]; }
dry_run() { if [ -f "$mode_file" ] && [ "$(tr -d '[:space:]' <"$mode_file")" = live ]; then echo false; else echo true; fi; }

start() {
  mkdir -p "$data"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --restart unless-stopped \
    -e MW_DRY_RUN="$(dry_run)" \
    -e MW_IDLE_MINUTES="${MW_IDLE_MINUTES:-120}" \
    -e MW_CHECK_SECONDS="${MW_CHECK_SECONDS:-60}" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$(hostpath "$here"):/mw:ro" \
    -v "$(hostpath "$data"):/state" \
    docker:28-cli sh -c "tr -d '\r' < /mw/docker-watch.sh > /tmp/w.sh && exec sh /tmp/w.sh" >/dev/null
  echo "$name running: snapshot every ${MW_CHECK_SECONDS:-60}s, idle rule ${MW_IDLE_MINUTES:-120}m, dry run: $(dry_run)"
  echo "state: $data"
}

cmd_ensure() { if running; then echo "$name is running"; else start; fi; }

cmd_status() {
  if running; then echo "watcher: running (dry run: $(dry_run))"; else echo "watcher: not running (mw ensure)"; fi
  if [ -f "$data/containers.json" ]; then
    local at; at=$(grep -o '"sampledAt":"[^"]*"' "$data/containers.json" | head -1 | cut -d'"' -f4)
    echo "snapshot: $at ($(grep -o '"name":' "$data/containers.json" | wc -l | tr -d ' ') containers)"
  else
    echo "snapshot: none yet"
  fi
  if [ -f "$data/hold-until" ]; then
    local held now; held=$(tr -dc 0-9 <"$data/hold-until"); now=$(date +%s)
    [ "${held:-0}" -gt "$now" ] && echo "hold:   $(((held - now) / 60))m left"
  fi
  running && docker logs --tail 5 "$name" 2>&1 | sed 's/^/  | /'
  return 0
}

cmd_hold() {
  local hours=${1:-2}
  [[ $hours =~ ^[0-9]+$ ]] || { echo "usage: mw hold [whole hours]" >&2; exit 2; }
  mkdir -p "$data"
  echo $(($(date +%s) + hours * 3600)) >"$data/hold-until"
  echo "the idle rule will stop nothing for the next ${hours}h"
}

cmd_stop() {
  local target=${1:-}
  [ -n "$target" ] || { echo "usage: mw stop <container name>" >&2; exit 2; }
  docker stop "$target" >/dev/null
  mkdir -p "$data"
  echo "{\"at\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\",\"name\":\"$target\",\"action\":\"stopped\",\"rule\":\"mw stop\",\"threadId\":\"\"}" >>"$data/actions.jsonl"
  echo "stopped $target (recorded)"
}

cmd_mode() {
  mkdir -p "$data"
  if [ "$1" = live ]; then echo live >"$mode_file"; else rm -f "$mode_file"; fi
  echo "idle rule: $([ "$1" = live ] && echo 'LIVE — it stops' || echo 'dry run — it logs')"
  start
}

case ${1:-} in
  ensure) cmd_ensure ;;
  status) cmd_status ;;
  hold) shift; cmd_hold "$@" ;;
  log) docker logs --tail "${2:-40}" "$name" 2>&1 ;;
  actions) if [ -f "$data/actions.jsonl" ]; then tail -n "${2:-20}" "$data/actions.jsonl"; else echo "no actions yet"; fi ;;
  live) cmd_mode live ;;
  dry) cmd_mode dry ;;
  stop) shift; cmd_stop "$@" ;;
  down) docker rm -f "$name" >/dev/null 2>&1 && echo "$name stopped" || echo "$name was not running" ;;
  *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
