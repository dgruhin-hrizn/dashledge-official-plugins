// Frigate's tests. The replies in tests/frigate/ were recorded from a real Frigate 0.15.2
// on 2026-11-28 with scripts/record-frigate.sh, which keeps only the fields the plugin
// reads (no camera inputs, passwords, addresses or thumbnails). Two of its six cameras
// are restreamed by go2rtc, each with a _sub stream; four were sending no frames.
// The 0.16 config used below is derived from the recording: live.streams in place of
// live.stream_name, as Frigate 0.16 writes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConnector, loadViewScript, manifest, sample} from './harness.mjs';

const ADDRESS = 'http://frigate.test:5000/';
const connections = [{address: ADDRESS, name: '', type: 'open'}];
const START = Date.UTC(2026, 10, 28, 20);
const replies = {
  config: sample('frigate', 'config.json'),
  stats: sample('frigate', 'stats.json'),
  go2rtc: sample('frigate', 'go2rtc-streams.json'),
  events: sample('frigate', 'events.json'),
};
const route = url => url.slice(ADDRESS.length).split('?')[0];

// A Frigate that answers from the recorded replies. `overrides` replaces one route's reply.
function frigate(overrides = {}) {
  return (url, init) => {
    const r = route(url);
    if (r in overrides) return typeof overrides[r] === 'function' ? overrides[r](url, init) : overrides[r];
    if (r === 'api/config') return {json: replies.config};
    if (r === 'api/stats') return {json: replies.stats};
    if (r === 'api/go2rtc/streams') return {json: replies.go2rtc};
    if (r === 'api/events') return {json: replies.events};
    return {status: 404};
  };
}
const load = (options = {}) => loadConnector('frigate', {connections, start: START, ...options});

function model() {
  const {FrigateModel: m} = loadViewScript('frigate', 'view/model.js');
  // Plain copies: the model runs in its own context, with its own Object and Array.
  const plain = f => (...a) => { const r = f(...a); return r === undefined ? undefined : JSON.parse(JSON.stringify(r?.constructor?.name === 'Set' ? [...r] : r)); };
  return Object.fromEntries(Object.entries(m).map(([k, f]) => [k, typeof f === 'function' ? plain(f) : f]));
}
const M = model();

// ---- Manifest -------------------------------------------------------------------------------

test('the manifest declares only the routes, stream and images the plugin uses', () => {
  const m = manifest('frigate');
  assert.equal(m.id, 'plugin.dashledge.frigate');
  assert.deepEqual(m.streams, [{id: 'live', path: 'live/mse/api/ws?src={stream}'}]);
  assert.deepEqual(m.images, ['api/*/latest.jpg']);
  assert.deepEqual(m.connector.commands, ['watch', 'focus']);
  assert.equal(m.connector.hosts, undefined, 'no outside host');
  const types = Object.fromEntries(m.sources.types.map(t => [t.id, t]));
  assert.deepEqual(types.signin.auth.login, {path: 'api/login', body: 'json', fields: {user: '{user}', password: '{key}'}, session: 'cookie'});
  assert.equal(types.open.auth, 'none');
  for (const t of m.sources.types) assert.deepEqual(t.test, ['api/stats'], 'Test reads JSON that 8971 refuses without a session');
  const settings = Object.fromEntries(m.settings.map(s => [s.id, s]));
  assert.equal(settings.cameras.dynamic, true);
  assert.deepEqual(settings.cameras.default, ['*']);
  assert.equal(settings.names.for, 'cameras');
  assert.deepEqual(settings.look.options.map(o => o.value), ['standard', 'crt', 'crt-mono']);
});

// ---- Connector --------------------------------------------------------------------------------

