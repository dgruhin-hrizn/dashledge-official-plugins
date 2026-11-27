import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConnector, loadViewScript, sample} from './harness.mjs';

const geocode = sample('weather-example', 'geocode-portland.json');
const forecast = sample('weather-example', 'forecast-portland.json');
const GEO = 'https://geocoding-api.open-meteo.com/';
const FORECAST = 'https://api.open-meteo.com/';

// Recorded Open-Meteo replies: any place search finds the Portlands, any forecast is Portland, OR.
const openMeteo = (overrides = {}) => url => {
  if (url.startsWith(GEO)) return overrides.geocode ?? {json: geocode};
  if (url.startsWith(FORECAST)) return overrides.forecast ?? {json: forecast};
  return {status: 404};
};

test('a placement’s place is found, then its forecast arrives for every view', async () => {
  const c = loadConnector('weather-example', {respond: openMeteo()});
  const first = await c.command('watch', {query: '  Portland  '});
  assert.equal(first.state, 'loading', 'the view hears right away that it’s on its way');
  await c.settle();
  assert.equal(c.requests.length, 2);
  assert.ok(c.requests[0].url.startsWith(GEO + 'v1/search?name=Portland&'), c.requests[0].url);
  assert.ok(c.requests[1].url.startsWith(FORECAST + 'v1/forecast?latitude=45.52345&longitude=-122.67621&'), c.requests[1].url);
  const place = c.last().places.portland;
  assert.equal(place.state, 'ready');
  assert.equal(place.query, 'Portland', 'what the user typed, tidied');
  assert.deepEqual([place.place.name, place.place.region, place.place.country], ['Portland', 'Oregon', 'United States']);
  assert.equal(place.weather.temp, 9.9);
  assert.equal(place.weather.label, 'Light rain');
  assert.deepEqual([place.weather.high, place.weather.low], [12.3, 6.6]);
  assert.equal(place.weather.hours.length, 24);
  assert.equal(place.weather.hours[0].time, '2026-11-27T12:00', 'starts after the current hour');
});

test('a qualifier narrows the place, and coordinates skip the search', async () => {
  const c = loadConnector('weather-example', {respond: openMeteo()});
  await c.command('watch', {query: 'Portland, ME'});
  await c.command('watch', {query: '41.88, -87.63'});
  await c.settle();
  const {places} = c.last();
  assert.equal(places['portland, me'].place.region, 'Maine');
  assert.equal(places['41.88, -87.63'].place.name, '41.88, -87.63');
  assert.equal(c.requests.filter(r => r.url.startsWith(GEO)).length, 1, 'only the named place was searched');
  assert.ok(c.requests.some(r => r.url.includes('latitude=41.88&longitude=-87.63')));
});

test('an unknown place says so and is searched again on Retry', async () => {
  const c = loadConnector('weather-example', {respond: openMeteo({geocode: {json: {}}})});
  await c.command('watch', {query: 'Nowhereville'});
  await c.settle();
  assert.equal(c.last().places.nowhereville.state, 'notfound');
  assert.ok(!c.requests.some(r => r.url.startsWith(FORECAST)));
  await c.command('watch', {query: 'Nowhereville'});
  await c.settle();
  assert.equal(c.requests.length, 1, 'no new search until the retry time or Retry');
  await c.command('watch', {query: 'Nowhereville', refresh: true});
  await c.settle();
  assert.equal(c.requests.length, 2);
});

test('a failed refresh keeps the last forecast and backs off', async () => {
  let fail = false;
  const c = loadConnector('weather-example', {respond: url =>
    fail && url.startsWith(FORECAST) ? {status: 500, json: {reason: 'Too many requests'}} : openMeteo()(url)});
  await c.command('watch', {query: 'Portland'});
  await c.settle();
  fail = true;
  await c.advance(10 * 60 * 1000);
  const stale = c.last().places.portland;
  assert.equal(stale.state, 'error');
  assert.equal(stale.error, 'Too many requests', 'Open-Meteo’s reason, not just a status');
  assert.equal(stale.weather.temp, 9.9, 'the last good forecast stays');
  const tries = c.requests.length;
  await c.advance(20 * 1000);
  assert.equal(c.requests.length, tries, 'no retry within 30 seconds');
  fail = false;
  await c.advance(20 * 1000);
  assert.equal(c.last().places.portland.state, 'ready');
});

