// Weather (example) view model: what to show for a placement, with no DOM, so tests run
// it in Node. view.js draws it.
(function (root) {
  const round = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

  // The connector sends °C; the placement chooses what it reads.
  const temperature = (celsius, units) =>
    round(typeof celsius === 'number' && units === 'fahrenheit' ? celsius * 9 / 5 + 32 : celsius);
  const unitLabel = units => (units === 'fahrenheit' ? '°F' : '°C');
  const windLabel = (kmh, units) => {
    if (typeof kmh !== 'number' || !Number.isFinite(kmh)) return '';
    return units === 'fahrenheit' ? 'Wind ' + Math.round(kmh / 1.609344) + ' mph' : 'Wind ' + Math.round(kmh) + ' km/h';
  };

  // "2026-11-27T15:00" is the place's own local time, so read the hour from the text.
  function hourLabel(time) {
    const hour = Number(String(time).slice(11, 13));
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return '';
    return (hour % 12 || 12) + (hour < 12 ? ' AM' : ' PM');
  }

  function ageLabel(at, now) {
    if (!at) return '';
    const minutes = Math.max(0, Math.round((now - at) / 60000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    const hours = Math.round(minutes / 60);
    return hours + (hours === 1 ? ' hour ago' : ' hours ago');
  }

  const placeName = place => (place ? [place.name, place.region].filter(Boolean).join(', ') : '');

  // One of: empty (no place chosen), loading, notfound, failed (nothing to show) or
  // ready, which may be stale when the latest refresh failed.
  function status(entry, query, now) {
    if (!query) return {kind: 'empty'};
    if (!entry) return {kind: 'loading'};
    if (entry.state === 'notfound') return {kind: 'notfound', query};
    if (!entry.weather) {
      if (entry.state === 'error') return {kind: 'failed', error: entry.error || 'Open-Meteo didn’t answer.'};
      return {kind: 'loading'};
    }
    const stale = entry.state === 'error';
    return {kind: 'ready', stale, note: stale ? 'Last updated ' + ageLabel(entry.at, now) : ''};
  }

  // The reading and its details for a ready entry.
  function reading(entry, units) {
    const w = entry.weather;
    const high = temperature(w.high, units), low = temperature(w.low, units), feels = temperature(w.feelsLike, units);
    const details = [];
    if (feels !== null) details.push('Feels like ' + feels + '°');
    if (high !== null && low !== null) details.push('H ' + high + '° L ' + low + '°');
    const wind = windLabel(w.wind, units);
    if (wind) details.push(wind);
    return {place: placeName(entry.place), temp: temperature(w.temp, units), unit: unitLabel(units), label: w.label || '', detail: details.join(' · ')};
  }

  // The next 24 hours as an SVG path across a width × height box, with a little margin.
  function chartPath(hours, width, height) {
    const temps = (hours || []).map(h => h.temp).filter(t => typeof t === 'number' && Number.isFinite(t));
    if (temps.length < 2) return '';
    const min = Math.min(...temps), max = Math.max(...temps), span = max - min || 1, pad = height * 0.08;
    return 'M' + temps.map((t, i) =>
      (i / (temps.length - 1) * width).toFixed(1) + ',' + (height - pad - (t - min) / span * (height - 2 * pad)).toFixed(1)).join(' L');
  }

  // Every third hour, for the labels under the chart.
  const marks = (hours, units) => (hours || []).filter((_, i) => i % 3 === 0).slice(0, 8)
    .map(h => ({time: hourLabel(h.time), temp: temperature(h.temp, units)}));

  root.WeatherModel = {temperature, unitLabel, windLabel, hourLabel, ageLabel, placeName, status, reading, chartPath, marks};
})(globalThis);