test('it reads config, go2rtc, stats and events, and emits slim cameras without their inputs', async () => {
  const c = load({respond: frigate()});
  await c.settle();
  assert.deepEqual(c.requests.map(r => route(r.url)).sort(), ['api/config', 'api/events', 'api/go2rtc/streams', 'api/stats']);
  const events = new URL(c.requests.find(r => route(r.url) === 'api/events').url);
  assert.equal(events.searchParams.get('after'), String(START / 1000 - 6 * 3600));
  assert.equal(events.searchParams.get('include_thumbnails'), '0');

  const last = c.last();
  assert.equal(last.connected, true);
  assert.equal(last.error, null);
  assert.equal(last.cameras.length, 6);
  const byName = Object.fromEntries(last.cameras.map(cam => [cam.name, cam]));
  assert.deepEqual(byName.front_door, {name: 'front_door', label: 'Front door', enabled: true, order: 0, dashboard: true,
    aspect: 1.778, main: 'front_door', sub: 'front_door_sub'});
  assert.equal(byName.reolink_doorbell.aspect, 1.333, 'the doorbell is 4:3');
  assert.equal(byName.reolink_doorbell.sub, 'reolink_doorbell_sub');
  assert.deepEqual([byName.driveway.main, byName.driveway.sub], ['', ''], 'go2rtc doesn’t restream it: snapshots only');
  assert.equal(byName.backyard_patio_2.label, 'Backyard patio 2');
  assert.ok(!JSON.stringify(last).includes('rtsp'), 'camera inputs never leave the connector');

  assert.deepEqual(last.signals.front_door, {fps: 5, detecting: true});
  assert.deepEqual(last.signals.driveway, {fps: 0, detecting: true});
  assert.equal(last.server.version, '0.15.2-3bda638');
  assert.equal(last.detections.front_door.length, 2);
  assert.deepEqual(last.detections.front_door[0], {label: 'car', sub: '', start: 1795887695796, end: 1795887700077, score: 0.77});
  assert.ok(last.detections.front_door[0].start > last.detections.front_door[1].start, 'newest first');
});

test('Frigate 0.16 live.streams pick the main stream and a sub stream by name', async () => {
  const config = structuredClone(replies.config);
  config.cameras.front_door.live = {streams: {'Main Stream': 'front_door', 'Sub Stream': 'front_door_sub'}, height: 720};
  config.cameras.reolink_doorbell.live = {streams: {Low: 'reolink_doorbell_sub', High: 'reolink_doorbell'}};
  config.cameras.driveway.live = {streams: {Main: 'driveway_hd'}};
  const go2rtc = {...replies.go2rtc, driveway_hd: {producers: []}};
  const c = load({respond: frigate({'api/config': {json: config}, 'api/go2rtc/streams': {json: go2rtc}})});
  await c.settle();
  const byName = Object.fromEntries(c.last().cameras.map(cam => [cam.name, cam]));
  assert.deepEqual([byName.front_door.main, byName.front_door.sub], ['front_door', 'front_door_sub']);
  assert.deepEqual([byName.reolink_doorbell.main, byName.reolink_doorbell.sub], ['reolink_doorbell', 'reolink_doorbell_sub'], 'the sub-like name is the small one, whatever its order');
  assert.deepEqual([byName.driveway.main, byName.driveway.sub], ['driveway_hd', 'driveway_hd']);
});

test('without go2rtc’s list, every configured stream is tried', async () => {
  const c = load({respond: frigate({'api/go2rtc/streams': {status: 404}})});
  await c.settle();
  const last = c.last();
  assert.equal(last.error, null, 'a missing go2rtc API is not an error');
  assert.ok(last.cameras.every(cam => cam.main === cam.name && cam.sub === cam.name));
});

test('an in-progress detection has no end, and false positives are left out', async () => {
  const events = [
    {...replies.events[0], id: 'a', label: 'person', sub_label: 'Alex', start_time: START / 1000 - 30, end_time: null, data: {top_score: 0.91}},
    {...replies.events[0], id: 'b', false_positive: true, start_time: START / 1000 - 20},
    ...replies.events,
  ];
  const c = load({respond: frigate({'api/events': {json: events}})});
  await c.settle();
  const list = c.last().detections.front_door;
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], {label: 'person', sub: 'Alex', start: START - 30000, end: null, score: 0.91});
});

