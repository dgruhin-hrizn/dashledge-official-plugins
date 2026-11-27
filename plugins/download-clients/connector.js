// Downloads: SABnzbd, NZBGet and qBittorrent in one placement.
//
// Each of the placement's connections is one client. Every few seconds the connector reads
// each client's queue, turns it into the same shape (items, speed, what's left, recent
// finishes) and emits all of them together. Dashledge adds each connection's credential
// itself: the SABnzbd key, NZBGet's username and password, or qBittorrent's sign-in.
//
// Nothing here reads a route that could echo a credential (SABnzbd get_config, NZBGet
// config, qBittorrent app/preferences), and no reply is logged.

const TICK = 3000;              // how often each client's queue is read
const HISTORY_EVERY = 30000;    // SABnzbd and NZBGet history, which changes slowly
const SAVE_EVERY = 60000;       // how often the last good reading is stored for a restart
const MAX_ITEMS = 40;           // queue rows per client
const MAX_FINISHED = 8;         // recent finishes per client
const RECENT = 24 * 3600;       // a qBittorrent torrent counts as recently finished for a day
const QBT_NEVER = 8640000;      // qBittorrent's "no estimate"

const TYPES = {sabnzbd: 'SABnzbd', nzbget: 'NZBGet', qbittorrent: 'qBittorrent'};

const clients = (dashledge.connections || []).map((connection, i) => ({
  i,
  type: TYPES[connection.type] ? connection.type : 'sabnzbd',
  base: connection.address,
  name: connection.name || null,
  host: hostOf(connection.address),
  busy: false, again: false,
  ok: false, error: null, at: 0, tried: 0, restored: false,
  reading: null,          // the last good normalised reading
  historyAt: 0, history: [],
  savedAt: 0,
  qbt: {rid: 0, torrents: {}, server: {}, stop: null},
}));

function hostOf(address) {
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(address || '');
  return match ? match[1].replace(/^[^@]*@/, '') : '';
}

// ---- Reading the clients ---------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function refusedMessage(client) {
  if (client.type === 'sabnzbd') return 'SABnzbd refused the API key';
  if (client.type === 'nzbget') return 'NZBGet refused the username or password';
  return 'qBittorrent refused the sign-in';
}

async function call(client, path, init = {}) {
  const r = await fetch(client.base + path, Object.assign({}, init, {connection: client.i}));
  if (r.status === 401 || r.status === 403) throw new HttpError(r.status, refusedMessage(client));
  if (!r.ok) throw new HttpError(r.status, TYPES[client.type] + ' answered HTTP ' + r.status);
  return r;
}

async function json(client, path, init) {
  const r = await call(client, path, init);
  try { return await r.json(); } catch { throw new Error(TYPES[client.type] + ' sent a reply that isn’t JSON'); }
}

const number = value => { const n = typeof value === 'number' ? value : parseFloat(value); return Number.isFinite(n) ? n : 0; };
const big = (lo, hi) => number(hi) * 4294967296 + (number(lo) >>> 0);
const MB = 1024 * 1024;
const clamp01 = n => Math.max(0, Math.min(1, n));

// "1:02:03" or "1:02:03:04" (days first) to seconds; null when there's no estimate.
function duration(text) {
  if (typeof text !== 'string' || !/^\d+(:\d+){1,3}$/.test(text)) return null;
  const parts = text.split(':').map(Number).reverse();
  const seconds = (parts[0] || 0) + (parts[1] || 0) * 60 + (parts[2] || 0) * 3600 + (parts[3] || 0) * 86400;
  return seconds > 0 ? seconds : null;
}

// SABnzbd ----------------------------------------------------------------------------------

const SAB_STATE = {Downloading: 'downloading', Queued: 'queued', Paused: 'paused', Fetching: 'queued', Grabbing: 'queued',
  Propagating: 'queued', Checking: 'checking'};
const SAB_DONE = ['Completed', 'Failed'];

