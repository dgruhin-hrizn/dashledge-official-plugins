// Sonarr's tests. The replies in tests/sonarr/ are synthetic: written from Sonarr's
// published v3 OpenAPI shapes with invented series, since no real server was recorded
// yet. scripts/record-sonarr.sh replaces them with a real server's, anonymised.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {loadConnector, loadViewScript, sample} from './harness.mjs';

const ADDRESS = 'http://sonarr.test:8989/';
const connections = [{address: ADDRESS, name: '', type: ''}];
const START = Date.UTC(2026, 10, 27, 19);
const replies = {
  status: sample('sonarr', 'system-status.json'),
  calendar: sample('sonarr', 'calendar.json'),
  queue: sample('sonarr', 'queue.json'),
  emptyCalendar: sample('sonarr', 'calendar-empty.json'),
  emptyQueue: sample('sonarr', 'queue-empty.json'),
  command: sample('sonarr', 'command-episode-search.json'),
};

const route = url => url.slice(ADDRESS.length).split('?')[0];

// A Sonarr that answers from the recorded replies. `overrides` replaces one route's reply.
// Every request's init is kept, so tests can see its headers and body.
function sonarr(overrides = {}, seen = []) {
  return (url, init) => {
    seen.push({url, init});
    const r = route(url);
    if (r in overrides) return typeof overrides[r] === 'function' ? overrides[r](url, init) : overrides[r];
    if (r === 'api/v3/system/status') return {json: replies.status};
    if (r === 'api/v3/calendar') return {json: replies.calendar};
    if (r === 'api/v3/queue') return {json: replies.queue};
    if (r === 'api/v3/command' && init.method === 'POST') return {status: 201, json: replies.command};
    return {status: 404};
  };
}

const load = (options = {}) => loadConnector('sonarr', {connections, ...options});

function model() {
  const {SonarrModel: m} = loadViewScript('sonarr', 'view/model.js');
  // Plain copies: the model runs in its own context, with its own Object and Array.
  return Object.fromEntries(Object.entries(m).map(([k, f]) => [k, (...a) => JSON.parse(JSON.stringify(f(...a)) ?? 'null')]));
}
const M = model();

test('it reads status, calendar and queue, and sends the view a slim snapshot', async () => {
  const seen = [];
  const c = load({respond: sonarr({}, seen)});
  await c.settle();
  const urls = c.requests.map(r => r.url);
  assert.deepEqual(urls.map(route).sort(), ['api/v3/calendar', 'api/v3/queue', 'api/v3/system/status']);
  const calendar = new URL(urls.find(u => route(u) === 'api/v3/calendar'));
  assert.equal(calendar.searchParams.get('start'), '2026-11-26T19:00:00.000Z', 'a day back, in UTC');
  assert.equal(calendar.searchParams.get('end'), '2026-12-12T19:00:00.000Z', 'the longest window a placement can ask for');
  assert.equal(calendar.searchParams.get('includeSeries'), 'true');
  const queue = new URL(urls.find(u => route(u) === 'api/v3/queue'));
  assert.equal(queue.searchParams.get('pageSize'), '50', 'Sonarr sends only 10 without it');
  assert.equal(queue.searchParams.get('includeEpisode'), 'true');
  for (const {init} of seen) {
    const headers = Object.keys(init.headers || {}).map(h => h.toLowerCase());
    assert.ok(!headers.includes('x-api-key'), 'Dashledge adds the key; the connector never sets it');
  }

  const last = c.last();
  assert.equal(last.connected, true);
  assert.deepEqual(last.status, {instanceName: 'Sonarr (Den)', version: '4.0.11.2680'});
  assert.equal(last.calendar.state, 'ready');
  assert.equal(last.calendar.items.length, 9);
  assert.deepEqual(last.calendar.items[2], {id: 5002, seriesId: 102, series: 'Orbit Street', season: 1, episode: 4,
    title: 'Docking Fees', airDateUtc: '2026-11-27T14:00:00Z', hasFile: false, monitored: true, finale: ''});
  assert.equal(last.calendar.items.find(e => e.id === 5005).finale, 'season');

  assert.equal(last.queue.state, 'ready');
  assert.equal(last.queue.total, 6);
  const rows = last.queue.items;
  assert.equal(rows.length, 4, 'the season pack’s three records are one download');
  const [saltmarsh, pack, ledger, orbit] = rows;
  assert.deepEqual([saltmarsh.series, saltmarsh.progress, saltmarsh.timeLeft, saltmarsh.state], ['Saltmarsh', 0.75, 250, 'downloading']);
  assert.deepEqual(saltmarsh.episodes, [{id: 5003, season: 2, episode: 10, title: 'High Water'}]);
  assert.deepEqual(pack.episodes.map(e => e.episode), [1, 2, 3]);
  assert.deepEqual([pack.progress, pack.timeLeft, pack.protocol], [0.25, 93784, 'torrent'], '1.02:03:04 is a day and 2 hours');
  assert.deepEqual([ledger.state, ledger.message], ['warning', 'No files found are eligible for import']);
  assert.deepEqual([orbit.state, orbit.timeLeft], ['paused', null]);

  // What reaches the view is a small fraction of Sonarr's replies: no series objects,
  // paths, release names or download IDs.
  const text = JSON.stringify(last);
  assert.ok(text.length < 6000, text.length + ' bytes');
  for (const word of ['overview', 'images', '/tv/', 'EXAMPLE', 'SABnzbd_nzo', 'downloadId', 'path']) {
    assert.ok(!text.includes(word), 'no ' + word);
  }
});

