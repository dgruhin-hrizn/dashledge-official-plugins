// Sonarr: upcoming episodes and the download queue from the placement's Sonarr server.
//
// One connector runs per connection and serves every placement that uses it. It reads
// three of Sonarr's v3 routes, slims each reply to what the views draw, and emits them
// together. Per-placement choices (how many days ahead, hiding downloaded episodes) stay
// in the view, so the calendar is read for the longest window a placement can ask for.
// Views say they're on screen with the `watch` command; with nobody watching for a while
// the connector stops polling until one asks again.
//
// Dashledge adds the API key to every request on the connection. This file never sees it
// and never sets the X-Api-Key header.

const STATUS_EVERY = 30 * 60 * 1000;
const CALENDAR_EVERY = 5 * 60 * 1000;
const QUEUE_BUSY_EVERY = 10 * 1000;
const QUEUE_IDLE_EVERY = 30 * 1000;
const FORGET_AFTER = 15 * 60 * 1000;
const SEARCH_SHOWN = 3 * 60 * 1000;
const TICK = 5 * 1000;
const DAY = 24 * 60 * 60 * 1000;
// Placements look up to 14 days ahead, counting today in their own time zone.
const BEHIND = DAY, AHEAD = 15 * DAY;
const MAX_EPISODES = 120;
const QUEUE_PAGE = 50;
const TEXT = 200;

const connection = dashledge.connection;
const base = connection ? connection.address : '';

// ---- Shaping Sonarr's replies -------------------------------------------------------