async function readSabnzbd(client, now) {
  const reply = await json(client, 'api?mode=queue&output=json&limit=' + MAX_ITEMS);
  if (!reply || !reply.queue) throw new Error(reply && reply.error ? 'SABnzbd: ' + String(reply.error).slice(0, 120) : 'SABnzbd sent no queue');
  const q = reply.queue;
  if (now - client.historyAt >= HISTORY_EVERY || !client.historyAt) {
    const h = await json(client, 'api?mode=history&output=json&limit=' + (MAX_FINISHED + 12));
    client.history = (h && h.history && h.history.slots) || [];
    client.historyAt = now;
  }
  const paused = q.paused === true || q.paused === 'True';
  const items = (q.slots || []).map(slot => {
    const size = number(slot.mb) * MB, left = number(slot.mbleft) * MB;
    return {
      id: String(slot.nzo_id), name: String(slot.filename || ''), category: slot.cat && slot.cat !== '*' ? String(slot.cat) : '',
      state: SAB_STATE[slot.status] || 'queued', detail: String(slot.status || ''),
      progress: size > 0 ? clamp01(1 - left / size) : clamp01(number(slot.percentage) / 100),
      size, left, speed: null, eta: duration(slot.timeleft), canPause: true,
    };
  });
  // Post-processing (verify, repair, unpack) shows in SABnzbd's history while it runs.
  for (const slot of client.history) {
    if (SAB_DONE.includes(slot.status)) continue;
    items.push({id: String(slot.nzo_id), name: String(slot.name || ''), category: slot.category && slot.category !== '*' ? String(slot.category) : '',
      state: 'processing', detail: String(slot.status || ''), progress: 1, size: number(slot.bytes), left: 0, speed: null, eta: null, canPause: false});
  }
  const finished = client.history.filter(s => SAB_DONE.includes(s.status)).slice(0, MAX_FINISHED).map(slot => ({
    id: String(slot.nzo_id), name: String(slot.name || ''), ok: slot.status === 'Completed', at: number(slot.completed) * 1000,
    size: number(slot.bytes), detail: slot.status === 'Failed' ? String(slot.fail_message || 'Failed').slice(0, 160) : '',
  }));
  const speed = number(q.kbpersec) * 1024;
  return {
    version: String(q.version || ''), paused, speed: paused ? 0 : speed,
    left: number(q.mbleft) * MB, eta: paused ? null : duration(q.timeleft),
    total: number(q.noofslots_total) || items.length, items, finished, seeding: 0,
  };
}

// NZBGet -----------------------------------------------------------------------------------

const NZB_STATE = {DOWNLOADING: 'downloading', QUEUED: 'queued', FETCHING: 'queued', PAUSED: 'paused'};

async function rpc(client, method, params = []) {
  const reply = await json(client, 'jsonrpc', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({version: '1.1', id: 1, method, params})});
  if (reply && reply.error) throw new Error('NZBGet: ' + String(reply.error.message || reply.error.name || 'error').slice(0, 120));
  return reply ? reply.result : undefined;
}

const titleCase = text => String(text || '').toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

async function readNzbget(client, now) {
  const [status, groups] = await Promise.all([rpc(client, 'status'), rpc(client, 'listgroups', [0])]);
  if (now - client.historyAt >= HISTORY_EVERY || !client.historyAt) {
    client.history = (await rpc(client, 'history', [false])) || [];
    client.historyAt = now;
  }
  const paused = !!(status && status.DownloadPaused);
  const items = (groups || []).slice(0, MAX_ITEMS).map(g => {
    const size = big(g.FileSizeLo, g.FileSizeHi) || number(g.FileSizeMB) * MB;
    const left = big(g.RemainingSizeLo, g.RemainingSizeHi) || number(g.RemainingSizeMB) * MB;
    const raw = String(g.Status || '');
    const state = NZB_STATE[raw] || 'processing';
    return {
      id: String(g.NZBID), name: String(g.NZBName || ''), category: String(g.Category || ''),
      state: raw === 'QUEUED' && number(g.ActiveDownloads) > 0 ? 'downloading' : state,
      detail: titleCase(raw.replace(/^PP_/, '')),
      progress: state === 'processing' ? 1 : size > 0 ? clamp01(1 - left / size) : 0,
      size, left: state === 'processing' ? 0 : left, speed: null, eta: null, canPause: state !== 'processing',
    };
  });
  const finished = (client.history || [])
    .filter(h => !/^DELETED/.test(String(h.Status || '')) && (h.Kind || 'NZB') === 'NZB')
    .slice(0, MAX_FINISHED).map(h => {
      const status = String(h.Status || '');
      return {id: String(h.NZBID), name: String(h.Name || h.NZBName || ''), ok: /^SUCCESS/.test(status), at: number(h.HistoryTime) * 1000,
        size: big(h.FileSizeLo, h.FileSizeHi) || number(h.FileSizeMB) * MB,
        detail: /^SUCCESS/.test(status) ? '' : titleCase(status.split('/')[1] || status.split('/')[0])};
    });
  const rate = status ? (big(status.DownloadRateLo, status.DownloadRateHi) || number(status.DownloadRate)) : 0;
  const left = status ? (big(status.RemainingSizeLo, status.RemainingSizeHi) || number(status.RemainingSizeMB) * MB) : 0;
  return {
    version: '', paused, speed: paused ? 0 : rate, left,
    eta: !paused && rate > 0 && left > 0 ? Math.round(left / rate) : null,
    total: (groups || []).length, items, finished, seeding: 0,
  };
}