test('the server name comes from status, where displayName.serverField points', async () => {
  const c = load({respond: sonarr()});
  await c.settle();
  const {manifest} = await import('./harness.mjs');
  const field = manifest('sonarr').displayName.serverField;
  assert.equal(field.split('.').reduce((v, k) => v?.[k], c.last()), 'Sonarr (Den)');
});

test('a placement without a connection asks for one and reads nothing', async () => {
  const c = loadConnector('sonarr', {respond: sonarr()});
  await c.settle();
  assert.deepEqual(c.last(), {connected: false});
  assert.deepEqual(await c.command('watch', {}), {connected: false});
  assert.deepEqual(await c.command('search', {episodeId: 5002}), {ok: false, error: 'No Sonarr connection'});
  assert.equal(c.requests.length, 0);
  assert.equal(M.status(c.last(), '', START).kind, 'noconnection');
});

test('a wrong API key is reported as such, backs off, and Retry tries again', async () => {
  const c = load({respond: () => ({status: 401})});
  await c.settle();
  const last = c.last();
  for (const feed of [last.calendar, last.queue]) {
    assert.deepEqual([feed.state, feed.kind, feed.items], ['error', 'auth', null]);
    assert.equal(feed.error, 'Sonarr refused the API key (HTTP 401)');
  }
  assert.deepEqual(M.status(last, '', START), {kind: 'failed', auth: true, error: 'Sonarr refused the API key (HTTP 401)'});
  const tries = c.requests.length;
  await c.advance(25 * 1000);
  assert.equal(c.requests.length, tries, 'no retry within 30 seconds');
  await c.command('watch', {refresh: true});
  await c.settle();
  assert.equal(c.requests.length, tries * 2, 'Retry reads everything again at once');
});

test('Sonarr unavailable with nothing to show is a failure, not a wrong key', async () => {
  const c = load({respond: () => { throw new Error('connect ECONNREFUSED'); }});
  await c.settle();
  const s = M.status(c.last(), '', START);
  assert.deepEqual(s, {kind: 'failed', auth: false, error: 'Sonarr didn’t answer: connect ECONNREFUSED'});
});

test('a reply that isn’t JSON points at the URL', async () => {
  const c = load({respond: () => ({status: 200, text: '<html>Sign in</html>'})});
  await c.settle();
  assert.equal(c.last().queue.error, 'Sonarr’s reply wasn’t JSON. Check the Sonarr URL.');
});

