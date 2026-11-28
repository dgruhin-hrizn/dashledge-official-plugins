#!/usr/bin/env bash
# Records replies from your own Frigate for the Frigate plugin's tests, stripped down.
#
#   FRIGATE_URL=http://frigate.local:5000 bash scripts/record-frigate.sh
#   FRIGATE_URL=https://frigate.local:8971 FRIGATE_USER=admin FRIGATE_PASSWORD=… bash scripts/record-frigate.sh
#
# It calls only the read-only routes the plugin reads (stats, config, go2rtc/streams,
# events), then keeps just the fields the plugin uses. Camera inputs (RTSP addresses and
# their passwords), MQTT, go2rtc's own config, environment variables, SDP, client
# addresses and event thumbnails never reach the files. With FRIGATE_USER it signs in on
# api/login first; the password goes to curl on stdin, so it never shows in `ps`, and
# nothing written contains it or the session cookie. Look the files over before you
# commit them.
set -euo pipefail

url=${FRIGATE_URL:?Set FRIGATE_URL to your Frigate address, such as http://frigate.local:5000}
url=${url%/}/
out=${OUT:-tests/frigate}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
jar="$work/cookies"
insecure=()
[ "${FRIGATE_INSECURE:-}" = 1 ] && insecure=(-k)

if [ -n "${FRIGATE_USER:-}" ]; then
  password=${FRIGATE_PASSWORD:?Set FRIGATE_PASSWORD with FRIGATE_USER.}
  node -e 'process.stdout.write(JSON.stringify({user: process.argv[1], password: process.argv[2]}))' "$FRIGATE_USER" "$password" \
    | curl -fsS ${insecure[@]+"${insecure[@]}"} --max-time 30 -c "$jar" -H 'Content-Type: application/json' --data-binary @- "${url}api/login" -o /dev/null
fi

get() {
  curl -fsS ${insecure[@]+"${insecure[@]}"} --max-time 30 -b "$jar" -H 'Accept: application/json' "$url$1" -o "$work/$2"
}

after=$(node -e 'console.log(Math.floor(Date.now() / 1000) - 6 * 3600)')
get "api/stats" stats.json
get "api/config" config.json
get "api/go2rtc/streams" go2rtc-streams.json
get "api/events?limit=40&after=$after&include_thumbnails=0" events.json

mkdir -p "$out"
node - "$work" "$out" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [work, out] = process.argv.slice(2);
const read = name => JSON.parse(fs.readFileSync(path.join(work, name), 'utf8'));
const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
const pick = (object, keys) => Object.fromEntries(keys.filter(k => object && k in object).map(k => [k, object[k]]));

const stats = read('stats.json');
write('stats.json', {
  cameras: Object.fromEntries(Object.entries(stats.cameras || {}).map(([name, c]) =>
    [name, pick(c, ['camera_fps', 'process_fps', 'skipped_fps', 'detection_fps', 'detection_enabled'])])),
  detection_fps: stats.detection_fps,
  service: {...pick(stats.service, ['uptime', 'version', 'latest_version', 'last_updated'])},
});

const config = read('config.json');
write('config.json', {
  version: config.version ?? null,
  auth: pick(config.auth, ['enabled']),
  birdseye: pick(config.birdseye, ['enabled', 'restream', 'width', 'height', 'mode']),
  ui: pick(config.ui, ['time_format', 'date_style', 'time_style']),
  cameras: Object.fromEntries(Object.entries(config.cameras || {}).map(([name, c]) => [name, {
    ...pick(c, ['name', 'friendly_name', 'enabled', 'enabled_in_config', 'live', 'ui']),
    detect: pick(c.detect, ['enabled', 'width', 'height', 'fps']),
    ffmpeg: {inputs: (c.ffmpeg?.inputs || []).map(i => ({path: 'rtsp://camera.invalid/stream', roles: i.roles}))},
  }])),
});

// go2rtc reports each stream's producers with their URLs (camera passwords) and SDP.
// Keep the stream names and each producer's media lines.
const streams = read('go2rtc-streams.json');
write('go2rtc-streams.json', Object.fromEntries(Object.entries(streams).map(([name, s]) => [name, {
  producers: (s?.producers || []).map(p => ({type: p.type, medias: p.medias || []})),
}])));

let n = 0;
write('events.json', read('events.json').map(e => ({
  id: `1790000000.${String(++n).padStart(6, '0')}-rec${n}`,
  ...pick(e, ['camera', 'label', 'sub_label', 'start_time', 'end_time', 'has_clip', 'has_snapshot', 'top_score', 'false_positive']),
  zones: [],
  data: pick(e.data, ['score', 'top_score', 'type']),
})));
console.log('Wrote ' + out + ': stats.json, config.json, go2rtc-streams.json, events.json');
NODE
