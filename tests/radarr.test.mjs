import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {loadConnector, loadViewScript, manifest, root, sample} from './harness.mjs';

// The replies in tests/radarr/*.json are synthetic: written from Radarr's published v3
// OpenAPI shapes with invented titles, because no Radarr server was at hand. Re-record
// real ones with scripts/record-radarr.sh; they land in tests/radarr/recorded/ and the
// last test here runs over them.
const status = sample('radarr', 'system-status.json');
const queue = sample('radarr', 'queue.json');
const queueEmpty = sample('radarr', 'queue-empty.json');
const calendar = sample('radarr', 'calendar.json');
const searchReply = sample('radarr', 'command-search.json');

const ADDRESS = 'http://radarr.test:7878/';
const connections = [{address: ADDRESS, name: '', type: ''}];
const START = Date.UTC(2026, 10, 27, 19);
const READS = {
  status: ADDRESS + 'api/v3/system/status',
  queue: ADDRESS + 'api/v3/queue?page=1&pageSize=50&includeMovie=true',
  calendar: ADDRESS + 'api/v3/calendar?start=2026-11-13&end=2027-01-27&unmonitored=false',
};

// Recorded replies by route. `overrides` replaces one route's reply; a function is called.
const radarr = (overrides = {}) => (url, init) => {
  const route = url.slice(ADDRESS.length).split('?')[0];
  const pick = (name, reply) => {
    const o = overrides[name];
    return o === undefined ? reply : typeof o === 'function' ? o(url, init) : o;
  };
  if (route === 'api/v3/system/status') return pick('status', {json: status});
  if (route === 'api/v3/queue') return pick('queue', {json: queue});
  if (route === 'api/v3/calendar') return pick('calendar', {json: calendar});
  if (route === 'api/v3/command') return pick('command', {status: 201, json: searchReply});
  return {status: 404};
};

const start = (options = {}) => loadConnector('radarr', {connections, start: START, ...options});
const readFrom = c => new Set(c.requests.filter(r => r.method === 'GET').map(r => r.url));

// The view model, with each call's result copied out of its context as plain data.
function model() {
  const {RadarrModel: m} = loadViewScript('radarr', 'view/model.js');
  return Object.fromEntries(Object.entries(m).map(([k, f]) =>
    [k, typeof f === 'function' ? (...a) => JSON.parse(JSON.stringify(f(...a)) ?? 'null') : JSON.parse(JSON.stringify(f))]));
}

test('the manifest asks for an X-Api-Key connection, posters and two commands, and nothing else', () => {
  const m = manifest('radarr');
  assert.deepEqual(m.sources.auth, {header: 'X-Api-Key'});
  assert.deepEqual(m.sources.test, ['api/v3/system/status']);
  assert.equal(m.displayName.serverField, 'status.instanceName');
  assert.deepEqual(m.images, ['api/v3/mediacover/*/*']);
  assert.deepEqual(m.connector.commands, ['refresh', 'search']);
  assert.equal(m.connector.hosts, undefined, 'no host besides the connection');
  assert.deepEqual(m.permissions, ['images', 'settings', 'ui']);
});

test('the queue, the calendar and the server’s name arrive in one object', async () => {
  const c = start({respond: radarr()});
  await c.settle();
  assert.deepEqual(readFrom(c), new Set(Object.values(READS)), 'exactly the three read-only routes');
  const data = c.last();
  assert.equal(data.connected, true);
  // displayName.serverField reads this path from what the connector emits.
  assert.equal(data.status.instanceName, 'Radarr (test)');
  assert.equal(data.status.version, '5.14.0.9383');

  assert.equal(data.queue.at, START);
  assert.equal(data.queue.error, null);
  assert.equal(data.queue.total, 6);
  const lantern = data.queue.items.find(i => i.movieId === 101);
  assert.equal(lantern.title, 'The Lantern Keeper', 'the movie, not the release name');
  assert.equal(lantern.year, 2026);
  assert.equal(lantern.timeLeft, 12 * 60 + 34);
  assert.equal(Math.round(lantern.progress * 100), 62);
  assert.deepEqual([lantern.quality, lantern.client, lantern.status, lantern.state, lantern.poster], ['Bluray-1080p', 'SABnzbd', 'downloading', 'downloading', true]);
  assert.equal(lantern.fanart, true, 'fanart for the card’s backdrop');
  assert.equal(data.queue.items.find(i => i.movieId === 102).timeLeft, 86400 + 2 * 3600 + 3 * 60 + 4, 'days.hours:minutes:seconds');
  assert.equal(data.queue.items.find(i => i.movieId === 103).message, 'No files found are eligible for import in /downloads/Release 3');
  assert.equal(data.queue.items.find(i => i.movieId === 105).message, 'Download failed: unpacking failed', 'the error message when there are no status messages');
  assert.equal(data.queue.items.find(i => i.movieId === 106).timeLeft, null);
  for (const item of data.queue.items) assert.ok(!('downloadId' in item) && !('outputPath' in item), 'no hashes or paths reach the view');

  assert.equal(data.calendar.at, START);
  assert.deepEqual([data.calendar.start, data.calendar.end], ['2026-11-13', '2027-01-27']);
  const ferry = data.calendar.items.find(m => m.id === 201);
  assert.deepEqual(ferry.releases, [{type: 'cinema', date: '2026-10-02'}, {type: 'digital', date: '2026-11-27'}, {type: 'physical', date: '2026-12-15'}]);
  assert.deepEqual([ferry.hasFile, ferry.monitored, ferry.available, ferry.poster, ferry.fanart], [false, true, true, true, true]);
  assert.deepEqual(data.searches, {});
});

