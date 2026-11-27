import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {loadConnector, loadViewScript, sample, root} from './harness.mjs';

const SAB = {address: 'http://sab.local:8080/', name: 'Usenet box', type: 'sabnzbd'};
const NZB = {address: 'http://nzbget.local:6789/', name: '', type: 'nzbget'};
const QBT = {address: 'http://qbt.local:8080/', name: '', type: 'qbittorrent'};
const s = file => sample('download-clients', file);

// Recorded replies for each client; `over` replaces a reply by a key such as 'sab-queue'.
function servers(over = {}) {
  let maindata = 0;
  return (url, init = {}) => {
    const pick = (key, reply) => (key in over ? (typeof over[key] === 'function' ? over[key](url, init) : over[key]) : reply);
    if (url.startsWith(SAB.address)) {
      if (url.includes('mode=queue&output')) return pick('sab-queue', {json: s('sabnzbd-queue.json')});
      if (url.includes('mode=history')) return pick('sab-history', {json: s('sabnzbd-history.json')});
      return pick('sab-other', {json: {status: true}});
    }
    if (url.startsWith(NZB.address)) {
      const method = JSON.parse(init.body || '{}').method;
      if (method === 'status') return pick('nzb-status', {json: s('nzbget-status.json')});
      if (method === 'listgroups') return pick('nzb-listgroups', {json: s('nzbget-listgroups.json')});
      if (method === 'history') return pick('nzb-history', {json: s('nzbget-history.json')});
      return pick('nzb-other', {json: {version: '1.1', id: 1, result: true}});
    }
    if (url.startsWith(QBT.address)) {
      if (url.includes('sync/maindata')) return pick('qbt-maindata', {json: maindata++ === 0 ? s('qbittorrent-maindata-full.json') : s('qbittorrent-maindata-diff.json')});
      return pick('qbt-other', {status: 200, text: ''});
    }
    return {status: 404};
  };
}

const client = (c, i = 0) => c.last().clients[i];

test('SABnzbd: the queue, what is unpacking, and what finished', async () => {
  const c = loadConnector('download-clients', {connections: [SAB], respond: servers()});
  await c.settle();
  const sab = client(c);
  assert.equal(sab.ok, true);
  assert.equal(sab.label, 'SABnzbd');
  assert.equal(sab.name, 'Usenet box');
  const r = sab.reading;
  assert.equal(r.version, '4.4.1');
  assert.equal(r.speed, 19046.4 * 1024);
  assert.equal(r.eta, 6 * 60 + 22);
  assert.equal(r.paused, false);
  assert.deepEqual(r.items.map(i => [i.name, i.state]), [
    ['Example.Show.S02E05.1080p.WEB.h264-GROUP', 'downloading'],
    ['Sample.Movie.2025.2160p.UHD.BluRay.x265-GROUP', 'queued'],
    ['Another.Show.S01E01.720p.HDTV-GROUP', 'paused'],
    ['Example.Show.S02E04.1080p.WEB.h264-GROUP', 'processing'],
  ]);
  assert.equal(r.items[0].eta, 55);
  assert.ok(Math.abs(r.items[0].progress - (1 - 1024.33 / 3120.66)) < 1e-9);
  assert.equal(r.items[2].category, '', 'SABnzbd’s "*" category means none');
  assert.equal(r.items[3].detail, 'Extracting');
  assert.deepEqual(r.finished.map(f => [f.name, f.ok, f.detail]), [
    ['Example.Show.S02E03.1080p.WEB.h264-GROUP', true, ''],
    ['Broken.Upload.2024.1080p.BluRay-GROUP', false, 'Aborted, cannot be completed'],
  ]);
  for (const {url} of c.requests) assert.ok(!/apikey/i.test(url), 'Dashledge adds the key, never the connector');
});

test('SABnzbd history is read every 30 seconds, the queue every 3', async () => {
  const c = loadConnector('download-clients', {connections: [SAB], respond: servers()});
  await c.settle();
  await c.advance(29000);
  const count = word => c.requests.filter(r => r.url.includes(word)).length;
  assert.equal(count('mode=history'), 1);
  assert.ok(count('mode=queue&output') >= 9);
  await c.advance(3000);
  assert.equal(count('mode=history'), 2);
});