test('a first load that fails reports the error with nothing to show', async () => {
  const c = loadConnector('weather-example', {respond: openMeteo({forecast: {status: 503}})});
  await c.command('watch', {query: 'Portland'});
  await c.settle();
  const failed = c.last().places.portland;
  assert.deepEqual([failed.state, failed.weather, failed.error], ['error', null, 'Open-Meteo answered 503']);
});

test('the last good forecast survives a restart', async () => {
  const storage = {};
  const before = loadConnector('weather-example', {respond: openMeteo(), storage});
  await before.command('watch', {query: 'Portland'});
  await before.settle();
  const after = loadConnector('weather-example', {respond: () => { throw new Error('offline'); }, storage});
  const answer = await after.command('watch', {query: 'portland'});
  assert.equal(answer.weather.temp, 9.9, 'shown at once from storage');
  assert.equal(answer.place.region, 'Oregon');
});

test('places nobody asks about are forgotten', async () => {
  const c = loadConnector('weather-example', {respond: openMeteo()});
  await c.command('watch', {query: 'Portland'});
  await c.command('watch', {query: 'Paris'});
  await c.settle();
  await c.advance(10 * 60 * 1000);
  await c.command('watch', {query: 'Paris'});
  await c.advance(6 * 60 * 1000);
  assert.deepEqual(Object.keys(c.last().places), ['paris']);
});

test('an empty or unusable place starts nothing', async () => {
  const c = loadConnector('weather-example', {respond: openMeteo()});
  assert.deepEqual(await c.command('watch', {query: '   '}), {state: 'empty'});
  assert.deepEqual(await c.command('watch', {query: 'x'.repeat(81)}), {state: 'empty'});
  await c.settle();
  assert.equal(c.requests.length, 0);
});

test('the view model shows each state and converts units', () => {
  const {WeatherModel: model} = loadViewScript('weather-example', 'view/model.js');
  // Plain copies: the model runs in its own context, with its own Object and Array.
  const M = Object.fromEntries(Object.entries(model).map(([k, f]) => [k, (...a) => JSON.parse(JSON.stringify(f(...a)) ?? 'null')]));
  const now = Date.UTC(2026, 10, 27, 19);
  assert.equal(M.temperature(9.9, 'fahrenheit'), 50);
  assert.equal(M.temperature(9.9, 'celsius'), 10);
  assert.equal(M.temperature(null, 'celsius'), null);
  assert.equal(M.windLabel(5.6, 'fahrenheit'), 'Wind 3 mph');
  assert.equal(M.windLabel(5.6, 'celsius'), 'Wind 6 km/h');
  assert.deepEqual(['2026-11-27T00:00', '2026-11-27T12:00', '2026-11-27T15:00'].map(M.hourLabel), ['12 AM', '12 PM', '3 PM']);

  assert.equal(M.status(null, '', now).kind, 'empty');
  assert.equal(M.status(null, 'Portland', now).kind, 'loading');
  assert.equal(M.status({state: 'notfound'}, 'Nowhere', now).kind, 'notfound');
  assert.deepEqual(M.status({state: 'error', weather: null, error: 'Open-Meteo answered 503'}, 'Portland', now), {kind: 'failed', error: 'Open-Meteo answered 503'});
  const weather = {temp: 9.9, feelsLike: 9, label: 'Light rain', wind: 5.6, high: 12.3, low: 6.6, hours: [{time: '2026-11-27T12:00', temp: 10}, {time: '2026-11-27T13:00', temp: 11}]};
  assert.deepEqual(M.status({state: 'ready', weather, at: now}, 'Portland', now), {kind: 'ready', stale: false, note: ''});
  assert.deepEqual(M.status({state: 'error', weather, at: now - 12 * 60000}, 'Portland', now), {kind: 'ready', stale: true, note: 'Last updated 12 min ago'});

  const r = M.reading({place: {name: 'Portland', region: 'Oregon'}, weather}, 'fahrenheit');
  assert.deepEqual(r, {place: 'Portland, Oregon', temp: 50, unit: '°F', label: 'Light rain', detail: 'Feels like 48° · H 54° L 44° · Wind 3 mph'});
  assert.equal(M.chartPath(weather.hours, 240, 80), 'M0.0,73.6 L240.0,6.4');
  assert.equal(M.chartPath([], 240, 80), '', 'no line without two hours');
  assert.deepEqual(M.marks(forecast.hourly.time.slice(12, 36).map((time, i) => ({time, temp: forecast.hourly.temperature_2m[12 + i]})), 'celsius').length, 8);
});
