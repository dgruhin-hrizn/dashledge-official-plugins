#!/usr/bin/env bash
# Records replies from your own Radarr for the Radarr plugin's tests, with anything
# personal replaced by placeholders, into tests/radarr/recorded/.
#
#   RADARR_URL=http://radarr.local:7878/ RADARR_KEY=… bash scripts/record-radarr.sh
#
# It calls only the read-only routes the plugin reads: api/v3/system/status, api/v3/queue
# and api/v3/calendar. The key goes to curl in a header read from a pipe, so it never
# appears in the process list, and the script checks that no output contains it.
# Needs curl and jq. Read the files before you commit them.
set -euo pipefail

url=${RADARR_URL:?Set RADARR_URL to your Radarr address, such as http://radarr.local:7878/}
: "${RADARR_KEY:?Set RADARR_KEY to your Radarr API key (Settings → General → Security).}"
url=${url%/}/
out=$(cd "$(dirname "$0")/.." && pwd)/tests/radarr/recorded
mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The plugin's calendar window: 14 days back to 61 ahead, as UTC dates (BSD or GNU date).
day() { date -u -v"$1"d +%F 2>/dev/null || date -u -d "$1 days" +%F; }
start=$(day -14)
end=$(day +61)

get() {
  curl -fsS --max-time 30 -H @<(printf 'X-Api-Key: %s\n' "$RADARR_KEY") -H 'Accept: application/json' "$url$1" > "$work/$2" \
    || { echo "Radarr didn't answer $1 (wrong URL or key?)" >&2; exit 1; }
}
get 'api/v3/system/status' status.json
get 'api/v3/queue?page=1&pageSize=50&includeMovie=true' queue.json
get "api/v3/calendar?start=$start&end=$end&unmonitored=false" calendar.json

# Placeholders for everything that names, locates or fingerprints the user's library.
scrub='
  # A path in a message runs to its end and may hold spaces, so cut from where it starts.
  def redact: if type == "string" then sub("(?:[A-Za-z]:\\\\|/).*$"; "/path") else . end;
  def movie: (.id | tostring) as $id
    | .title = "Movie \($id)" | .originalTitle = .title | .sortTitle = "movie \($id)" | .cleanTitle = "movie\($id)"
    | .overview = "" | .website = "" | .youTubeTrailerId = "" | .studio = "Studio"
    | .path = "/movies/Movie \($id)" | .folderName = .path | .rootFolderPath = "/movies/"
    | .imdbId = "tt0000\($id)" | .tmdbId = (900000 + .id) | .titleSlug = "\(900000 + .id)"
    | .alternateTitles = [] | .tags = []
    | if .images then .images |= map(.url = "/MediaCover/\($id)/\(.coverType).jpg" | .remoteUrl = "https://image.tmdb.org/t/p/original/placeholder.jpg") else . end
    | if .statistics then .statistics.releaseGroups = [] else . end
    | del(.collection, .movieFile);
'
jq "$scrub"'
  .instanceName = "Radarr (recorded)" | .startupPath = "/app" | .appData = "/config"
  | .osName = "linux" | .osVersion = "" | .urlBase = "" | .packageAuthor = ""
' "$work/status.json" > "$out/system-status.json"
jq "$scrub"'
  .records |= map((.id | tostring) as $id
    | .title = "Release \($id)" | .downloadId = "PLACEHOLDER\($id)" | .outputPath = "/downloads/Release \($id)"
    | .downloadClient = (if .downloadClient then "Download client" else .downloadClient end)
    | .indexer = (if .indexer then "Indexer" else .indexer end)
    | .errorMessage |= redact
    | .statusMessages |= ((. // []) | map(.title = "Release \($id)" | .messages |= ((. // []) | map(redact))))
    | if .movie then .movie |= movie else . end)
' "$work/queue.json" > "$out/queue.json"
jq "$scrub"'map(movie)' "$work/calendar.json" > "$out/calendar.json"

if grep -rqF -- "$RADARR_KEY" "$out"; then
  rm -f "$out"/*.json
  echo "A reply echoed the API key, so nothing was written." >&2
  exit 1
fi
echo "Wrote $(ls "$out" | wc -l | tr -d ' ') replies to tests/radarr/recorded/: $(jq '.records | length' "$out/queue.json") queued, $(jq length "$out/calendar.json") in the calendar."
echo "Read them before committing, then run: node --test tests/radarr.test.mjs"