test('an empty queue and calendar are ready, not loading', async () => {
  const c = start({respond: radarr({queue: {json: queueEmpty}, calendar: {json: []}})});
  await c.settle();
  const data = c.last();
  assert.deepEqual([data.queue.items, data.queue.total, data.queue.at], [[], 0, START]);
  assert.deepEqual([data.calendar.items, data.calendar.at], [[], START]);
  const M = model();
  assert.deepEqual(M.paneState(data.queue, START, M.MAX_AGE.queue), {kind: 'ready', stale: false, note: '', auth: false});
  assert.equal(M.queueSummary([], 0), 'Nothing downloading');
});

test('before the first reply the view hears it’s loading', async () => {
  const c = start({respond: radarr()});
  const first = c.emitted[0];
  assert.deepEqual([first.connected, first.queue.at, first.queue.error, first.calendar.at], [true, 0, null, 0]);
  const M = model();
  assert.deepEqual(M.paneState(first.queue, START, M.MAX_AGE.queue), {kind: 'loading'});
  await c.settle();
});

test('a refused key is told apart from an unreachable server and a page that isn’t Radarr', async () => {
  const M = model();
  const cases = [
    [{status: 401, text: ''}, 'auth', 'Radarr refused the API key (HTTP 401).'],
    [{status: 503, text: 'Service Unavailable'}, 'unreachable', 'Radarr answered HTTP 503.'],
    [() => { throw new Error('connect ECONNREFUSED'); }, 'unreachable', 'Radarr didn’t answer. connect ECONNREFUSED'],
    [{status: 200, text: '<!doctype html><title>Sign in</title>'}, 'format', 'The Radarr URL answered with something that isn’t Radarr’s API. Check the address.'],
  ];
  for (const [reply, kind, message] of cases) {
    const c = start({respond: radarr({status: reply, queue: reply, calendar: reply})});
    await c.settle();
    const data = c.last();
    for (const name of ['status', 'queue', 'calendar']) assert.deepEqual(data[name].error, {kind, message}, name + ' for ' + kind);
    const pane = M.paneState(data.queue, START, M.MAX_AGE.queue);
    assert.deepEqual(pane, {kind: 'failed', error: message, auth: kind === 'auth'});
  }
});

test('a failed refresh keeps the last data as stale, backs off, and Retry reads at once', async () => {
  let failing = false;
  const c = start({respond: radarr({queue: () => (failing ? {status: 500} : {json: queue})})});
  await c.settle();
  failing = true;
  await c.advance(5 * 1000);
  let data = c.last();
  assert.deepEqual(data.queue.error, {kind: 'unreachable', message: 'Radarr answered HTTP 500.'});
  assert.equal(data.queue.items.length, 6, 'the last good queue stays');
  assert.equal(data.queue.at, START);
  const M = model();
  assert.deepEqual(M.paneState(data.queue, START + 5000, M.MAX_AGE.queue),
    {kind: 'ready', stale: true, note: 'Last updated just now · Radarr answered HTTP 500.', auth: false});
  const queueReads = () => c.requests.filter(r => r.url === READS.queue).length;
  const tries = queueReads();
  await c.advance(9 * 1000);
  assert.equal(queueReads(), tries, 'no retry within 10 seconds');
  failing = false;
  assert.deepEqual(await c.command('refresh', {}), {ok: true});
  await c.settle();
  assert.equal(queueReads(), tries + 1, 'Retry reads now');
  data = c.last();
  assert.equal(data.queue.error, null);
  assert.equal(data.queue.at, START + 14 * 1000);
});