test('a failed refresh keeps the last reading, shows it as stale, then recovers', async () => {
  let down = false;
  const c = load({respond: (url, init) => (down && route(url) === 'api/v3/queue' ? {status: 503} : sonarr()(url, init))});
  await c.settle();
  down = true;
  await c.advance(10 * 1000);
  const stale = c.last();
  assert.deepEqual([stale.queue.state, stale.queue.error, stale.queue.items.length], ['error', 'Sonarr answered HTTP 503', 4]);
  assert.equal(stale.queue.at, START, 'when it was last read');
  const s = M.status(stale, '', START + 12 * 60000);
  assert.deepEqual(s, {kind: 'ready', stale: true, auth: false, note: 'Last updated 12 min ago · Sonarr answered HTTP 503'});
  down = false;
  await c.advance(30 * 1000);
  assert.equal(c.last().queue.state, 'ready');
  assert.equal(M.status(c.last(), '', START).stale, false);
});

test('the queue is read every 10 seconds while something downloads, every 30 when empty', async () => {
  let empty = false;
  const c = load({respond: (url, init) => (empty && route(url) === 'api/v3/queue' ? {json: replies.emptyQueue} : sonarr()(url, init))});
  await c.settle();
  const queueReads = () => c.requests.filter(r => route(r.url) === 'api/v3/queue').length;
  await c.advance(30 * 1000);
  assert.equal(queueReads(), 4);
  empty = true;
  await c.advance(10 * 1000);
  const before = queueReads();
  await c.advance(25 * 1000);
  assert.equal(queueReads(), before);
  await c.advance(10 * 1000);
  assert.equal(queueReads(), before + 1);
  assert.deepEqual(c.last().queue.items, []);
  assert.equal(M.pane(c.last().queue).kind, 'empty');
  // A download that left the queue was probably imported: the calendar is read again soon.
  assert.ok(c.requests.filter(r => route(r.url) === 'api/v3/calendar').length >= 2);
});

test('with nobody watching for 15 minutes it stops polling, and a view starts it again', async () => {
  const c = load({respond: sonarr()});
  await c.settle();
  await c.advance(16 * 60 * 1000);
  const quiet = c.requests.length;
  await c.advance(10 * 60 * 1000);
  assert.equal(c.requests.length, quiet, 'no requests while nobody watches');
  const answer = await c.command('watch', {});
  assert.equal(answer.queue.items.length, 4, 'the view hears what’s known at once');
  await c.settle();
  assert.ok(c.requests.length > quiet);
});

test('the last good reading survives a restart, for the same server only', async () => {
  const storage = {};
  const before = load({respond: sonarr(), storage});
  await before.settle();
  const after = load({respond: () => { throw new Error('offline'); }, storage, start: START + 60000});
  const answer = await after.command('watch', {});
  assert.equal(answer.calendar.items.length, 9, 'shown at once from storage');
  assert.equal(answer.queue.items.length, 4);
  assert.equal(answer.status.instanceName, 'Sonarr (Den)');
  await after.settle();
  const stale = after.last();
  assert.equal(stale.queue.state, 'error');
  assert.equal(M.status(stale, '', START + 5 * 60000).stale, true);
  assert.ok(JSON.stringify(storage).length < 131072, 'fits the declared storage');

  const other = loadConnector('sonarr', {connections: [{address: 'http://other.test:8989/', name: '', type: ''}],
    respond: () => { throw new Error('offline'); }, storage});
  assert.equal((await other.command('watch', {})).queue.items, null, 'another server starts empty');
});