const str = (v, max = TEXT) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = v => (Number.isInteger(v) ? v : null);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// "1.02:03:04", "02:03:04" or "00:12:30.5" (a .NET TimeSpan) in seconds, or null.
function timeLeft(value) {
  const m = typeof value === 'string' && value.match(/^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
  if (!m) return null;
  return Number(m[1] || 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

function episode(e) {
  if (!e || !int(e.id) || !int(e.seriesId) || typeof e.airDateUtc !== 'string') return null;
  return {
    id: e.id, seriesId: e.seriesId,
    series: str(e.series?.title) || 'Unknown series',
    season: int(e.seasonNumber) ?? 0, episode: int(e.episodeNumber) ?? 0,
    title: str(e.title), airDateUtc: e.airDateUtc,
    hasFile: e.hasFile === true, monitored: e.monitored !== false,
    finale: str(e.finaleType, 16),
  };
}

function calendar(json) {
  if (!Array.isArray(json)) throw new Error('Sonarr sent a calendar that isn’t a list');
  return json.map(episode).filter(Boolean)
    .sort((a, b) => a.airDateUtc.localeCompare(b.airDateUtc) || a.id - b.id)
    .slice(0, MAX_EPISODES);
}

// What a queue record is doing, from Sonarr's status, tracked state and tracked status.
function queueState(r) {
  const status = String(r.status || '').toLowerCase();
  const tracked = String(r.trackedDownloadStatus || '').toLowerCase();
  const state = String(r.trackedDownloadState || '').toLowerCase();
  if (tracked === 'error' || status === 'failed' || state === 'failed' || state === 'failedpending') return 'failed';
  if (tracked === 'warning' || status === 'warning' || status === 'downloadclientunavailable') return 'warning';
  if (state === 'importpending') return 'importPending';
  if (state === 'importing') return 'importing';
  if (state === 'imported') return 'imported';
  if (['paused', 'queued', 'delay', 'completed', 'downloading'].includes(status)) return status;
  return 'downloading';
}

// The first thing Sonarr says is wrong with a record, if anything.
function queueMessage(r) {
  const first = Array.isArray(r.statusMessages) ? r.statusMessages.find(m => m && Array.isArray(m.messages) && m.messages.length) : null;
  return str(first?.messages[0], 160) || str(r.errorMessage, 160);
}

// Sonarr lists a season pack once per episode, every record sharing its downloadId.
// The view shows one row per download.
function queue(json) {
  const records = Array.isArray(json?.records) ? json.records : null;
  if (!records) throw new Error('Sonarr sent a queue without records');
  const rows = new Map();
  for (const r of records) {
    if (!r || !int(r.id)) continue;
    const key = str(r.downloadId, 120) || 'queue-' + r.id;
    let row = rows.get(key);
    if (!row) {
      const size = num(r.size), left = num(r.sizeleft);
      row = {
        key: 'q' + r.id, seriesId: int(r.seriesId) ?? int(r.series?.id),
        series: str(r.series?.title) || 'Unknown series',
        episodes: [],
        progress: size && size > 0 && left !== null ? Math.min(1, Math.max(0, 1 - left / size)) : null,
        timeLeft: timeLeft(r.timeleft), state: queueState(r), message: queueMessage(r),
        protocol: r.protocol === 'torrent' ? 'torrent' : 'usenet',
      };
      rows.set(key, row);
    }
    const id = int(r.episodeId) ?? int(r.episode?.id);
    if (id && row.episodes.length < 40 && !row.episodes.some(e => e.id === id)) {
      row.episodes.push({id, season: int(r.episode?.seasonNumber) ?? int(r.seasonNumber) ?? 0,
        episode: int(r.episode?.episodeNumber) ?? 0, title: str(r.episode?.title)});
    }
  }
  const items = [...rows.values()];
  for (const row of items) row.episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  const total = int(json.totalRecords) ?? records.length;
  return {items, total, more: Math.max(0, total - records.length)};
}

const serverStatus = json => ({instanceName: str(json?.instanceName, 80), version: str(json?.version, 40)});

// ---- Requests -------------------------------------------------------------------------

class SonarrError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

async function getJson(path) {
  let response;
  try {
    response = await fetch(base + path, {headers: {accept: 'application/json'}});
  } catch (error) {
    throw new SonarrError('network', 'Sonarr didn’t answer: ' + str(String(error?.message || error), 120));
  }
  if (response.status === 401 || response.status === 403) {
    throw new SonarrError('auth', 'Sonarr refused the API key (HTTP ' + response.status + ')');
  }
  if (!response.ok) throw new SonarrError('http', 'Sonarr answered HTTP ' + response.status);
  try {
    return await response.json();
  } catch {
    // A reverse proxy's sign-in page, for example.
    throw new SonarrError('http', 'Sonarr’s reply wasn’t JSON. Check the Sonarr URL.');
  }
}

// ---- State ----------------------------------------------------------------------------

const feed = () => ({state: 'loading', at: 0, error: '', kind: '', failures: 0, next: 0, busy: false});
const feeds = {status: feed(), calendar: feed(), queue: feed()};
let info = null, episodes = null, downloads = null;
const searches = new Map();
let heard = Date.now(), saved = '';

// The last good reading, so a restart shows something at once.
(function restore() {
  const last = dashledge.storage.get('last');
  if (!last || !connection || last.address !== base) return;
  info = last.status || null;
  if (Array.isArray(last.calendar?.items)) { episodes = last.calendar.items; feeds.calendar.at = last.calendar.at || 0; }
  if (Array.isArray(last.queue?.items)) {
    downloads = {items: last.queue.items, total: last.queue.total || 0, more: last.queue.more || 0};
    feeds.queue.at = last.queue.at || 0;
  }
})();

function remember() {
  const last = {address: base, status: info,
    calendar: episodes ? {items: episodes, at: feeds.calendar.at} : null,
    queue: downloads ? {...downloads, at: feeds.queue.at} : null};
  const text = JSON.stringify(last);
  if (text !== saved) { saved = text; dashledge.storage.set('last', last); }
}

const feedView = f => ({state: f.state, at: f.at, error: f.error, kind: f.kind});

function snapshot() {
  if (!connection) return {connected: false};
  const now = Date.now();
  for (const [id, at] of searches) if (now - at > SEARCH_SHOWN) searches.delete(id);
  return {
    connected: true,
    status: info,
    calendar: {...feedView(feeds.calendar), items: episodes},
    queue: {...feedView(feeds.queue), items: downloads?.items ?? null, total: downloads?.total ?? 0, more: downloads?.more ?? 0},
    searching: [...searches.keys()],
  };
}

const publish = () => dashledge.emit(snapshot());

// After `failures` failures in a row: 30 s, 1, 2, 5, then 10 minutes.
const retryDelay = failures => [30, 60, 120, 300, 600][Math.min(Math.max(failures, 1), 5) - 1] * 1000;

function calendarPath(now) {
  const start = new Date(now - BEHIND).toISOString(), end = new Date(now + AHEAD).toISOString();
  return 'api/v3/calendar?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end) +
    '&unmonitored=false&includeSeries=true&includeEpisodeFile=false&includeEpisodeImages=false';
}
const QUEUE_PATH = 'api/v3/queue?page=1&pageSize=' + QUEUE_PAGE + '&includeSeries=true&includeEpisode=true';

const readers = {
  async status() {
    info = serverStatus(await getJson('api/v3/system/status'));
    return STATUS_EVERY;
  },
  async calendar() {
    episodes = calendar(await getJson(calendarPath(Date.now())));
    return CALENDAR_EVERY;
  },
  async queue() {
    const before = new Set((downloads?.items || []).flatMap(row => row.episodes.map(e => e.id)));
    downloads = queue(await getJson(QUEUE_PATH));
    const now = new Set(downloads.items.flatMap(row => row.episodes.map(e => e.id)));
    for (const id of now) searches.delete(id);
    // A download that left the queue was probably imported: read the calendar again soon,
    // so its episode shows as downloaded.
    if ([...before].some(id => !now.has(id))) feeds.calendar.next = Math.min(feeds.calendar.next, Date.now() + TICK);
    return downloads.items.length ? QUEUE_BUSY_EVERY : QUEUE_IDLE_EVERY;
  },
};

async function update(name) {
  const f = feeds[name];
  f.busy = true;
  try {
    const every = await readers[name]();
    Object.assign(f, {state: 'ready', at: Date.now(), error: '', kind: '', failures: 0, next: Date.now() + every});
    remember();
  } catch (error) {
    // Keep the last good reading: the view shows it as stale, with its age.
    f.failures += 1;
    Object.assign(f, {state: 'error', error: str(String(error?.message || error), 160), kind: error?.kind || 'http',
      next: Date.now() + retryDelay(f.failures)});
  } finally {
    f.busy = false;
    publish();
  }
}

function due(force = false) {
  if (!connection) return;
  const now = Date.now();
  if (!force && now - heard > FORGET_AFTER) return;
  for (const name of Object.keys(feeds)) {
    const f = feeds[name];
    if (!f.busy && (force || f.next <= now)) update(name);
  }
}

// ---- Commands -------------------------------------------------------------------------

// The view sends {refresh?} when it appears and every few minutes while it's on screen.
// `refresh` reads everything now (Retry). Answers with what this connector knows.
dashledge.onCommand('watch', args => {
  heard = Date.now();
  if (args?.refresh) for (const f of Object.values(feeds)) { f.next = 0; f.failures = 0; }
  due();
  return snapshot();
});

// {episodeId}: ask Sonarr to search for one episode that has aired, is monitored and is
// missing. Only episodes this connector listed qualify.
dashledge.onCommand('search', async args => {
  const id = args?.episodeId;
  if (!connection) return {ok: false, error: 'No Sonarr connection'};
  const e = Number.isInteger(id) && id > 0 ? (episodes || []).find(x => x.id === id) : null;
  if (!e) return {ok: false, error: 'That episode isn’t in Sonarr’s calendar'};
  if (e.hasFile || !e.monitored || Date.parse(e.airDateUtc) > Date.now()) {
    return {ok: false, error: 'Only a missing episode that has aired can be searched'};
  }
  let response;
  try {
    response = await fetch(base + 'api/v3/command', {method: 'POST',
      headers: {'content-type': 'application/json', accept: 'application/json'},
      body: JSON.stringify({name: 'EpisodeSearch', episodeIds: [id]})});
  } catch (error) {
    return {ok: false, error: 'Sonarr didn’t answer: ' + str(String(error?.message || error), 120)};
  }
  if (response.status === 401 || response.status === 403) return {ok: false, error: 'Sonarr refused the API key (HTTP ' + response.status + ')'};
  if (!response.ok) return {ok: false, error: 'Sonarr answered HTTP ' + response.status};
  searches.set(id, Date.now());
  // A found release shows up in the queue within seconds.
  feeds.queue.next = Math.min(feeds.queue.next, Date.now() + TICK);
  publish();
  return {ok: true};
});

if (connection) {
  publish();
  due(true);
  setInterval(() => due(), TICK);
} else {
  publish();
}
