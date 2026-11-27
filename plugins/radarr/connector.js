// Radarr: the download queue and the movies coming out soon, from one Radarr server.
//
// Dashledge adds the API key to every request to the connection, so this file never sees
// it. It reads three routes, all read-only, and may send one command (a movie search):
//   api/v3/system/status   the server's own name, every 10 minutes
//   api/v3/queue           what's downloading, every 5 seconds while something is active
//   api/v3/calendar        releases from 14 days ago to 61 days ahead, every 15 minutes
//
// A connector serves every placement on the connection, and placement settings reach only
// the view. So the calendar window is fixed at the widest any placement may ask for (60
// days ahead, plus a little for time zones), and each view filters it by its own settings.
// The view gets one object: {status, queue, calendar, searches}. Each section keeps its
// last good data and says when it was read and why the latest read failed, if it did.

const QUEUE_ACTIVE = 5 * 1000;
const QUEUE_IDLE = 30 * 1000;
const CALENDAR_EVERY = 15 * 60 * 1000;
const STATUS_EVERY = 10 * 60 * 1000;
const BEHIND_DAYS = 14;
const AHEAD_DAYS = 61;
const PAGE_SIZE = 50;
const MAX_CALENDAR = 200;
const SEARCH_HOLD = 2 * 60 * 1000;
const SEARCH_FORGET = 30 * 60 * 1000;
const TICK = 1000;
const DAY = 24 * 60 * 60 * 1000;

const connection = dashledge.connection;
const base = connection ? connection.address : '';

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = v => (Number.isInteger(v) && v > 0 ? v : null);

// Why a read failed, for the view: `auth` (the key was refused), `format` (not Radarr's
// JSON, such as a proxy's sign-in page), or `unreachable` (no answer, or an HTTP error).
class ReadError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}
const problem = error => ({kind: error?.kind || 'unreachable', message: str(String(error?.message || error), 160)});

async function get(path) {
  let response;
  try {
    response = await fetch(base + path, {headers: {accept: 'application/json'}});
  } catch (error) {
    throw new ReadError('unreachable', 'Radarr didn’t answer. ' + str(String(error?.message || error), 120));
  }
  if (response.status === 401 || response.status === 403) {
    throw new ReadError('auth', 'Radarr refused the API key (HTTP ' + response.status + ').');
  }
  if (!response.ok) throw new ReadError('unreachable', 'Radarr answered HTTP ' + response.status + '.');
  try {
    return await response.json();
  } catch {
    throw new ReadError('format', 'The Radarr URL answered with something that isn’t Radarr’s API. Check the address.');
  }
}