// qBittorrent ------------------------------------------------------------------------------

const QBT_STATE = {
  downloading: 'downloading', forcedDL: 'downloading', metaDL: 'downloading', forcedMetaDL: 'downloading',
  stalledDL: 'stalled', queuedDL: 'queued', pausedDL: 'paused', stoppedDL: 'paused',
  checkingDL: 'checking', checkingResumeData: 'checking', allocating: 'checking', moving: 'checking',
  error: 'failed', missingFiles: 'failed',
};
const QBT_DETAIL = {metaDL: 'Fetching metadata', forcedMetaDL: 'Fetching metadata', forcedDL: 'Forced', stalledDL: 'Stalled',
  checkingDL: 'Checking', checkingResumeData: 'Checking', allocating: 'Allocating', moving: 'Moving', error: 'Error', missingFiles: 'Missing files'};
const QBT_SEEDING = ['uploading', 'stalledUP', 'forcedUP', 'queuedUP', 'checkingUP', 'pausedUP', 'stoppedUP'];

async function readQbittorrent(client) {
  const q = client.qbt;
  const diff = await json(client, 'api/v2/sync/maindata?rid=' + q.rid);
  if (!diff || typeof diff !== 'object') throw new Error('qBittorrent sent no data');
  if (diff.full_update) { q.torrents = {}; q.server = {}; }
  for (const [hash, fields] of Object.entries(diff.torrents || {})) q.torrents[hash] = Object.assign(q.torrents[hash] || {}, fields);
  for (const hash of diff.torrents_removed || []) delete q.torrents[hash];
  Object.assign(q.server, diff.server_state || {});
  q.rid = number(diff.rid);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const all = Object.entries(q.torrents);
  const downloading = all.filter(([, t]) => !QBT_SEEDING.includes(t.state) && number(t.progress) < 1 || QBT_STATE[t.state] === 'failed');
  const seeding = all.filter(([, t]) => QBT_SEEDING.includes(t.state));
  const order = {downloading: 0, checking: 1, stalled: 2, queued: 3, paused: 4, failed: 5};
  const items = downloading.map(([hash, t]) => {
    const state = QBT_STATE[t.state] || 'queued';
    const size = number(t.size), left = t.amount_left !== undefined ? number(t.amount_left) : size * (1 - number(t.progress));
    const eta = number(t.eta);
    return {id: hash, name: String(t.name || ''), category: String(t.category || ''), state, detail: QBT_DETAIL[t.state] || '',
      progress: clamp01(number(t.progress)), size, left, speed: state === 'downloading' || state === 'stalled' ? number(t.dlspeed) : null,
      eta: eta > 0 && eta < QBT_NEVER && state === 'downloading' ? eta : null, canPause: true, priority: number(t.priority)};
  }).sort((a, b) => order[a.state] - order[b.state] || (a.priority || 1e9) - (b.priority || 1e9) || a.name.localeCompare(b.name));
  const finished = seeding
    .filter(([, t]) => number(t.completion_on) > 0 && nowSeconds - number(t.completion_on) < RECENT)
    .sort((a, b) => number(b[1].completion_on) - number(a[1].completion_on))
    .slice(0, MAX_FINISHED)
    .map(([hash, t]) => ({id: hash, name: String(t.name || ''), ok: true, at: number(t.completion_on) * 1000, size: number(t.size), detail: ''}));
  const seedingItems = seeding
    .filter(([, t]) => number(t.upspeed) > 0)
    .sort((a, b) => number(b[1].upspeed) - number(a[1].upspeed))
    .slice(0, MAX_ITEMS)
    .map(([hash, t]) => ({id: hash, name: String(t.name || ''), category: String(t.category || ''), state: 'seeding', detail: '',
      progress: 1, size: number(t.size), left: 0, speed: number(t.upspeed), eta: null, canPause: true}));
  const left = items.reduce((sum, item) => sum + item.left, 0);
  const speed = number(q.server.dl_info_speed);
  const active = items.filter(item => item.state !== 'failed');
  const paused = active.length > 0 && active.every(item => item.state === 'paused');
  return {
    version: '', paused, speed, left,
    eta: speed > 0 && left > 0 ? Math.round(left / speed) : null,
    total: items.length, items: items.slice(0, MAX_ITEMS), finished, seeding: seeding.length, seedingItems,
    upload: number(q.server.up_info_speed),
    offline: q.server.connection_status === 'disconnected',
  };
}