test('Search asks Sonarr for one missing episode, and only one that qualifies', async () => {
  const seen = [];
  const c = load({respond: sonarr({}, seen)});
  await c.settle();
  assert.deepEqual(await c.command('search', {episodeId: 5002}), {ok: true});
  const post = c.requests.find(r => r.method === 'POST');
  assert.equal(post.url, ADDRESS + 'api/v3/command');
  assert.deepEqual(JSON.parse(post.body), {name: 'EpisodeSearch', episodeIds: [5002]});
  assert.deepEqual(c.last().searching, [5002]);
  const reads = c.requests.filter(r => route(r.url) === 'api/v3/queue').length;
  await c.advance(5 * 1000);
  assert.equal(c.requests.filter(r => route(r.url) === 'api/v3/queue').length, reads + 1, 'the queue is read again soon');

  const refused = 'Only a missing episode that has aired can be searched';
  assert.deepEqual(await c.command('search', {episodeId: 5001}), {ok: false, error: refused}, 'already downloaded');
  assert.deepEqual(await c.command('search', {episodeId: 5006}), {ok: false, error: refused}, 'not aired yet');
  for (const id of [424242, '5002', -1, null]) {
    assert.deepEqual(await c.command('search', {episodeId: id}), {ok: false, error: 'That episode isn’t in Sonarr’s calendar'});
  }
  assert.equal(c.requests.filter(r => r.method === 'POST').length, 1);
  await c.advance(3 * 60 * 1000);
  assert.deepEqual(c.last().searching, [], 'Searching… fades after a few minutes');
});

test('a refused search says why', async () => {
  const c = load({respond: sonarr({'api/v3/command': {status: 500}})});
  await c.settle();
  assert.deepEqual(await c.command('search', {episodeId: 5002}), {ok: false, error: 'Sonarr answered HTTP 500'});
});

test('Upcoming follows the placement’s days, time zone and hidden downloads', async () => {
  const c = load({respond: sonarr()});
  await c.settle();
  const data = c.last();
  const ids = list => list.rows.map(r => r.id);

  const utc = M.upcoming(data, {days: 7}, START, 'UTC');
  assert.equal(utc.days, 7);
  assert.deepEqual(ids(utc), [5001, 5002, 5003, 5004, 5005], 'today in UTC and the 6 days after; not yesterday');
  const [beam, docking, high, opening, harvest] = utc.rows;
  assert.deepEqual([beam.state, beam.label, beam.day, beam.time], ['downloaded', 'Downloaded', 'Today', '2:00 AM']);
  assert.deepEqual([docking.state, docking.label, docking.canSearch], ['missing', 'Missing', true]);
  assert.deepEqual([high.state, high.label, high.progress], ['downloading', 'Downloading 75%', 75], 'joined with the queue');
  assert.deepEqual([opening.state, opening.label, opening.day, opening.canSearch], ['upcoming', '', 'Tomorrow', false]);
  assert.equal(harvest.detail, 'S01E08 · Harvest · Season finale');
  assert.equal(harvest.day, 'Mon');
  const week = M.upcoming(data, {days: 8}, START, 'UTC');
  assert.deepEqual(ids(week), [5001, 5002, 5003, 5004, 5005, 5006, 5007]);
  assert.equal(week.rows[5].day, 'Fri, Dec 4', 'a week out names the date');
  assert.ok(!ids(M.upcoming(data, {days: 14}, START, 'UTC')).includes(5008), 'two weeks on is past the longest window');

  // In New York the 02:00 UTC episode aired yesterday evening, and 01:00 UTC tomorrow is tonight.
  const ny = M.upcoming(data, {days: 1}, START, 'America/New_York');
  assert.deepEqual(ids(ny), [5002, 5003, 5004]);
  assert.deepEqual([ny.rows[2].day, ny.rows[2].time], ['Today', '8:00 PM']);

  assert.deepEqual(ids(M.upcoming(data, {days: 2, hideDownloaded: true}, START, 'UTC')), [5002, 5003, 5004]);
  assert.equal(M.upcoming(data, {days: 99}, START, 'UTC').days, 14);
  assert.equal(M.upcoming(data, {}, START, 'UTC').days, 7, 'the default');

  const searching = M.upcoming({...data, searching: [5002]}, {days: 1}, START, 'UTC').rows.find(r => r.id === 5002);
  assert.deepEqual([searching.state, searching.label, searching.canSearch], ['searching', 'Searching…', false]);

  const nothing = M.upcoming({...data, calendar: {state: 'ready', items: replies.emptyCalendar}}, {days: 7}, START, 'UTC');
  assert.deepEqual(nothing.rows, []);
});

