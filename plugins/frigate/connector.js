// Frigate: the cameras on the placement's Frigate server, which of them can play live
// video, whether each is sending frames, and what each detected lately.
//
// One connector runs per connection and serves every placement that uses it. It reads
// four of Frigate's routes and emits one slim snapshot:
// - api/config: cameras, their go2rtc stream names and frame size, every 5 minutes;
// - api/go2rtc/streams: which of those streams go2rtc really serves, every 5 minutes;
// - api/stats: each camera's frame rate (0 means no signal), every 10 seconds;
// - api/events: the last few hours' detections, every 10 seconds.
// Camera inputs (RTSP addresses, often with the camera's password) are in api/config;
// they never leave this file. Video and snapshots go straight from Dashledge to the view
// through the manifest's `streams` and `images`, not through here.
//
// Views say they're on screen with the `watch` command. With nobody watching for a while
// the connector stops polling until one asks again. Dashledge adds the sign-in session
// to every request on the connection; this file never sees it.

const CONFIG_EVERY = 5 * 60 * 1000;
const STATS_EVERY = 10 * 1000;
const EVENTS_EVERY = 10 * 1000;
const FORGET_AFTER = 10 * 60 * 1000;
const TICK = 5 * 1000;
const EVENTS_BACK = 6 * 60 * 60;          // seconds of detections to look back
const EVENTS_LIMIT = 60;
const PER_CAMERA = 4;
const MAX_CAMERAS = 64;
const TEXT = 120;

const connection = dashledge.connection;
const base = connection ? connection.address : '';

// ---- Shaping Frigate's replies --------------------------------------------------------

const str = (v, max = TEXT) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// Frigate camera and go2rtc stream names: letters, digits, _ and -. Anything else can't be
// a stream placeholder or a settings value, so it's left out.
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SUB = /(^|[^a-z])(sub|low|lo|small|preview|substream|minor)([^a-z]|$)/i;