const READERS = {sabnzbd: readSabnzbd, nzbget: readNzbget, qbittorrent: readQbittorrent};

// ---- Polling, storing and publishing ---------------------------------------------------

async function poll(client) {
  if (client.busy) { client.again = true; return; }
  client.busy = true;
  const now = Date.now();
  client.tried = now;
  try {
    client.reading = await READERS[client.type](client, now);
    client.ok = true; client.error = null; client.at = Date.now(); client.restored = false;
    if (client.at - client.savedAt >= SAVE_EVERY) save(client);
  } catch (error) {
    client.ok = false;
    client.error = String(error && error.message || error).slice(0, 200);
    if (error && error.status === 403 && client.type === 'qbittorrent') client.qbt.rid = 0;
    console.warn(TYPES[client.type] + ' ' + (client.name || client.host) + ': ' + client.error);
  } finally {
    client.busy = false;
  }
  publish();
  if (client.again) { client.again = false; poll(client); }
}

function save(client) {
  client.savedAt = client.at;
  const slim = Object.assign({}, client.reading, {seedingItems: undefined});
  try { dashledge.storage.set('c:' + client.type + ':' + client.base, {at: client.at, reading: slim}); } catch { /* storage full: skip */ }
}

function restore(client) {
  const saved = dashledge.storage.get('c:' + client.type + ':' + client.base);
  if (saved && saved.reading && typeof saved.at === 'number') {
    client.reading = saved.reading; client.at = saved.at; client.restored = true;
  }
}

function view(client) {
  return {
    i: client.i, type: client.type, label: TYPES[client.type], name: client.name, host: client.host,
    ok: client.ok, error: client.error, at: client.at || null, tried: client.tried || null, restored: client.restored,
    reading: client.reading,
  };
}

function publish() {
  dashledge.emit({at: Date.now(), clients: clients.map(view)});
}

// ---- Commands from the view ------------------------------------------------------------

function pick(args) {
  const client = clients[Number(args && args.client)];
  if (!client) throw new Error('That download client isn’t part of this placement any more');
  const item = args && args.item;
  if (item !== undefined && (typeof item !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(item))) throw new Error('Unknown download');
  return {client, item};
}

async function qbtAll(client, verb, hashes) {
  // qBittorrent 5 renamed pause and resume to stop and start; try the new names first.
  const names = verb === 'pause' ? ['stop', 'pause'] : ['start', 'resume'];
  const order = client.qbt.stop === false ? [names[1]] : client.qbt.stop === true ? [names[0]] : names;
  for (const name of order) {
    const r = await fetch(client.base + 'api/v2/torrents/' + name, {method: 'POST', connection: client.i,
      headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'hashes=' + encodeURIComponent(hashes)});
    if (r.status === 404 && name === names[0]) { client.qbt.stop = false; continue; }
    if (r.status === 401 || r.status === 403) throw new Error(refusedMessage(client));
    if (!r.ok) throw new Error('qBittorrent answered HTTP ' + r.status);
    if (name === names[0]) client.qbt.stop = true;
    return;
  }
}

async function act(verb, args) {
  const {client, item} = pick(args);
  if (client.type === 'sabnzbd') {
    const path = item ? 'api?mode=queue&name=' + verb + '&value=' + encodeURIComponent(item) + '&output=json' : 'api?mode=' + verb + '&output=json';
    const reply = await json(client, path);
    if (reply && reply.status === false) throw new Error('SABnzbd: ' + String(reply.error || 'refused').slice(0, 120));
  } else if (client.type === 'nzbget') {
    const done = item
      ? await rpc(client, 'editqueue', [verb === 'pause' ? 'GroupPause' : 'GroupResume', '', [Number(item)]])
      : await rpc(client, verb === 'pause' ? 'pausedownload' : 'resumedownload');
    if (done === false) throw new Error('NZBGet didn’t ' + verb + ' it');
  } else {
    await qbtAll(client, verb, item || 'all');
  }
  await poll(client);
  return {ok: true};
}

dashledge.onCommand('pause', args => act('pause', args));
dashledge.onCommand('resume', args => act('resume', args));
// Retry: read one client, or all of them, now.
dashledge.onCommand('refresh', async args => {
  const targets = args && args.client !== undefined ? [pick(args).client] : clients;
  await Promise.all(targets.map(poll));
  return {ok: true};
});

// ---- Start -----------------------------------------------------------------------------

clients.forEach(restore);
publish();
clients.forEach(poll);
setInterval(() => clients.forEach(poll), TICK);