// "00:12:34" or "1.02:03:04" (days.hours:minutes:seconds) in seconds, or null.
function seconds(span) {
  const m = typeof span === 'string' && span.match(/^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
  if (!m) return null;
  return Number(m[1] || 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

const hasPoster = movie => Array.isArray(movie?.images) && movie.images.some(i => i?.coverType === 'poster');

// The first message Radarr gives about a download, such as why it's waiting to import.
function firstMessage(record) {
  for (const m of Array.isArray(record.statusMessages) ? record.statusMessages : []) {
    const text = Array.isArray(m?.messages) ? m.messages.find(t => typeof t === 'string' && t.trim()) : '';
    if (text) return str(text.trim(), 160);
  }
  return str(record.errorMessage, 160);
}

// What the view needs about one queue record. `title` is the movie, never the release name.
function queueItem(record) {
  const movie = record.movie || {};
  const size = num(record.size), left = num(record.sizeleft);
  return {
    id: int(record.id) ?? 0,
    movieId: int(record.movieId) ?? int(movie.id) ?? 0,
    title: str(movie.title) || 'Unknown movie',
    year: int(movie.year) ?? 0,
    poster: hasPoster(movie),
    quality: str(record.quality?.quality?.name, 40),
    client: str(record.downloadClient, 60),
    protocol: str(record.protocol, 12),
    size: size ?? 0,
    left: left ?? 0,
    progress: size && size > 0 && left !== null ? Math.min(1, Math.max(0, (size - left) / size)) : null,
    timeLeft: seconds(record.timeleft),
    eta: str(record.estimatedCompletionTime, 40),
    status: str(record.status, 40).toLowerCase(),
    tracked: str(record.trackedDownloadStatus, 20).toLowerCase(),
    state: str(record.trackedDownloadState, 30).toLowerCase(),
    message: firstMessage(record),
  };
}

function parseQueue(json) {
  if (!json || !Array.isArray(json.records)) throw new ReadError('format', 'Radarr sent a queue this widget doesn’t understand.');
  const items = json.records.filter(r => r && typeof r === 'object').map(queueItem);
  return {items, total: int(json.totalRecords) ?? items.length};
}

// A release date as YYYY-MM-DD. Radarr sends dates at midnight UTC, so the date part is the day.
const day = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : '');

function calendarItem(movie) {
  const releases = [['cinema', movie.inCinemas], ['digital', movie.digitalRelease], ['physical', movie.physicalRelease]]
    .map(([type, date]) => ({type, date: day(date)})).filter(r => r.date);
  return {
    id: int(movie.id) ?? 0,
    title: str(movie.title) || 'Unknown movie',
    year: int(movie.year) ?? 0,
    poster: hasPoster(movie),
    hasFile: movie.hasFile === true,
    monitored: movie.monitored !== false,
    available: movie.isAvailable === true,
    releases,
  };
}

function parseCalendar(json) {
  if (!Array.isArray(json)) throw new ReadError('format', 'Radarr sent a calendar this widget doesn’t understand.');
  return json.filter(m => m && typeof m === 'object' && int(m.id)).map(calendarItem)
    .filter(m => m.releases.length).slice(0, MAX_CALENDAR);
}

// The window asked for, as dates: 14 days back (for released movies still missing) to 61 ahead.
function range(now) {
  const date = ms => new Date(ms).toISOString().slice(0, 10);
  return {start: date(now - BEHIND_DAYS * DAY), end: date(now + AHEAD_DAYS * DAY)};
}

// After `failures` failures in a row: 10 s, 30 s, 1, 2, then 5 minutes.
const retryDelay = failures => [10, 30, 60, 120, 300][Math.min(Math.max(failures, 1), 5) - 1] * 1000;

const section = () => ({at: 0, error: null, failures: 0, next: 0, busy: false});
const state = {
  status: Object.assign(section(), {instanceName: '', version: ''}),
  queue: Object.assign(section(), {items: [], total: 0}),
  calendar: Object.assign(section(), {items: [], start: '', end: ''}),
};
const searches = new Map();

// Shown after a restart until the first read comes back, so the view isn't blank.
const saved = dashledge.storage.get('last');
if (saved && typeof saved === 'object') {
  if (saved.status) Object.assign(state.status, {instanceName: str(saved.status.instanceName, 80), version: str(saved.status.version, 40), at: num(saved.status.at) ?? 0});
  if (saved.queue && Array.isArray(saved.queue.items)) Object.assign(state.queue, {items: saved.queue.items, total: num(saved.queue.total) ?? 0, at: num(saved.queue.at) ?? 0});
  if (saved.calendar && Array.isArray(saved.calendar.items)) Object.assign(state.calendar, {items: saved.calendar.items, start: str(saved.calendar.start, 10), end: str(saved.calendar.end, 10), at: num(saved.calendar.at) ?? 0});
}

function snapshot() {
  const {status, queue, calendar} = state;
  const now = Date.now();
  const recent = {};
  for (const [id, at] of searches) if (now - at < SEARCH_FORGET) recent[id] = at;
  return {
    connected: Boolean(connection),
    status: {instanceName: status.instanceName, version: status.version, at: status.at, error: status.error},
    queue: {items: queue.items, total: queue.total, at: queue.at, error: queue.error},
    calendar: {items: calendar.items, start: calendar.start, end: calendar.end, at: calendar.at, error: calendar.error},
    searches: recent,
  };
}

const publish = () => dashledge.emit(snapshot());

function remember() {
  const {status, queue, calendar} = state;
  dashledge.storage.set('last', {
    status: {instanceName: status.instanceName, version: status.version, at: status.at},
    queue: {items: queue.items, total: queue.total, at: queue.at},
    calendar: {items: calendar.items, start: calendar.start, end: calendar.end, at: calendar.at},
  });
}

// Something is moving, so read again soon; otherwise check now and then.
const active = () => state.queue.items.some(i => i.status === 'downloading' || i.state === 'importing' || i.state === 'importpending');

const readers = {
  async status() {
    const json = await get('api/v3/system/status');
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ReadError('format', 'Radarr sent a status this widget doesn’t understand.');
    Object.assign(state.status, {instanceName: str(json.instanceName, 80), version: str(json.version, 40)});
    return STATUS_EVERY;
  },
  async queue() {
    Object.assign(state.queue, parseQueue(await get('api/v3/queue?page=1&pageSize=' + PAGE_SIZE + '&includeMovie=true')));
    return active() ? QUEUE_ACTIVE : QUEUE_IDLE;
  },
  async calendar() {
    const {start, end} = range(Date.now());
    const items = parseCalendar(await get('api/v3/calendar?start=' + start + '&end=' + end + '&unmonitored=false'));
    Object.assign(state.calendar, {items, start, end});
    return CALENDAR_EVERY;
  },
};

async function read(name) {
  const s = state[name];
  s.busy = true;
  try {
    const every = await readers[name]();
    Object.assign(s, {at: Date.now(), error: null, failures: 0, next: Date.now() + every});
    remember();
  } catch (error) {
    // Keep the last good data: the view shows it as stale, with its age and the reason.
    s.failures += 1;
    Object.assign(s, {error: problem(error), next: Date.now() + retryDelay(s.failures)});
  } finally {
    s.busy = false;
    publish();
  }
}

function due() {
  if (!connection) return;
  const now = Date.now();
  for (const name of Object.keys(state)) if (!state[name].busy && state[name].next <= now) read(name);
}

// Retry: read everything now, forgetting the backoff.
dashledge.onCommand('refresh', () => {
  for (const s of Object.values(state)) if (!s.busy) { s.next = 0; s.failures = 0; }
  due();
  return {ok: Boolean(connection)};
});

// Ask Radarr to search for a released movie it's missing. Only movies the calendar lists
// as monitored, available and without a file qualify, so a view can't start anything else.
dashledge.onCommand('search', async args => {
  const id = int(args?.movieId);
  const movie = id ? state.calendar.items.find(m => m.id === id) : null;
  if (!connection || !movie || !movie.monitored || !movie.available || movie.hasFile) {
    return {ok: false, error: 'Radarr can only search for a released movie that’s missing.'};
  }
  const last = searches.get(id);
  if (last && Date.now() - last < SEARCH_HOLD) return {ok: true, at: last};
  let response;
  try {
    response = await fetch(base + 'api/v3/command', {
      method: 'POST',
      headers: {'content-type': 'application/json', accept: 'application/json'},
      body: JSON.stringify({name: 'MoviesSearch', movieIds: [id]}),
    });
  } catch (error) {
    return {ok: false, error: 'Radarr didn’t answer. ' + str(String(error?.message || error), 120)};
  }
  if (!response.ok) {
    return {ok: false, error: response.status === 401 || response.status === 403
      ? 'Radarr refused the API key (HTTP ' + response.status + ').' : 'Radarr answered HTTP ' + response.status + '.'};
  }
  const at = Date.now();
  searches.set(id, at);
  // A found release shows up in the queue soon, so look sooner than usual.
  state.queue.next = Math.min(state.queue.next, at + QUEUE_ACTIVE);
  publish();
  return {ok: true, at};
});

publish();
due();
setInterval(() => {
  const now = Date.now();
  for (const [id, at] of searches) if (now - at >= SEARCH_FORGET) searches.delete(id);
  due();
}, TICK);