test('NZBGet: JSON-RPC status, groups and history, with 64-bit sizes', async () => {
  const c = loadConnector('download-clients', {connections: [NZB], respond: servers()});
  await c.settle();
  const r = client(c).reading;
  for (const req of c.requests) {
    assert.equal(req.url, NZB.address + 'jsonrpc');
    assert.equal(req.method, 'POST');
  }
  assert.equal(r.speed, 20971520);
  assert.equal(r.left, 4294967296 + 1048576000, 'Hi and Lo halves, not the rounded MB');
  assert.equal(r.eta, Math.round((4294967296 + 1048576000) / 20971520));
  assert.deepEqual(r.items.map(i => [i.id, i.state, i.detail]), [
    ['41', 'downloading', 'Downloading'],
    ['40', 'processing', 'Unpacking'],
    ['42', 'paused', 'Paused'],
  ]);
  assert.equal(r.items[0].size, 4294967296 + 2147483648);
  assert.equal(r.items[1].canPause, false, 'post-processing can’t be paused from here');
  assert.deepEqual(r.finished.map(f => [f.name, f.ok, f.detail]), [
    ['Example.Show.S02E10.1080p.WEB-GROUP', true, ''],
    ['Damaged.Release.2022.1080p-GROUP', false, 'Par'],
  ], 'deleted downloads and feed fetches are left out');
});

test('qBittorrent: a full update, then diffs merged by rid', async () => {
  const c = loadConnector('download-clients', {connections: [QBT], respond: servers()});
  await c.settle();
  let r = client(c).reading;
  assert.ok(c.requests[0].url.endsWith('api/v2/sync/maindata?rid=0'));
  assert.deepEqual(r.items.map(i => [i.name, i.state]), [
    ['Open Distro 24.04 Desktop amd64', 'downloading'],
    ['Public Domain Film Collection', 'stalled'],
    ['Creative Commons Album FLAC', 'paused'],
  ]);
  assert.equal(r.items[0].eta, 676);
  assert.equal(r.items[1].eta, null, '8640000 means no estimate');
  assert.equal(r.seeding, 2);
  assert.deepEqual(r.seedingItems.map(i => i.name), ['Open Distro 23.10 Server amd64'], 'only torrents sending data');
  assert.deepEqual(r.finished.map(f => f.name), ['Open Distro 23.10 Server amd64'], 'finished in the last day');
  assert.equal(r.speed, 5242880);
  assert.equal(r.paused, false);

  await c.advance(3000);
  assert.ok(c.requests.at(-1).url.endsWith('api/v2/sync/maindata?rid=1'));
  r = client(c).reading;
  assert.equal(r.items.length, 2, 'the removed torrent is gone');
  assert.equal(r.items[0].progress, 0.55);
  assert.equal(r.items[0].name, 'Open Distro 24.04 Desktop amd64', 'unchanged fields are kept');
  assert.equal(r.speed, 6291456);
});

test('several clients in one placement, each on its own connection', async () => {
  const c = loadConnector('download-clients', {connections: [SAB, NZB, QBT], respond: servers({'nzb-status': {status: 401}})});
  await c.settle();
  const [sab, nzb, qbt] = c.last().clients;
  assert.deepEqual([sab.type, nzb.type, qbt.type], ['sabnzbd', 'nzbget', 'qbittorrent']);
  assert.equal(sab.ok, true);
  assert.equal(qbt.ok, true);
  assert.equal(nzb.ok, false);
  assert.equal(nzb.error, 'NZBGet refused the username or password');
  assert.equal(nzb.host, 'nzbget.local:6789', 'a connection without a name shows its host');
  assert.ok(c.logs.every(l => !/Example|Distro/.test(l.text)), 'replies are never logged');
});

test('pause and resume, for a whole client and for one download', async () => {
  const c = loadConnector('download-clients', {connections: [SAB, NZB, QBT], respond: servers({'qbt-other': (url) => ({status: url.endsWith('/stop') ? 404 : 200, text: ''})})});
  await c.settle();
  const since = () => { const n = c.requests.length; return () => c.requests.slice(n); };

  let sent = since();
  assert.deepEqual(await c.command('pause', {client: 0}), {ok: true});
  assert.equal(sent()[0].url, SAB.address + 'api?mode=pause&output=json');
  sent = since();
  await c.command('resume', {client: 0, item: 'SABnzbd_nzo_g7h8i9'});
  assert.equal(sent()[0].url, SAB.address + 'api?mode=queue&name=resume&value=SABnzbd_nzo_g7h8i9&output=json');

  sent = since();
  await c.command('pause', {client: 1, item: '41'});
  assert.deepEqual(JSON.parse(sent()[0].body), {version: '1.1', id: 1, method: 'editqueue', params: ['GroupPause', '', [41]]});
  sent = since();
  await c.command('resume', {client: 1});
  assert.equal(JSON.parse(sent()[0].body).method, 'resumedownload');

  sent = since();
  await c.command('pause', {client: 2, item: '8f3c1a2b4d5e6f708192a3b4c5d6e7f801234567'});
  const calls = sent();
  assert.deepEqual(calls.slice(0, 2).map(r => r.url), [QBT.address + 'api/v2/torrents/stop', QBT.address + 'api/v2/torrents/pause'], 'qBittorrent 4 has no stop');
  assert.equal(calls[1].body, 'hashes=8f3c1a2b4d5e6f708192a3b4c5d6e7f801234567');
  sent = since();
  await c.command('resume', {client: 2, item: '8f3c1a2b4d5e6f708192a3b4c5d6e7f801234567'});
  assert.equal(sent()[0].url, QBT.address + 'api/v2/torrents/resume', 'it remembers the older names');
  assert.equal(c.requests.filter(r => r.url.endsWith('/start')).length, 0);
});