test('a refused sign-in is an auth error, and cameras from storage stay on screen', async () => {
  const storage = {};
  const first = load({respond: frigate(), storage});
  await first.settle();
  assert.equal(JSON.parse(storage.last).cameras.length, 6);

  const refused = {status: 401, json: {message: 'Unauthorized'}};
  const c = load({storage, respond: frigate({'api/config': refused, 'api/stats': refused, 'api/events': refused, 'api/go2rtc/streams': refused})});
  assert.equal(c.emitted[0].cameras.length, 6, 'a restart draws the last cameras at once');
  assert.equal(c.emitted[0].stale, true);
  await c.settle();
  const last = c.last();
  assert.equal(last.error.kind, 'auth');
  assert.match(last.error.message, /HTTP 401/);
  assert.equal(last.cameras.length, 6);
  assert.equal(last.stale, true);
});

test('a failure, then Retry reads everything again', async () => {
  let down = true;
  const c = load({respond: frigate({'api/stats': () => (down ? {status: 502} : {json: replies.stats})})});
  await c.settle();
  assert.deepEqual(c.last().error, {kind: 'http', message: 'Frigate answered HTTP 502'});
  assert.equal(c.last().cameras.length, 6, 'config still arrived');
  down = false;
  const before = c.requests.length;
  await c.command('watch', {refresh: true});
  assert.equal(c.requests.length - before, 4);
  assert.equal(c.last().error, null);
  assert.equal(c.last().signals.front_door.fps, 5);
});

test('it polls stats and events every 10 seconds and config every 5 minutes, and stops when nobody watches', async () => {
  const c = load({respond: frigate()});
  await c.settle();
  const count = r => c.requests.filter(q => route(q.url) === r).length;
  await c.advance(60 * 1000);
  assert.ok(count('api/stats') >= 6 && count('api/stats') <= 8, 'stats about every 10 s');
  assert.equal(count('api/config'), 1);
  await c.advance(5 * 60 * 1000);
  assert.equal(count('api/config'), 2);
  await c.advance(10 * 60 * 1000);
  const stopped = c.requests.length;
  await c.advance(5 * 60 * 1000);
  assert.equal(c.requests.length, stopped, 'nobody watched for 10 minutes');
  await c.command('watch', {});
  await c.advance(15 * 1000);
  assert.ok(c.requests.length > stopped, 'a view on screen starts it again');
});

test('a reply that isn’t JSON says to check the address', async () => {
  const c = load({respond: frigate({'api/config': {text: '<html>login</html>'}})});
  await c.settle();
  assert.equal(c.last().error.kind, 'format');
  assert.match(c.last().error.message, /Check the address/);
});

test('it remembers where each camera was dragged, across a restart', async () => {
  const storage = {};
  const c = load({respond: frigate(), storage});
  await c.settle();
  assert.deepEqual(c.last().focus, {});
  assert.deepEqual(await c.command('focus', {camera: 'front_door', x: 0.12345, y: 7}), {ok: true});
  assert.deepEqual(c.last().focus, {front_door: {x: 0.123, y: 1}});
  assert.deepEqual(await c.command('focus', {camera: '../etc', x: 0}), {ok: false});
  const again = load({respond: frigate(), storage});
  assert.deepEqual(again.emitted[0].focus, {front_door: {x: 0.123, y: 1}});
});

test('without a connection it asks for one', () => {
  const c = loadConnector('frigate', {connections: []});
  assert.equal(c.last().connected, false);
  assert.equal(c.requests.length, 0);
});

// ---- View model -------------------------------------------------------------------------------

const cams = async () => { const c = load({respond: frigate()}); await c.settle(); return c.last(); };

