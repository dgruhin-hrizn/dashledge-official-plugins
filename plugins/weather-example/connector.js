// Weather (example): Dashledge's reference first-party plugin. Current conditions and the
// next 24 hours from Open-Meteo, which needs no account or key.
//
// Weather needs no connection, so one connector serves every placement. Each view names
// its placement's place with the `watch` command and repeats it while it's on screen.
// Places nobody has asked about for a while are dropped. Entries are keyed by what the
// user typed, never by placement, so two placements showing the same city share one
// forecast. Temperatures stay in °C and wind in km/h; the view converts for its units.

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const REFRESH = 10 * 60 * 1000;
const NOT_FOUND_RETRY = 30 * 60 * 1000;
const FORGET_AFTER = 15 * 60 * 1000;
const MAX_PLACES = 16;
const MAX_QUERY = 80;
const HOURS = 24;
const TICK = 15 * 1000;

const places = new Map();

// What the user typed, tidied. Empty or unusable is ''.
function cleanQuery(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (!text || text.length > MAX_QUERY || /[\u0000-\u001f\u007f]/.test(text)) return '';
  return text;
}

const STATES = {al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado',
  ct: 'connecticut', de: 'delaware', dc: 'district of columbia', fl: 'florida', ga: 'georgia', hi: 'hawaii',
  id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana',
  me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi',
  mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey',
  nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma',
  or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina', sd: 'south dakota',
  tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington',
  wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming'};
const COUNTRIES = {usa: 'us', 'united states': 'us', america: 'us', uk: 'gb', 'united kingdom': 'gb', england: 'gb'};

// "Chicago", "Portland, OR", "Paris, France" or "41.88, -87.63". The name goes to the
// geocoder; what follows a comma narrows its results.
function parseQuery(query) {
  const text = cleanQuery(query);
  if (!text) return null;
  const coords = text.match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (coords) {
    const latitude = Number(coords[1]), longitude = Number(coords[2]);
    return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? {coordinates: {latitude, longitude}} : null;
  }
  const [name, ...rest] = text.split(',').map(part => part.trim());
  if (name.length < 2) return null;
  return {name, qualifiers: rest.filter(Boolean).map(q => q.toLowerCase())};
}

function matches(result, qualifier) {
  const fields = [result.admin1, result.admin2, result.country, result.country_code]
    .filter(v => typeof v === 'string').map(v => v.toLowerCase());
  const wanted = [qualifier, STATES[qualifier], COUNTRIES[qualifier]].filter(Boolean);
  return wanted.some(w => fields.some(f => f === w || (w.length >= 3 && f.startsWith(w))));
}

// The best geocoder result, or null. Open-Meteo orders results by relevance and
// population, so with no qualifiers the first wins.
function pickPlace(json, parsed) {
  const results = Array.isArray(json?.results) ? json.results.filter(r =>
    r && typeof r.name === 'string' && Number.isFinite(r.latitude) && Number.isFinite(r.longitude)) : [];
  const hit = results.find(r => (parsed.qualifiers || []).every(q => matches(r, q)));
  if (!hit) return null;
  return {
    name: hit.name,
    region: typeof hit.admin1 === 'string' && hit.admin1 !== hit.name ? hit.admin1 : '',
    country: typeof hit.country === 'string' ? hit.country : '',
    latitude: hit.latitude, longitude: hit.longitude,
  };
}

async function getJson(url) {
  const response = await fetch(url, {headers: {accept: 'application/json'}});
  if (!response.ok) {
    let reason = '';
    try { reason = (await response.json())?.reason || ''; } catch {}
    throw new Error(reason ? String(reason).slice(0, 160) : 'Open-Meteo answered ' + response.status);
  }
  return response.json();
}

// {place} or {notFound: true}. Network trouble throws.
async function geocode(query) {
  const parsed = parseQuery(query);
  if (!parsed) return {notFound: true};
  if (parsed.coordinates) {
    const {latitude, longitude} = parsed.coordinates;
    return {place: {name: latitude.toFixed(2) + ', ' + longitude.toFixed(2), region: '', country: '', latitude, longitude}};
  }
  const url = GEOCODE + '?name=' + encodeURIComponent(parsed.name) + '&count=10&language=en&format=json';
  const place = pickPlace(await getJson(url), parsed);
  return place ? {place} : {notFound: true};
}

const LABELS = {0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow',
  73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers', 81: 'Rain showers', 82: 'Heavy showers',
  85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorms', 96: 'Thunderstorms with hail', 99: 'Thunderstorms with hail'};
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Now, today's high and low, and the next 24 hours after the current one. Null when
// the reply lacks the current reading.
function parseForecast(json) {
  const c = json?.current, h = json?.hourly, d = json?.daily;
  const temp = num(c?.temperature_2m), code = num(c?.weather_code);
  if (temp === null || code === null) return null;
  const times = Array.isArray(h?.time) ? h.time : [];
  const hourOf = typeof c.time === 'string' ? c.time.slice(0, 13) : '';
  let start = times.findIndex(t => typeof t === 'string' && t.slice(0, 13) === hourOf);
  start = start < 0 ? 0 : start + 1;
  const hours = [];
  for (let i = start; i < times.length && hours.length < HOURS; i++) {
    const t = num(h.temperature_2m?.[i]);
    if (typeof times[i] === 'string' && t !== null) hours.push({time: times[i], temp: t});
  }
  return {
    time: typeof c.time === 'string' ? c.time : '',
    temp, feelsLike: num(c.apparent_temperature), code, label: LABELS[code] || 'Cloudy', isDay: c.is_day !== 0,
    wind: num(c.wind_speed_10m),
    high: num(d?.temperature_2m_max?.[0]), low: num(d?.temperature_2m_min?.[0]),
    hours,
  };
}

async function forecast(place) {
  const url = FORECAST + '?latitude=' + place.latitude + '&longitude=' + place.longitude +
    '&current=temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m' +
    '&hourly=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=2';
  const weather = parseForecast(await getJson(url));
  if (!weather) throw new Error('Open-Meteo sent an incomplete forecast');
  return weather;
}

// After `failures` failures in a row: 30 s, 1, 2, 5, then 10 minutes.
const retryDelay = failures => [30, 60, 120, 300, 600][Math.min(Math.max(failures, 1), 5) - 1] * 1000;

const view = e => ({query: e.query, state: e.state, place: e.place, weather: e.weather, at: e.at, error: e.error});

function publish() {
  const out = {};
  for (const [key, e] of places) out[key] = view(e);
  dashledge.emit({places: out});
}

// The last good forecast for each place, so views have something to show after a restart.
function remember() {
  const saved = {};
  for (const [key, e] of places) if (e.weather) saved[key] = {query: e.query, place: e.place, weather: e.weather, at: e.at};
  dashledge.storage.set('places', saved);
}

async function update(e) {
  e.busy = true;
  try {
    if (!e.place) {
      const found = await geocode(e.query);
      if (found.notFound) {
        Object.assign(e, {state: 'notfound', error: null, failures: 0, next: Date.now() + NOT_FOUND_RETRY});
        return;
      }
      e.place = found.place;
    }
    e.weather = await forecast(e.place);
    Object.assign(e, {state: 'ready', at: Date.now(), error: null, failures: 0, next: Date.now() + REFRESH});
    remember();
  } catch (error) {
    // Keep the last good forecast. The view shows it as stale, with when it was read.
    e.failures += 1;
    Object.assign(e, {state: 'error', error: String(error?.message || error).slice(0, 160), next: Date.now() + retryDelay(e.failures)});
  } finally {
    e.busy = false;
    publish();
  }
}

function entry(query, key) {
  let e = places.get(key);
  if (e) return e;
  if (places.size >= MAX_PLACES) {
    // Make room by forgetting the place heard from least recently.
    const oldest = [...places].filter(([, p]) => !p.busy).sort((a, b) => a[1].heard - b[1].heard)[0];
    if (!oldest) return null;
    places.delete(oldest[0]);
  }
  const saved = (dashledge.storage.get('places') || {})[key];
  e = {query, state: 'loading', place: saved?.place || null, weather: saved?.weather || null, at: saved?.at || 0,
    error: null, failures: 0, next: 0, busy: false, heard: 0};
  places.set(key, e);
  return e;
}

// The view sends {query, refresh?} when it appears, when its place changes and every few
// minutes while it's on screen. `refresh` retries now, and searches again for a place
// that wasn't found. Answers with what this connector knows about the place right now.
dashledge.onCommand('watch', args => {
  const query = cleanQuery(args?.query);
  if (!query) return {state: 'empty'};
  const key = query.toLowerCase();
  const e = entry(query, key);
  if (!e) return {state: 'busy'};
  e.heard = Date.now();
  if (args?.refresh && !e.busy) {
    if (e.state === 'notfound') e.place = null;
    e.next = 0;
  }
  if (!e.busy && e.next <= Date.now()) update(e);
  return view(e);
});

setInterval(() => {
  const now = Date.now();
  let dropped = false;
  for (const [key, e] of places) if (now - e.heard > FORGET_AFTER && !e.busy) { places.delete(key); dropped = true; }
  for (const e of places.values()) if (!e.busy && e.next <= now) update(e);
  if (dropped) publish();
}, TICK);