test('qBittorrent: Pause stops only what was downloading, and Resume starts only that', async () => {
  const DOWNLOADING = '8f3c1a2b4d5e6f708192a3b4c5d6e7f801234567', STALLED = '1a2b3c4d5e6f708192a3b4c5d6e7f80123456789';
  const PARKED = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd';   // stopped by the user in qBittorrent itself
  let stopped = null, rid = 0;
  const storage = {};
  const respond = (url, init) => {
    if (url.includes('sync/maindata')) {
      if (rid++ === 0) return {json: s('qbittorrent-maindata-full.json')};
      const torrents = {};
      for (const hash of stopped || []) torrents[hash] = {state: 'stoppedDL', dlspeed: 0};
      if (stopped && !stopped.length) Object.assign(torrents, {[DOWNLOADING]: {state: 'downloading'}, [STALLED]: {state: 'stalledDL'}});
      return {json: {rid, torrents}};
    }
    if (url.endsWith('/stop')) { stopped = init.body.replace('hashes=', '').split('%7C'); return {status: 200, text: ''}; }
    if (url.endsWith('/start')) { stopped = []; return {status: 200, text: ''}; }
    return {status: 404};
  };
  const c = loadConnector('download-clients', {connections: [QBT], storage, respond});
  await c.settle();
  assert.equal(client(c).reading.paused, false);
  assert.equal(client(c).reading.canPause, true);

  await c.command('pause', {client: 0});
  const stop = c.requests.find(r => r.url.endsWith('/stop'));
  assert.equal(decodeURIComponent(stop.body), 'hashes=' + DOWNLOADING + '|' + STALLED, 'not the parked torrent, not the seeders');
  assert.equal(client(c).reading.paused, true);
  assert.deepEqual(JSON.parse(storage['held:qbittorrent:' + QBT.address]), [DOWNLOADING, STALLED], 'remembered across a restart');

  await c.command('resume', {client: 0});
  const start = c.requests.find(r => r.url.endsWith('/start'));
  assert.equal(decodeURIComponent(start.body), 'hashes=' + DOWNLOADING + '|' + STALLED);
  assert.ok(!start.body.includes(PARKED) && !c.requests.some(r => /hashes=all/.test(r.body || '')), 'never every torrent');
  assert.equal(client(c).reading.paused, false);
  assert.deepEqual(JSON.parse(storage['held:qbittorrent:' + QBT.address]), []);
});

test('qBittorrent: with only seeders and a parked torrent, there is nothing to pause', async () => {
  const full = s('qbittorrent-maindata-full.json');
  for (const t of Object.values(full.torrents)) if (t.progress < 1 && t.state !== 'stoppedDL') t.state = 'stoppedDL';
  const c = loadConnector('download-clients', {connections: [QBT], respond: url => (url.includes('maindata') ? {json: full} : {status: 404})});
  await c.settle();
  const r = client(c).reading;
  assert.equal(r.paused, false, 'torrents the user stopped don’t make the client read as paused');
  assert.equal(r.canPause, false, 'so the chip offers no Pause');
  await assert.rejects(c.command('pause', {client: 0}), /Nothing is downloading/);
  assert.ok(!c.requests.some(r => /stop|pause/.test(r.url)), 'nothing was sent');
  const M = model();
  assert.equal(M.summarize(c.last(), {}, c.last().at).clients[0].canPause, false);
});

test('commands refuse a client or download that isn’t there', async () => {
  const c = loadConnector('download-clients', {connections: [SAB], respond: servers()});
  await c.settle();
  await assert.rejects(c.command('pause', {client: 3}), /isn’t part of this placement/);
  await assert.rejects(c.command('pause', {client: 0, item: '../../api?mode=shutdown'}), /Unknown download/);
  await assert.rejects(c.command('pause', {client: 0, item: 7}), /Unknown download/);
});