test('the queue is read every 5 seconds while something downloads, every 30 when idle', async () => {
  let reply = {json: queue};
  const c = start({respond: radarr({queue: () => reply})});
  await c.settle();
  const reads = () => c.requests.filter(r => r.url === READS.queue).length;
  await c.advance(5 * 1000);
  assert.equal(reads(), 2);
  reply = {json: queueEmpty};
  await c.advance(5 * 1000);
  assert.equal(reads(), 3);
  await c.advance(25 * 1000);
  assert.equal(reads(), 3, 'idle: not yet');
  await c.advance(5 * 1000);
  assert.equal(reads(), 4);
  assert.equal(c.requests.filter(r => r.url === READS.calendar).length, 1, 'the calendar waits 15 minutes');
});

test('the last good data survives a restart', async () => {
  const storage = {};
  const before = start({respond: radarr(), storage});
  await before.settle();
  const after = start({respond: () => { throw new Error('offline'); }, storage, start: START + 60 * 60 * 1000});
  const shown = after.emitted[0];
  assert.equal(shown.queue.items.length, 6, 'shown at once from storage');
  assert.equal(shown.calendar.items.length, 7);
  assert.equal(shown.status.instanceName, 'Radarr (test)');
  assert.equal(shown.queue.at, START);
  const M = model();
  assert.deepEqual(M.paneState(shown.queue, START + 60 * 60 * 1000, M.MAX_AGE.queue),
    {kind: 'ready', stale: true, note: 'Last updated 1 hour ago', auth: false}, 'an hour-old queue is stale');
  await after.settle();
  assert.equal(after.last().queue.items.length, 6, 'a failed read after the restart keeps them');
  assert.equal(after.last().queue.error.kind, 'unreachable');
});

test('a placement with no connection reads nothing and says so', async () => {
  const c = loadConnector('radarr', {connections: [], start: START, respond: radarr()});
  await c.settle();
  assert.equal(c.requests.length, 0);
  assert.equal(c.last().connected, false);
  assert.deepEqual(await c.command('refresh', {}), {ok: false});
  assert.equal((await c.command('search', {movieId: 204})).ok, false);
  assert.equal(c.requests.length, 0);
});

test('search asks Radarr to find a released, missing movie and nothing else', async () => {
  let refuse = false;
  const c = start({respond: radarr({command: () => (refuse ? {status: 401} : {status: 201, json: searchReply})})});
  await c.settle();
  for (const movieId of [999, 205, 202, -1, '204', undefined]) {
    const answer = await c.command('search', {movieId});
    assert.equal(answer.ok, false, 'refused: ' + movieId);
  }
  assert.equal(c.requests.filter(r => r.method === 'POST').length, 0);

  assert.deepEqual(await c.command('search', {movieId: 204}), {ok: true, at: START});
  const posts = c.requests.filter(r => r.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, ADDRESS + 'api/v3/command');
  assert.deepEqual(JSON.parse(posts[0].body), {name: 'MoviesSearch', movieIds: [204]});
  assert.deepEqual(c.last().searches, {204: START});

  await c.advance(60 * 1000);
  assert.deepEqual(await c.command('search', {movieId: 204}), {ok: true, at: START}, 'once in two minutes');
  assert.equal(c.requests.filter(r => r.method === 'POST').length, 1);

  refuse = true;
  await c.advance(2 * 60 * 1000);
  assert.deepEqual(await c.command('search', {movieId: 204}), {ok: false, error: 'Radarr refused the API key (HTTP 401).'});
  await c.advance(30 * 60 * 1000);
  assert.deepEqual(c.last().searches, {}, 'old searches are forgotten');
});