test('a placement shows every dashboard camera by default, or the ones it names', async () => {
  const data = await cams();
  const all = M.chosen(data.cameras, M.settings({}));
  assert.equal(all.length, 6);
  const two = M.chosen(data.cameras, M.settings({cameras: ['driveway', 'front_door', 'gone']}));
  assert.deepEqual(two.map(c => c.name), ['front_door', 'driveway'], 'in Frigate’s order');
  assert.deepEqual(M.missing(data.cameras, M.settings({cameras: ['driveway', 'gone.cam']})), ['gone_cam']);
  assert.equal(M.label(two[0], M.settings({names: {front_door: 'Porch'}})), 'Porch');
  // Early 1.0.0 builds saved "front.door"; those placements keep their cameras and names.
  assert.deepEqual(M.chosen(data.cameras, M.settings({cameras: ['front.door']})).map(c => c.name), ['front_door']);
  assert.equal(M.label(two[0], M.settings({names: {'front.door': 'Porch'}})), 'Porch');
  const offered = M.offer(data.cameras);
  assert.deepEqual(offered[0], {value: 'front_door', label: 'Front door', detail: 'Live video'});
  assert.equal(offered.find(o => o.value === 'driveway').detail, 'Snapshots only (no go2rtc stream)');
});

// Dashledge's rule for dynamic setting values and names keys (CHOICE_VALUE in
// ui/package-choices.js, choice_value in package-core).
const CHOICE_VALUE = /^[A-Za-z0-9._:@/-]{1,128}$/;
test('every camera value Dashledge stores passes its setting-value rule, and maps back', async () => {
  const data = await cams();
  const offered = M.offer(data.cameras);
  assert.equal(offered.length, 6);
  for (const o of offered) assert.match(o.value, CHOICE_VALUE, o.value);
  for (const c of data.cameras) assert.equal(M.fromValue(M.toValue(c.name)), c.name);
  const picked = M.chosen(data.cameras, M.settings({cameras: offered.map(o => o.value)}));
  assert.equal(picked.length, 6, 'choosing every offered value shows every camera');
});

test('settings fall back to defaults', () => {
  assert.deepEqual(M.settings({look: 'neon', layout: 1}), {cameras: ['*'], names: {}, layout: 'grid', look: 'standard',
    video: 'live', quality: 'auto', fit: 'smart', detections: true});
  assert.equal(M.settings({fit: 'pan'}).fit, 'pan');
  assert.equal(M.settings({fill: false}).fit, 'whole', 'a draft’s fill toggle still means something');
});

test('the grid picks the arrangement that shows each picture largest', () => {
  const a = 16 / 9;
  assert.deepEqual(pick(M.grid(1, 2560, 720, a)), [1, 1]);
  assert.deepEqual(pick(M.grid(3, 2560, 720, a)), [3, 1], 'three across the full Edge');
  assert.deepEqual(pick(M.grid(4, 2560, 720, a)), [4, 1], 'four show as large in a row as in 2 × 2; fewer rows win');
  assert.deepEqual(pick(M.grid(6, 2560, 720, a)), [3, 2]);
  assert.deepEqual(pick(M.grid(6, 1280, 720, a)), [3, 2]);
  assert.deepEqual(pick(M.grid(4, 640, 720, a)), [2, 2]);
  assert.deepEqual(pick(M.grid(4, 400, 1000, a)), [1, 4], 'a narrow column stacks');
  assert.deepEqual(pick(M.grid(4, 540, 1920, a)), [1, 4], 'vertical Edge');
  assert.deepEqual(pick(M.grid(2, 230, 160, a)), [1, 2], 'the smallest section Dashledge allows');
  const rects = M.gridRects(5, 1280, 720, a, 8);
  assert.equal(rects.length, 5);
  assert.ok(rects.every(r => r.x >= 0 && r.y >= 0 && r.x + r.w <= 1280 + 1 && r.y + r.h <= 720 + 1));
  const lastRow = rects.slice(3);
  assert.ok(lastRow[0].x > 0, 'a short last row is centred');
});
const pick = g => [g.cols, g.rows];

