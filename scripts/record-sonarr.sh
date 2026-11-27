#!/usr/bin/env bash
# Records replies from your own Sonarr for the Sonarr plugin's tests, anonymised.
#
#   SONARR_URL=http://sonarr.local:8989 SONARR_KEY=… bash scripts/record-sonarr.sh
#
# It calls only the read-only routes the plugin reads (system/status, calendar, queue),
# then replaces series and episode titles, overviews, paths, release names, download
# hashes, clients, indexers, outside IDs and the instance name with placeholders before
# writing tests/sonarr/recorded/. tests/sonarr.test.mjs checks the plugin against those
# files when they exist. The key goes to curl on stdin, so it never shows in `ps`, and
# nothing it writes contains it. Look the files over before you commit them.
set -euo pipefail

url=${SONARR_URL:?Set SONARR_URL to your Sonarr address, such as http://sonarr.local:8989}
key=${SONARR_KEY:?Set SONARR_KEY to Sonarr’s API key (Settings › General › Security).}
url=${url%/}/
out=${OUT:-tests/sonarr/recorded}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

get() {
  printf 'X-Api-Key: %s\n' "$key" | curl -fsS --max-time 30 -H @- -H 'Accept: application/json' "$url$1" -o "$work/$2"
}

start=$(node -e 'console.log(new Date(Date.now() - 864e5).toISOString())')
end=$(node -e 'console.log(new Date(Date.now() + 15 * 864e5).toISOString())')
get "api/v3/system/status" status.json
get "api/v3/calendar?start=$start&end=$end&unmonitored=false&includeSeries=true&includeEpisodeFile=false&includeEpisodeImages=false" calendar.json
get "api/v3/queue?page=1&pageSize=50&includeSeries=true&includeEpisode=true" queue.json

mkdir -p "$out"
node - "$work" "$out" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [work, out] = process.argv.slice(2);
const read = name => JSON.parse(fs.readFileSync(path.join(work, name), 'utf8'));
const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');

// The same series is "Series 1" in every file.
const names = new Map();
const seriesName = s => {
  const key = s?.id ?? s?.title;
  if (!names.has(key)) names.set(key, 'Series ' + (names.size + 1));
  return names.get(key);
};
const releases = new Map();
const release = title => {
  if (!releases.has(title)) releases.set(title, 'Release ' + (releases.size + 1));
  return releases.get(title);
};

function series(s) {
  if (!s || typeof s !== 'object') return s;
  const name = seriesName(s);
  const slug = name.toLowerCase().replace(/ /g, '-');
  return {...s, title: name, sortTitle: name.toLowerCase(), cleanTitle: slug.replace(/-/g, ''), titleSlug: slug,
    overview: '', network: 'Network', path: '/tv/' + name, rootFolderPath: '/tv/', alternateTitles: [],
    tvdbId: 0, tvRageId: 0, tvMazeId: 0, tmdbId: 0, imdbId: '',
    images: (s.images || []).map(i => ({coverType: i.coverType, url: `/MediaCover/${s.id}/${i.coverType}.jpg`, remoteUrl: 'https://artworks.example/' + i.coverType + '.jpg'}))};
}
function episode(e) {
  if (!e || typeof e !== 'object') return e;
  const value = {...e, title: 'Episode ' + (e.episodeNumber ?? ''), overview: '', tvdbId: 0, images: []};
  if (e.series) value.series = series(e.series);
  return value;
}

const status = read('status.json');
write('system-status.json', {...status, instanceName: 'Sonarr', appData: '/config', startupPath: '/app',
  osName: 'linux', osVersion: '', packageAuthor: '', urlBase: ''});

write('calendar.json', read('calendar.json').map(episode));

const queue = read('queue.json');
write('queue.json', {...queue, records: (queue.records || []).map(r => {
  const name = release(r.title);
  const value = {...r, title: name, downloadId: name.replace(' ', '-').toLowerCase(), downloadClient: 'Download client',
    indexer: 'Indexer', series: series(r.series), episode: episode(r.episode),
    statusMessages: (r.statusMessages || []).map(m => ({title: name, messages: (m.messages || []).map(() => '(message removed)')}))};
  if (r.outputPath) value.outputPath = '/downloads/' + name;
  if (r.errorMessage) value.errorMessage = '(message removed)';
  return value;
})});
console.log(`Wrote ${out}: ${names.size} series, ${releases.size} downloads.`);
NODE

# The key must never reach a file.
if grep -rqF -f <(printf '%s\n' "$key") "$out"; then
  rm -rf "$out"
  echo "A reply echoed the API key, so nothing was kept." >&2
  exit 1
fi
