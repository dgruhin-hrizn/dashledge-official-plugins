#!/usr/bin/env bash
# Records real replies from your own download clients for the Downloads tests, with
# everything personal replaced: names, categories, IDs, hashes and paths. Only read-only
# routes are called, never one that returns a client's settings.
#
# Set the clients you have, then run it from the repository root:
#   SABNZBD_URL=http://sabnzbd.local:8080/ SABNZBD_KEY=…  \
#   NZBGET_URL=http://nzbget.local:6789/ NZBGET_USER=… NZBGET_PASS=…  \
#   QBT_URL=http://qbittorrent.local:8080/ QBT_USER=… QBT_PASS=…  \
#   bash scripts/record-download-clients.sh
#
# Credentials go to curl on stdin, never on its command line. Replies are written to
# tests/download-clients/recorded/. Read them before you commit: the tests then check that
# every recorded reply turns into a well-formed reading.
set -euo pipefail

out=tests/download-clients/recorded
mkdir -p "$out"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
recorded=0

# curl with its URL and any secret options read from stdin (-K -), so they stay out of `ps`.
fetch() { curl -sS --fail --max-time 20 -K - "$@"; }
slash() { case "$1" in */) printf '%s' "$1" ;; *) printf '%s/' "$1" ;; esac; }

if [ -n "${SABNZBD_URL:-}" ] && [ -n "${SABNZBD_KEY:-}" ]; then
  base=$(slash "$SABNZBD_URL")
  printf 'url = "%sapi?mode=queue&output=json&limit=40&apikey=%s"\n' "$base" "$SABNZBD_KEY" | fetch > "$tmp/sq.json"
  printf 'url = "%sapi?mode=history&output=json&limit=20&apikey=%s"\n' "$base" "$SABNZBD_KEY" | fetch > "$tmp/sh.json"
  jq '{queue: (.queue | {version, paused, pause_int, status, speedlimit, noofslots_total, noofslots, limit, start, timeleft, speed, kbpersec, size, sizeleft, mb, mbleft,
        slots: [.slots | to_entries[] | .value as $s | {index: .key, nzo_id: "SABnzbd_nzo_q\(.key + 1)", priority: $s.priority, filename: "Download \(.key + 1)",
          cat: (if $s.cat == "*" then "*" else "category" end), mbleft: $s.mbleft, mb: $s.mb, size: $s.size, sizeleft: $s.sizeleft,
          percentage: $s.percentage, status: $s.status, timeleft: $s.timeleft}]})}' "$tmp/sq.json" > "$out/sabnzbd-queue.json"
  jq '{history: {noofslots: .history.noofslots, slots: [.history.slots | to_entries[] | .value as $s | {nzo_id: "SABnzbd_nzo_h\(.key + 1)", name: "Finished \(.key + 1)",
        category: (if $s.category == "*" then "*" else "category" end), status: $s.status, bytes: $s.bytes, completed: $s.completed,
        fail_message: (if ($s.fail_message // "") == "" then "" else "Failed" end)}]}}' "$tmp/sh.json" > "$out/sabnzbd-history.json"
  echo "SABnzbd: recorded"; recorded=$((recorded + 1))
fi

if [ -n "${NZBGET_URL:-}" ] && [ -n "${NZBGET_USER:-}" ]; then
  base=$(slash "$NZBGET_URL")
  # Escaped for curl's config syntax: a backslash or quote in the password stays literal.
  login=$(jq -rn '(env.NZBGET_USER + ":" + (env.NZBGET_PASS // "")) | gsub("\\\\"; "\\\\") | gsub("\""; "\\\"")')
  for method in status listgroups history; do
    params='[]'; [ "$method" = listgroups ] && params='[0]'; [ "$method" = history ] && params='[false]'
    printf 'url = "%sjsonrpc"\nuser = "%s"\n' "$base" "$login" |
      fetch -H 'Content-Type: application/json' --data "{\"version\":\"1.1\",\"id\":1,\"method\":\"$method\",\"params\":$params}" > "$tmp/n-$method.json"
  done
  jq '{version, id, result: (.result | with_entries(select(.value | type == "number" or type == "boolean")))}' "$tmp/n-status.json" > "$out/nzbget-status.json"
  jq '{version, id, result: [.result | to_entries[] | .value as $g | {NZBID: (1000 + .key), NZBName: "Download \(.key + 1)", Kind: $g.Kind,
        Category: (if ($g.Category // "") == "" then "" else "category" end), FileSizeLo: $g.FileSizeLo, FileSizeHi: $g.FileSizeHi, FileSizeMB: $g.FileSizeMB,
        RemainingSizeLo: $g.RemainingSizeLo, RemainingSizeHi: $g.RemainingSizeHi, RemainingSizeMB: $g.RemainingSizeMB,
        PausedSizeLo: $g.PausedSizeLo, PausedSizeHi: $g.PausedSizeHi, PausedSizeMB: $g.PausedSizeMB, ActiveDownloads: $g.ActiveDownloads,
        Status: $g.Status, MaxPriority: $g.MaxPriority, PostStageProgress: $g.PostStageProgress, PostTotalTimeSec: $g.PostTotalTimeSec, Health: $g.Health}]}' \
    "$tmp/n-listgroups.json" > "$out/nzbget-listgroups.json"
  jq '{version, id, result: [.result[:20] | to_entries[] | .value as $h | {NZBID: (2000 + .key), Name: "Finished \(.key + 1)", Kind: $h.Kind, Status: $h.Status,
        HistoryTime: $h.HistoryTime, FileSizeLo: $h.FileSizeLo, FileSizeHi: $h.FileSizeHi, FileSizeMB: $h.FileSizeMB,
        Category: (if ($h.Category // "") == "" then "" else "category" end)}]}' "$tmp/n-history.json" > "$out/nzbget-history.json"
  echo "NZBGet: recorded"; recorded=$((recorded + 1))
fi

if [ -n "${QBT_URL:-}" ] && [ -n "${QBT_USER:-}" ]; then
  base=$(slash "$QBT_URL")
  form=$(jq -rn '"username=\(env.QBT_USER | @uri)&password=\(env.QBT_PASS // "" | @uri)"')
  printf 'url = "%sapi/v2/auth/login"\ndata = "%s"\n' "$base" "$form" | fetch -c "$tmp/jar" -o "$tmp/login.txt"
  grep -q '^Ok' "$tmp/login.txt" || { echo "qBittorrent refused the sign-in" >&2; exit 1; }
  printf 'url = "%sapi/v2/sync/maindata?rid=0"\n' "$base" | fetch -b "$tmp/jar" > "$tmp/qm.json"
  jq '{rid: 1, full_update: true,
        torrents: ([.torrents | to_entries[] ] | to_entries | map(.key as $i | .value.value as $t | {
          key: ("0000000000000000000000000000000000000000\($i + 1)"[-40:]),
          value: {name: "Torrent \($i + 1)", progress: $t.progress, size: $t.size, total_size: $t.total_size, amount_left: $t.amount_left,
            dlspeed: $t.dlspeed, upspeed: $t.upspeed, eta: $t.eta, state: $t.state, category: (if ($t.category // "") == "" then "" else "category" end),
            added_on: $t.added_on, completion_on: $t.completion_on, priority: $t.priority, num_seeds: $t.num_seeds, num_leechs: $t.num_leechs}}) | from_entries),
        server_state: (.server_state | {dl_info_speed, up_info_speed, connection_status, use_alt_speed_limits, queueing, dl_rate_limit, up_rate_limit})}' \
    "$tmp/qm.json" > "$out/qbittorrent-maindata-full.json"
  printf 'url = "%sapi/v2/auth/logout"\n' "$base" | fetch -b "$tmp/jar" -X POST -o /dev/null || true
  echo "qBittorrent: recorded"; recorded=$((recorded + 1))
fi

[ "$recorded" -gt 0 ] || { echo "Set SABNZBD_URL and SABNZBD_KEY, NZBGET_URL and NZBGET_USER, or QBT_URL and QBT_USER." >&2; exit 1; }
echo "Wrote $out. Read the files, then run: node --test tests/download-clients.test.mjs"