test('spotlight puts one camera large and the rest beside or below it', () => {
  const a = 16 / 9;
  const wide = M.spotlightRects(4, 2560, 720, a, 10);
  assert.equal(wide[0].h, 720);
  assert.equal(wide[0].w, 1280, 'full height at 16:9');
  assert.ok(wide.slice(1).every(r => r.x >= 1290));
  const tall = M.spotlightRects(3, 540, 1920, a, 10);
  assert.equal(tall[0].w, 540);
  assert.ok(tall.slice(1).every(r => r.y >= tall[0].h + 10));
  assert.deepEqual(M.spotlightRects(1, 800, 400, a, 10), [{x: 0, y: 0, w: 800, h: 400}]);
});

test('up to four tiles play live: offline cameras, snapshot-only cameras and refused streams don’t', async () => {
  const data = await cams();
  const prefs = M.settings({});
  const live = M.liveSet(M.chosen(data.cameras, prefs).map(camera => ({camera})), prefs, data.signals);
  assert.deepEqual(live, ['front_door', 'reolink_doorbell'], 'the others send no frames or have no stream');

  const many = Array.from({length: 7}, (_, i) => ({camera: {name: 'c' + i, main: 'c' + i, sub: ''}}));
  assert.deepEqual(M.liveSet(many, prefs, {}), ['c0', 'c1', 'c2', 'c3'], 'at most four, in order, before stats arrive');
  const {FrigateModel: raw} = loadViewScript('frigate', 'view/model.js');
  assert.deepEqual([...raw.liveSet(many, prefs, {}, new Set(['c1']))], ['c0', 'c2', 'c3', 'c4'], 'a refused camera waits');
  assert.deepEqual(M.liveSet(many, M.settings({video: 'snapshots'}), {}), []);
});

test('smart fit crops a little, but shows a panorama whole over a blurred copy', () => {
  // The front door's dual-lens panorama (5120 × 1552) in a 16 : 9 tile would lose 46 %.
  const pano = M.fit(1280, 720, 5120 / 1552, 'smart');
  assert.deepEqual([pano.cover, pano.backdrop, pano.pan], [false, true, false]);
  assert.deepEqual([pano.dw, Math.round(pano.dh), Math.round(pano.dy)], [1280, 388, 166]);
  // The same panorama in a wide grid tile (853 × 356) loses 27 %: cropped to fill, centred.
  const wide = M.fit(853, 356, 5120 / 1552, 'smart');
  assert.equal(wide.cover, true);
  assert.equal(Math.round(wide.dh), 356);
  assert.equal(Math.round(wide.dx * 2), Math.round(853 - wide.dw));
  // A 16 : 9 camera fills a 16 : 9 tile exactly; whole never crops or blurs.
  assert.deepEqual(M.fit(1280, 720, 16 / 9, 'smart'), {cover: true, backdrop: false, pan: false, dw: 1280, dh: 720, dx: 0, dy: 0});
  const whole = M.fit(1280, 720, 5120 / 1552, 'whole');
  assert.deepEqual([whole.cover, whole.backdrop, whole.pan, whole.dw], [false, false, false, 1280]);
});

test('fill and drag always fills, and the focus picks the part that shows', () => {
  const left = M.fit(1280, 720, 5120 / 1552, 'pan', {x: 0, y: 0.5});
  assert.deepEqual([left.cover, left.backdrop, left.pan], [true, false, true]);
  assert.equal(left.dh, 720);
  assert.equal(left.dx, 0, 'the left edge');
  const right = M.fit(1280, 720, 5120 / 1552, 'pan', {x: 1, y: 0.5});
  assert.equal(Math.round(right.dx + right.dw), 1280, 'the right edge');
  const centre = M.fit(1280, 720, 5120 / 1552, 'pan');
  assert.equal(Math.round(centre.dx * 2), Math.round(1280 - centre.dw));
  const tall = M.fit(400, 800, 16 / 9, 'pan', {x: 0.25, y: 9});
  assert.equal(tall.dy, 0, 'a focus out of range is clamped; there’s nothing to pan vertically');
  assert.equal(M.fit(1280, 720, 16 / 9, 'pan').pan, false, 'a picture that fits exactly has nothing to drag');
});