test('a failed read keeps the last good queue, and Retry reads again', async () => {
  let down = false;
  const c = loadConnector('download-clients', {connections: [SAB], respond: servers({'sab-queue': () => (down ? {status: 502} : {json: s('sabnzbd-queue.json')})})});
  await c.settle();
  down = true;
  await c.advance(3000);
  let sab = client(c);
  assert.equal(sab.ok, false);
  assert.equal(sab.error, 'SABnzbd answered HTTP 502');
  assert.equal(sab.reading.items.length, 4, 'the last good queue is still there');
  down = false;
  assert.deepEqual(await c.command('refresh', {client: 0}), {ok: true});
  sab = client(c);
  assert.equal(sab.ok, true);
  assert.equal(sab.error, null);
});

test('SABnzbd refusing the key says so', async () => {
  const c = loadConnector('download-clients', {connections: [SAB], respond: servers({'sab-queue': {status: 403, text: ''}})});
  await c.settle();
  assert.equal(client(c).error, 'SABnzbd refused the API key');
  assert.equal(client(c).reading, null);
});

test('a restart shows the stored queue until the client answers', async () => {
  const storage = {};
  const first = loadConnector('download-clients', {connections: [SAB], storage, respond: servers()});
  await first.settle();
  assert.ok(Object.keys(storage).some(k => k.startsWith('c:sabnzbd:')), 'the first good reading is stored');
  const second = loadConnector('download-clients', {connections: [SAB], storage, respond: () => { throw new Error('Server unreachable'); }});
  const shown = second.emitted[0].clients[0];
  assert.equal(shown.restored, true);
  assert.equal(shown.reading.items.length, 4);
  await second.settle();
  assert.equal(client(second).error, 'Server unreachable');
  assert.equal(client(second).reading.items.length, 4);
});

// Replies recorded from real servers with scripts/record-download-clients.sh. Their contents
// vary, so the test checks that each one turns into a well-formed reading.
const RECORDED = join(root, 'tests', 'download-clients', 'recorded');
const recorded = file => sample('download-clients', 'recorded/' + file);
const has = (...files) => files.every(f => existsSync(join(RECORDED, f)));
const STATES = ['downloading', 'processing', 'checking', 'stalled', 'queued', 'paused', 'failed', 'seeding'];

function wellFormed(c) {
  const k = c.reading;
  assert.equal(c.ok, true, c.error);
  for (const field of ['speed', 'left']) assert.ok(Number.isFinite(k[field]) && k[field] >= 0, field);
  assert.ok(k.eta === null || k.eta > 0, 'eta');
  for (const item of k.items.concat(k.seedingItems || [])) {
    assert.ok(STATES.includes(item.state), item.state);
    assert.ok(item.progress >= 0 && item.progress <= 1, 'progress');
    assert.ok(Number.isFinite(item.size) && Number.isFinite(item.left) && item.left <= item.size + 1, 'sizes');
    assert.equal(typeof item.name, 'string');
  }
  for (const f of k.finished) assert.ok(typeof f.ok === 'boolean' && Number.isFinite(f.at) && Number.isFinite(f.size));
}

for (const [type, connection, files] of [
  ['SABnzbd', SAB, ['sabnzbd-queue.json', 'sabnzbd-history.json']],
  ['NZBGet', NZB, ['nzbget-status.json', 'nzbget-listgroups.json', 'nzbget-history.json']],
  ['qBittorrent', QBT, ['qbittorrent-maindata-full.json']],
]) {
  test(type + ': recorded replies from a real server read cleanly', {skip: has(...files) ? false : 'no recording; run scripts/record-download-clients.sh'}, async () => {
    const over = {
      'sab-queue': () => ({json: recorded('sabnzbd-queue.json')}), 'sab-history': () => ({json: recorded('sabnzbd-history.json')}),
      'nzb-status': () => ({json: recorded('nzbget-status.json')}), 'nzb-listgroups': () => ({json: recorded('nzbget-listgroups.json')}),
      'nzb-history': () => ({json: recorded('nzbget-history.json')}), 'qbt-maindata': () => ({json: recorded('qbittorrent-maindata-full.json')}),
    };
    const c = loadConnector('download-clients', {connections: [connection], respond: servers(over)});
    await c.settle();
    wellFormed(client(c));
  });
}

// ---- The view model ----