// "backyard_patio_2" → "Backyard patio 2".
function humanName(name) {
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The go2rtc streams a camera can play, best for a large view first, and the one to use
// in a small tile. Frigate 0.16 and later list them in live.streams ({"Main": "cam",
// "Sub": "cam_sub"}); 0.14 and 0.15 name one in live.stream_name. When go2rtc's list is
// known, streams it doesn't serve are dropped; a 0.15 camera whose stream has a "_sub"
// sibling in go2rtc gets it as its small-tile stream.
function cameraStreams(name, camera, served) {
  const live = camera.live && typeof camera.live === 'object' ? camera.live : {};
  const listed = [];
  if (live.streams && typeof live.streams === 'object') {
    for (const [label, stream] of Object.entries(live.streams)) if (typeof stream === 'string') listed.push({label: str(label, 40), stream});
  }
  if (!listed.length) listed.push({label: '', stream: str(live.stream_name, 64) || name});
  let streams = listed.filter(s => NAME.test(s.stream) && (!served || served.has(s.stream)));
  if (served) {
    const main = streams[0]?.stream;
    if (main && streams.length === 1 && served.has(main + '_sub')) streams.push({label: '', stream: main + '_sub'});
  }
  streams = streams.filter((s, i) => streams.findIndex(t => t.stream === s.stream) === i);
  if (!streams.length) return {main: '', sub: ''};
  const subLike = s => SUB.test(s.label) || SUB.test(s.stream);
  const small = streams.length > 1 ? streams.find(subLike) || streams[streams.length - 1] : null;
  const large = streams.find(s => s !== small && !subLike(s)) || streams.find(s => s !== small) || streams[0];
  return {main: large.stream, sub: (small || large).stream};
}

function cameras(config, served) {
  const list = config && typeof config.cameras === 'object' && config.cameras ? config.cameras : null;
  if (!list) throw new FrigateError('format', 'Frigate sent a config without cameras');
  const out = [];
  for (const [name, camera] of Object.entries(list)) {
    if (!NAME.test(name) || !camera || typeof camera !== 'object') continue;
    const detect = camera.detect || {};
    const width = num(detect.width), height = num(detect.height);
    const {main, sub} = cameraStreams(name, camera, served);
    out.push({
      name,
      label: str(camera.friendly_name, 80) || humanName(name),
      enabled: camera.enabled !== false,
      order: num(camera.ui?.order) ?? 0,
      dashboard: camera.ui?.dashboard !== false,
      aspect: width && height ? Math.round(width / height * 1000) / 1000 : 16 / 9,
      main, sub,
    });
    if (out.length >= MAX_CAMERAS) break;
  }
  // Frigate's own order: ui.order, then the order of the config. (sort is stable)
  return out.sort((a, b) => a.order - b.order);
}

// go2rtc's stream list, as a set of names; null when Frigate didn't say (an older Frigate,
// or go2rtc's API is off), so every configured stream is tried.
function servedStreams(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  return new Set(Object.keys(json).filter(n => NAME.test(n)));
}

// Each camera's frame rates. A camera with no frames for a while reports camera_fps 0.
function signals(json) {
  const list = json && typeof json.cameras === 'object' && json.cameras ? json.cameras : null;
  if (!list) throw new FrigateError('format', 'Frigate sent stats without cameras');
  const out = {};
  for (const [name, c] of Object.entries(list)) {
    if (!NAME.test(name) || !c) continue;
    out[name] = {fps: num(c.camera_fps) ?? 0, detecting: c.detection_enabled !== false && c.detection_enabled !== 0};
  }
  return out;
}

const service = json => ({version: str(json?.service?.version, 40), uptime: num(json?.service?.uptime)});

// The latest detections per camera, newest first; `active` while Frigate still tracks it.
function detections(json) {
  if (!Array.isArray(json)) throw new FrigateError('format', 'Frigate sent events that aren’t a list');
  const out = {};
  for (const e of json) {
    if (!e || !NAME.test(e.camera || '') || e.false_positive === true) continue;
    const start = num(e.start_time);
    if (start === null) continue;
    const list = out[e.camera] || (out[e.camera] = []);
    if (list.length >= PER_CAMERA) continue;
    const score = num(e.data?.top_score) ?? num(e.top_score) ?? num(e.data?.score);
    list.push({
      label: str(e.label, 40),
      // Frigate 0.13 sends sub_label as [name, score]; later versions as a string.
      sub: str(Array.isArray(e.sub_label) ? e.sub_label[0] : e.sub_label, 60),
      start: Math.round(start * 1000),
      end: num(e.end_time) === null ? null : Math.round(e.end_time * 1000),
      score: score === null ? null : Math.round(score * 100) / 100,
    });
  }
  for (const list of Object.values(out)) list.sort((a, b) => b.start - a.start);
  return out;
}

// ---- Requests -------------------------------------------------------------------------

class FrigateError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

async function getJson(path) {
  let response;
  try {
    response = await fetch(base + path, {headers: {accept: 'application/json'}});
  } catch (error) {
    throw new FrigateError('network', 'Frigate didn’t answer: ' + str(String(error?.message || error)));
  }
  if (response.status === 401 || response.status === 403) {
    throw new FrigateError('auth', 'Frigate refused the sign-in (HTTP ' + response.status + ')');
  }
  if (!response.ok) throw new FrigateError('http', 'Frigate answered HTTP ' + response.status);
  try {
    return await response.json();
  } catch {
    throw new FrigateError('format', 'Frigate sent something that isn’t JSON. Check the address.');
  }
}

// ---- State ----------------------------------------------------------------------------

const saved = dashledge.storage.get('last') || null;
const state = {
  // What the views get. `cameras` survives a restart so a view draws tiles at once.
  server: saved?.server || {version: '', uptime: null},
  cameras: Array.isArray(saved?.cameras) ? saved.cameras : [],
  signals: {},
  detections: {},
  updated: {config: saved?.at || 0, stats: 0, events: 0},
  error: null,            // {kind, message} from the last failed read
  stale: !!saved,         // cameras come from storage until config is read again
};
const due = {config: 0, stats: 0, events: 0};
let lastWatch = 0, busy = false, timer = null;

function emit() {
  dashledge.emit({
    connected: !!connection,
    server: state.server,
    cameras: state.cameras,
    signals: state.signals,
    detections: state.detections,
    updated: state.updated,
    error: state.error,
    stale: state.stale,
  });
}

function fail(error) {
  state.error = {kind: error?.kind || 'network', message: str(String(error?.message || error), 200)};
}

async function readConfig() {
  const [config, go2rtc] = await Promise.all([
    getJson('api/config'),
    getJson('api/go2rtc/streams').catch(error => (error.kind === 'auth' ? Promise.reject(error) : null)),
  ]);
  state.cameras = cameras(config, servedStreams(go2rtc));
  state.updated.config = Date.now();
  state.stale = false;
  dashledge.storage.set('last', {cameras: state.cameras, server: state.server, at: state.updated.config});
}

async function readStats() {
  const stats = await getJson('api/stats');
  state.signals = signals(stats);
  state.server = service(stats);
  state.updated.stats = Date.now();
}

async function readEvents() {
  const after = Math.floor(Date.now() / 1000) - EVENTS_BACK;
  state.detections = detections(await getJson('api/events?limit=' + EVENTS_LIMIT + '&after=' + after + '&include_thumbnails=0'));
  state.updated.events = Date.now();
}

// Read whatever is due. A failed read keeps the last good data and says why.
async function poll(force = false) {
  if (!connection || busy) return;
  busy = true;
  const now = Date.now();
  const jobs = [];
  if (force || now >= due.config) { due.config = now + CONFIG_EVERY; jobs.push(readConfig); }
  if (force || now >= due.stats) { due.stats = now + STATS_EVERY; jobs.push(readStats); }
  if (force || now >= due.events) { due.events = now + EVENTS_EVERY; jobs.push(readEvents); }
  try {
    if (jobs.length) {
      const results = await Promise.allSettled(jobs.map(job => job()));
      const failed = results.find(r => r.status === 'rejected');
      if (failed) {
        fail(failed.reason);
        // Try the failed reads again soon rather than at their usual pace.
        if (jobs.includes(readConfig) && !state.updated.config) due.config = Date.now() + STATS_EVERY;
      } else {
        state.error = null;
      }
      emit();
    }
  } finally {
    busy = false;
  }
}

function tick() {
  if (Date.now() - lastWatch > FORGET_AFTER) {
    clearInterval(timer);
    timer = null;
    return;
  }
  poll();
}

// A view on screen asks every few minutes; Retry asks with refresh, which reads all now.
dashledge.onCommand('watch', async ({refresh} = {}) => {
  lastWatch = Date.now();
  if (!timer) timer = setInterval(tick, TICK);
  if (refresh) { due.config = due.stats = due.events = 0; await poll(true); }
  else await poll();
  return {ok: true};
});

if (!connection) {
  state.error = {kind: 'connection', message: 'Choose a Frigate connection for this widget.'};
  emit();
} else {
  emit();
  lastWatch = Date.now();
  timer = setInterval(tick, TICK);
  poll(true);
}