test('quality picks the sub stream for small tiles', () => {
  const cam = {main: 'front_door', sub: 'front_door_sub'};
  assert.equal(M.stream(cam, 300, 'auto'), 'front_door_sub');
  assert.equal(M.stream(cam, 720, 'auto'), 'front_door');
  assert.equal(M.stream(cam, 300, 'main'), 'front_door');
  assert.equal(M.stream(cam, 720, 'sub'), 'front_door_sub');
  assert.equal(M.stream(cam, 720, 'auto', 'crt'), 'front_door_sub', 'a CRT can’t show the main stream’s detail');
  assert.equal(M.stream(cam, 720, 'main', 'crt-mono'), 'front_door');
  assert.equal(M.stream({main: '', sub: ''}, 720, 'auto'), '');
  assert.equal(M.snapshotHeight(300), 360);
  assert.equal(M.snapshotHeight(5000), 1080);
});

test('Dashledge’s refusal and go2rtc’s missing stream are recognised', () => {
  assert.equal(M.isCapError('A widget may keep at most 4 streams open.'), true);
  assert.equal(M.isCapError('Stream limit: this placement may keep at most 4 streams open.'), true);
  assert.equal(M.isCapError('Stream limit: this widget may keep at most 16 streams open across its placements.'), true);
  assert.equal(M.isCapError('Stream error'), false);
  assert.equal(M.isMissingStream('mse: stream not found'), true);
});

test('signals tell live, no signal, off and unknown apart', () => {
  const signals = {a: {fps: 5}, b: {fps: 0}};
  assert.equal(M.signal({name: 'a'}, signals), 'live');
  assert.equal(M.signal({name: 'b'}, signals), 'offline');
  assert.equal(M.signal({name: 'a', enabled: false}, signals), 'off');
  assert.equal(M.signal({name: 'c'}, signals), 'unknown');
});

test('detections read as what’s in view now, or the last one seen', () => {
  const now = START;
  assert.deepEqual(M.detection([{label: 'person', sub: '', start: now - 5000, end: null}, {label: 'car', sub: 'Mail van', start: now - 9000, end: null}], now),
    {active: true, text: 'Person, Mail van', when: 'now'});
  assert.deepEqual(M.detection([{label: 'license_plate', sub: '', start: now - 200000, end: now - 180000}], now),
    {active: false, text: 'License plate', when: '3 min ago'});
  assert.equal(M.detection([{label: 'car', sub: '', start: now - 4 * 3600e3, end: now - 3 * 3600e3}], now), null, 'older than two hours');
  assert.equal(M.detection([], now), null);
});

test('the widget’s state: loading, no connection, failed, ready with a banner', () => {
  assert.equal(M.status(null, '').kind, 'loading');
  assert.equal(M.status({connected: false}, '').kind, 'noconnection');
  assert.deepEqual(M.status({connected: true, cameras: [], error: {kind: 'auth', message: 'no'}}, ''), {kind: 'failed', error: 'no', auth: true});
  assert.equal(M.status({connected: true, cameras: [], error: null, updated: {config: 0}}, '').kind, 'loading');
  assert.deepEqual(M.status({connected: true, cameras: [{}], error: {kind: 'http', message: 'x'}, stale: true}, ''), {kind: 'ready', error: 'x', auth: false, stale: true});
  assert.equal(M.status({connected: true}, 'boom').kind, 'stopped');
});

test('the CRT on-screen display numbers cameras and shows a VCR-style clock', () => {
  assert.deepEqual(M.osd(0, new Date(2026, 10, 28, 9, 4, 7)), {cam: 'CAM 01', date: '11-28-2026', time: '09:04:07'});
});