function model() {
  const context = loadViewScript('download-clients', 'view/model.js');
  // Plain copies, so deepEqual doesn't compare objects from another realm.
  const wrap = fn => (...args) => JSON.parse(JSON.stringify(fn(...args)));
  return Object.fromEntries(Object.entries(context.DownloadsModel).map(([k, fn]) => [k, wrap(fn)]));
}

async function reading(connections, over) {
  const c = loadConnector('download-clients', {connections, respond: servers(over)});
  await c.settle();
  return c;
}

test('model: sizes and speeds keep their width, times read naturally', () => {
  const M = model();
  assert.deepEqual(M.bytes(0), {value: '0', unit: 'B'});
  assert.deepEqual(M.bytes(1536), {value: '1.50', unit: 'KB'});
  assert.deepEqual(M.bytes(19046.4 * 1024), {value: '18.6', unit: 'MB'});
  assert.deepEqual(M.bytes(5 * 1024 ** 4), {value: '5.00', unit: 'TB'});
  assert.deepEqual(M.speed(6291456), {value: '6.00', unit: 'MB/s'});
  assert.equal(M.eta(30), 'under a minute');
  assert.equal(M.eta(382), '6 min');
  assert.equal(M.eta(4 * 3600 + 5 * 60), '4 h 5 min');
  assert.equal(M.eta(26 * 3600), '1 d 2 h');
  assert.equal(M.eta(null), '');
});

test('model: three clients add up to one reading and one queue', async () => {
  const M = model();
  const c = await reading([SAB, NZB, QBT]);
  const s = M.summarize(c.last(), {}, c.last().at);
  assert.equal(s.status, 'ready');
  assert.deepEqual(s.speed, M.speed(19046.4 * 1024 + 20971520 + 5242880));
  assert.deepEqual(s.clients.map(x => [x.name, x.state]), [['Usenet box', 'ok'], ['nzbget.local:6789', 'ok'], ['qbt.local:8080', 'ok']]);
  assert.deepEqual(s.items.slice(0, 3).map(i => i.state), ['downloading', 'downloading', 'downloading']);
  assert.equal(s.items.at(-1).state, 'paused');
  assert.ok(!s.items.some(i => i.state === 'seeding'), 'uploading torrents only when asked');
  assert.match(s.line, /^3 downloading · \d+ waiting · [\d.]+ GB left · about /);
  assert.equal(s.finished[0].name, 'Example.Show.S02E10.1080p.WEB-GROUP', 'newest first, across clients');
  assert.equal(M.summarize(c.last(), {finished: false}, c.last().at).finished.length, 0);
  const seeding = M.summarize(c.last(), {seeding: true}, c.last().at);
  assert.equal(seeding.items.at(-1).state, 'seeding');
  assert.match(seeding.items.at(-1).right, /up$/);
});

test('model: paused, stale, failed and empty are told apart', async () => {
  const M = model();
  const now = Date.UTC(2026, 10, 27, 19);
  const paused = await reading([SAB], {'sab-queue': {json: {queue: Object.assign({}, s('sabnzbd-queue.json').queue, {paused: true})}}});
  const p = M.summarize(paused.last(), {}, now);
  assert.deepEqual(p.speed, {value: 'Paused', unit: ''});
  assert.equal(p.clients[0].state, 'paused');
  assert.equal(p.clients[0].paused, true);
  assert.ok(!p.items.some(i => i.state === 'downloading'), 'a paused client downloads nothing');
  assert.equal(p.items.find(i => i.name.startsWith('Example.Show.S02E05')).right, 'Client paused');
  assert.match(p.line, /^4 waiting · /);

  const failed = await reading([SAB], {'sab-queue': {status: 403}});
  const f = M.summarize(failed.last(), {}, now);
  assert.equal(f.status, 'failed');
  assert.equal(f.error, 'SABnzbd refused the API key');

  const data = (await reading([SAB])).last();
  data.clients[0].ok = false;
  data.clients[0].error = 'Server unreachable';
  const stale = M.summarize(data, {}, now);
  assert.equal(stale.clients[0].state, 'stale');
  assert.match(stale.clients[0].note, /^Server unreachable · from /);

  const empty = await reading([SAB], {'sab-queue': {json: {queue: {paused: false, kbpersec: '0', mbleft: '0', timeleft: '0:00:00', slots: [], noofslots_total: 0}}}, 'sab-history': {json: {history: {slots: []}}}});
  const e = M.summarize(empty.last(), {}, now);
  assert.equal(e.empty, true);
  assert.equal(e.line, 'Nothing downloading');
  assert.equal(e.clients[0].note, 'Idle');

  assert.equal(M.summarize({clients: []}, {}, now).status, 'loading');
});