test('the model reads settings and dates without the host’s clock or time zone', () => {
  const M = model();
  assert.deepEqual(M.settings({days: 14, releases: ['digital', 'physical'], first: 'upcoming'}), {days: 14, types: ['digital', 'physical'], first: 'upcoming'});
  assert.deepEqual(M.settings({days: 400, releases: ['*']}), {days: 60, types: ['cinema', 'digital', 'physical'], first: 'auto'});
  assert.deepEqual(M.settings({}), {days: 30, types: ['cinema', 'digital', 'physical'], first: 'auto'});
  assert.deepEqual(M.settings({days: 0, releases: []}).types, []);

  // 03:00 UTC on the 28th is still the 27th in California (UTC−8) and already the 28th in Paris.
  assert.equal(M.localDay(Date.UTC(2026, 10, 28, 3), 480), '2026-11-27');
  assert.equal(M.localDay(Date.UTC(2026, 10, 28, 3), -60), '2026-11-28');
  assert.equal(M.addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(M.daysBetween('2026-11-27', '2026-12-04'), 7);
  assert.deepEqual(['2026-11-27', '2026-11-28', '2026-12-02', '2026-11-26', '2026-11-20'].map(d => M.relativeDay(d, '2026-11-27')),
    ['Today', 'Tomorrow', 'In 5 days', 'Yesterday', '7 days ago']);
  assert.equal(M.dateLabel('2026-12-03', '2026-11-27'), 'Thu, Dec 3');
  assert.equal(M.dateLabel('2027-01-08', '2026-11-27'), 'Fri, Jan 8, 2027');
  assert.deepEqual([45, 754, 7500, 93784, null, -1].map(M.duration), ['45 s', '12 min', '2 h 05 min', '1 d 2 h', '', '']);
  assert.deepEqual([0, 950, 3.04e9, 18.4e9, 1.2e12].map(M.bytes), ['', '950 B', '3.0 GB', '18.4 GB', '1.2 TB']);
});

test('queue cards: downloading first, then importing, problems, paused and queued', async () => {
  const c = start({respond: radarr()});
  await c.settle();
  const M = model();
  const rows = M.queueRows(c.last().queue.items);
  assert.deepEqual(rows.map(r => [r.title, r.phase, r.when, r.tone, r.percent]), [
    ['The Lantern Keeper', 'Downloading', '12 min', 'active', '62%'],
    ['Paper Harbor', 'Downloading', '1 d 2 h', 'active', '18%'],
    ['Static Bloom', 'Can’t import', 'Can’t import', 'warning', '100%'],
    ['Glass Orchard', 'Failed', 'Failed', 'failed', '0%'],
    ['North of Quiet', 'Paused', 'Paused', 'paused', '25%'],
    ['Ember Season', 'Queued', 'Queued', 'waiting', '0%'],
  ]);
  assert.deepEqual([rows[0].meta, rows[0].amount, rows[0].note, rows[0].poster, rows[0].fanart], ['2026 · Bluray-1080p · SABnzbd', '5.0 GB of 8.0 GB', '', true, true]);
  assert.equal(rows[0].key, 'q2');
  assert.equal(rows[2].note, 'No files found are eligible for import in /downloads/Release 3', 'a problem shows Radarr’s reason');
  assert.equal(rows[2].amount, '6.0 GB', 'a finished download shows its size');
  assert.equal(M.queueSummary(c.last().queue.items, 6), '2 downloading · 18.1 GB left · 2 need attention');
  assert.deepEqual(M.queueStats(c.last().queue.items, 9).map(s => s.tone), ['', '', 'warning', '']);
  assert.equal(M.queueSummary(c.last().queue.items, 9), '2 downloading · 18.1 GB left · 2 need attention · 3 more in Radarr');
  assert.equal(M.queueSummary([], 0), 'Nothing downloading');
  assert.deepEqual(M.queueStatus({status: 'completed', state: 'importing'}), {phase: 'Importing', label: 'Importing', tone: 'done'});
  assert.deepEqual(M.queueStatus({status: 'downloadclientunavailable'}), {phase: 'Client unavailable', label: 'Client unavailable', tone: 'warning'});
  assert.equal(M.firstPane('auto', c.last().queue.items), 'queue');
  assert.equal(M.firstPane('auto', []), 'upcoming');
  assert.equal(M.firstPane('queue', []), 'queue');
});

test('the header’s status chip: connecting, live, idle and stale', async () => {
  const M = model();
  assert.equal(M.freshness(null, START).kind, 'loading');
  const c = start({respond: radarr()});
  await c.settle();
  assert.deepEqual(M.freshness(c.last(), START), {kind: 'live', label: 'Live', note: ''});
  const idle = start({respond: radarr({queue: {json: queueEmpty}})});
  await idle.settle();
  assert.deepEqual(M.freshness(idle.last(), START), {kind: 'idle', label: 'Up to date', note: ''});
  assert.deepEqual(M.freshness(c.last(), START + 5 * 60 * 1000),
    {kind: 'stale', label: 'Updated 5 min ago', short: '5 min ago', note: 'Last updated 5 min ago', auth: false}, 'an old queue is stale');
  const refused = start({respond: radarr({queue: {status: 401}})});
  await refused.settle();
  assert.deepEqual(M.freshness(refused.last(), START),
    {kind: 'stale', label: 'Updated just now', short: 'Just now', note: 'Radarr refused the API key (HTTP 401).', auth: true});
});

test('Coming up: missing first, then each movie at its next chosen release within the days asked', async () => {
  const c = start({respond: radarr()});
  await c.settle();
  const {calendar: cal, queue: q} = c.last();
  const M = model();
  const today = '2026-11-27', now = START;
  const all = M.upcomingRows(cal.items, {today, days: 30, types: M.TYPES, queue: q.items, searches: {}, now});
  assert.deepEqual(all.map(r => [r.title, r.detail, r.chip, r.big, r.when, r.state]), [
    ['Tidewater', 'Digital · Wed, Nov 18', 'Missing', '', 'Missing', 'missing'],
    ['The Lantern Keeper', 'Digital · Wed, Nov 25', '62%', '62%', 'Downloading', 'queued'],
    ['Midnight Ferry', 'Digital · Fri, Nov 27', 'Today', '', 'Today', 'upcoming'],
    ['Harbor Lights', 'Physical · Sat, Nov 28', 'Tomorrow', '', 'Tomorrow', 'upcoming'],
    ['The Long Field', 'In cinemas · Fri, Dec 4', 'Dec 4', '', 'In 7 days', 'upcoming'],
    ['Lowlight', 'Physical · Tue, Dec 8', 'Dec 8', '', 'Downloaded', 'downloaded'],
  ]);
  assert.deepEqual([all[2].type, all[2].typeLabel, all[2].dateText, all[2].poster, all[2].fanart], ['digital', 'Digital', 'Fri, Nov 27', true, true]);
  assert.equal(Math.round(all[1].progress * 100), 62, "a queued movie carries its progress");
  assert.equal(M.nextRelease(all, today).title, 'Midnight Ferry', 'an idle queue features the next release still to come');
  assert.equal(M.nextRelease([], today), null);
  assert.deepEqual(['2026-11-27', '2026-11-30', '2026-12-03', '2026-12-04'].map(d => M.chipLabel(d, today)), ['Today', 'In 3 days', 'In 6 days', 'Dec 4']);
  assert.equal(all[0].searchable, true);
  assert.equal(all[1].searchable, false, 'already downloading');
  assert.equal(all[2].others, 'Physical Dec 15');

  const physical = M.upcomingRows(cal.items, {today, days: 30, types: ['physical'], queue: q.items, now});
  assert.deepEqual(physical.map(r => r.title), ['Harbor Lights', 'Lowlight', 'Midnight Ferry']);
  const longer = M.upcomingRows(cal.items, {today, days: 60, types: M.TYPES, queue: q.items, now});
  assert.equal(longer.at(-1).title, 'A Quiet Reckoning on the Far Side of an Unreasonably Long Title');
  assert.equal(longer.at(-1).detail, 'In cinemas · Fri, Jan 8, 2027');
  assert.deepEqual(M.upcomingRows(cal.items, {today, days: 30, types: [], now}), []);
  assert.deepEqual(M.upcomingRows([], {today, days: 30, types: M.TYPES, now}), []);

  const searching = M.upcomingRows(cal.items, {today, days: 30, types: M.TYPES, queue: [], searches: {204: now - 30 * 1000}, now});
  assert.deepEqual([searching[0].title, searching[0].when, searching[0].searchable], ['Tidewater', 'Searching…', false]);
});

// Replies recorded from a real server with scripts/record-radarr.sh, when present.
const recorded = join(root, 'tests', 'radarr', 'recorded');
test('recorded replies from a real Radarr parse into rows', {skip: !existsSync(join(recorded, 'queue.json')) && 'no recorded replies yet'}, async () => {
  const read = file => sample('radarr', 'recorded/' + file);
  const replies = {status: {json: read('system-status.json')}, queue: {json: read('queue.json')}, calendar: {json: read('calendar.json')}};
  const c = start({respond: radarr(replies), start: Date.now()});
  await c.settle();
  const data = c.last();
  for (const name of ['status', 'queue', 'calendar']) assert.equal(data[name].error, null, name);
  assert.equal(typeof data.status.instanceName, 'string');
  const M = model();
  for (const row of M.queueRows(data.queue.items)) assert.ok(row.title && row.when, JSON.stringify(row));
  const today = M.localDay(Date.now(), new Date().getTimezoneOffset());
  for (const row of M.upcomingRows(data.calendar.items, {today, days: 60, types: M.TYPES, queue: data.queue.items, now: Date.now()})) {
    assert.ok(row.title && row.detail && row.when, JSON.stringify(row));
  }
});