test('the queue reads problems first, then soonest done, with labels and time left', async () => {
  const c = load({respond: sonarr()});
  await c.settle();
  const rows = M.queueRows(c.last().queue.items);
  assert.deepEqual(rows.map(r => [r.series, r.percent, r.note, r.tone]), [
    ['Northern Ledger', '100%', 'Needs attention', 'warning'],
    ['Saltmarsh', '75%', '4 min left', 'ok'],
    ['Copper & Vine', '25%', '1 d 2 h left', 'ok'],
    ['Orbit Street', '40%', 'Paused', 'paused'],
  ]);
  assert.deepEqual(rows.map(r => r.detail), [
    'S04E12 · No files found are eligible for import',
    'S02E10 · High Water',
    'Season 1 · 3 episodes',
    'S01E03 · Gravity Assist',
  ]);
  assert.equal(M.queueRows([{key: 'q1', series: 'X', episodes: [], progress: null, state: 'queued'}])[0].percent, '—');
});

test('the view model’s labels and states', () => {
  assert.deepEqual([0, 30, 754, 7500, 97200, -1, null].map(M.duration), ['<1 min', '<1 min', '12 min', '2 h 05 min', '1 d 3 h', '', '']);
  assert.equal(M.code(1, 5), 'S01E05');
  assert.equal(M.episodesLabel([{season: 1, episode: 1}, {season: 2, episode: 1}]), '2 episodes');
  assert.equal(M.ageLabel(START - 2 * 3600000, START), '2 hours ago');
  assert.deepEqual(M.status(null, '', START), {kind: 'loading'});
  assert.deepEqual(M.status(null, 'Connector stopped', START), {kind: 'stopped', error: 'Connector stopped'});
  assert.deepEqual(M.status({connected: true, status: null, calendar: {state: 'loading', items: null}, queue: {state: 'loading', items: null}}, '', START), {kind: 'loading'});
  assert.deepEqual(M.pane({state: 'error', kind: 'http', error: 'Sonarr answered HTTP 500', items: null}),
    {kind: 'failed', error: 'Sonarr answered HTTP 500', auth: false});
  assert.deepEqual(M.pane({state: 'loading', items: null}), {kind: 'loading'});
  assert.deepEqual(M.pane({state: 'ready', items: [{}]}), {kind: 'list'});
});

// Replies recorded from a real Sonarr with scripts/record-sonarr.sh, when someone has.
// They change with every recording, so this checks what holds for any server.
const RECORDED = new URL('./sonarr/recorded/', import.meta.url);
const recorded = ['system-status.json', 'calendar.json', 'queue.json'].every(f => existsSync(new URL(f, RECORDED)));
test('replies recorded from a real Sonarr read cleanly', {skip: !recorded && 'no replies in tests/sonarr/recorded yet'}, async () => {
  const real = name => sample('sonarr', 'recorded/' + name);
  const status = real('system-status.json'), calendar = real('calendar.json'), queue = real('queue.json');
  const storage = {};
  const c = load({storage, respond: url => ({json: {
    'api/v3/system/status': status, 'api/v3/calendar': calendar, 'api/v3/queue': queue}[route(url)]})});
  await c.settle();
  const last = c.last();
  assert.equal(last.calendar.state, 'ready', last.calendar.error);
  assert.equal(last.queue.state, 'ready', last.queue.error);
  assert.equal(last.calendar.items.length, Math.min(calendar.length, 120));
  assert.equal(last.queue.total, queue.totalRecords ?? queue.records.length);
  assert.ok(last.queue.items.length <= queue.records.length, 'a season pack is one row');
  for (const e of last.calendar.items) assert.ok(Number.isInteger(e.id) && Number.isInteger(e.seriesId) && e.series);
  for (const row of last.queue.items) {
    assert.ok(row.progress === null || (row.progress >= 0 && row.progress <= 1));
    assert.ok(row.timeLeft === null || row.timeLeft >= 0);
  }
  assert.ok(JSON.stringify(last).length < 1024 * 1024, 'within emit’s 1 MiB');
  assert.ok(JSON.stringify(storage).length < 131072, 'within the declared storage');
  M.queueRows(last.queue.items);
  M.upcoming(last, {days: 14}, START, 'UTC');
});
