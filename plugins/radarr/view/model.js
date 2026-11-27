// Radarr view model: what each pane shows, with no DOM, so tests run it in Node. view.js
// draws it. Every function that depends on the date takes `today` (YYYY-MM-DD in the
// viewer's time zone) or `now`, so nothing here reads the clock or the time zone.
(function (root) {
  const TYPES = ['cinema', 'digital', 'physical'];
  const RELEASE = {cinema: 'In cinemas', digital: 'Digital', physical: 'Physical'};
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const BEHIND_DAYS = 14;
  const SEARCH_HOLD = 2 * 60 * 1000;
  // Older than this, a section's data is stale even without an error, as after a restart.
  const MAX_AGE = {queue: 2 * 60 * 1000, calendar: 60 * 60 * 1000};

  // This placement's settings, tidied. `types` is the release types it lists.
  function settings(values) {
    const days = Math.round(Number(values?.days));
    const chosen = Array.isArray(values?.releases) ? values.releases : ['*'];
    const types = chosen.includes('*') ? TYPES.slice() : TYPES.filter(t => chosen.includes(t));
    const first = ['queue', 'upcoming'].includes(values?.first) ? values.first : 'auto';
    return {days: Number.isFinite(days) ? Math.min(60, Math.max(1, days)) : 30, types, first};
  }

  // The viewer's date, given the time and their offset from UTC in minutes (as
  // Date#getTimezoneOffset reports it: positive west of Greenwich).
  const localDay = (now, offsetMinutes) => new Date(now - (offsetMinutes || 0) * 60000).toISOString().slice(0, 10);
  const dayNumber = date => Math.round(Date.parse(date + 'T00:00:00Z') / 86400000);
  const daysBetween = (from, to) => dayNumber(to) - dayNumber(from);
  const addDays = (date, days) => new Date((dayNumber(date) + days) * 86400000).toISOString().slice(0, 10);

  // "Thu, Dec 3", plus the year when it isn't this year.
  function dateLabel(date, today) {
    const d = new Date(date + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return '';
    const label = WEEKDAYS[d.getUTCDay()] + ', ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
    return date.slice(0, 4) === String(today).slice(0, 4) ? label : label + ', ' + date.slice(0, 4);
  }

  // How far off a date is: Today, Tomorrow, In 5 days, Yesterday, 3 days ago.
  function relativeDay(date, today) {
    const n = daysBetween(today, date);
    if (!Number.isFinite(n)) return '';
    if (n === 0) return 'Today';
    if (n === 1) return 'Tomorrow';
    if (n === -1) return 'Yesterday';
    return n > 1 ? 'In ' + n + ' days' : -n + ' days ago';
  }

  // Seconds left as "45 s", "12 min", "2 h 05 min" or "3 d 4 h".
  function duration(total) {
    if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return '';
    if (total < 60) return Math.round(total) + ' s';
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return minutes + ' min';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + ' h ' + String(minutes % 60).padStart(2, '0') + ' min';
    return Math.floor(hours / 24) + ' d ' + (hours % 24) + ' h';
  }

  function bytes(n) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
    return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
  }

  function ageLabel(at, now) {
    if (!at) return '';
    const minutes = Math.max(0, Math.round((now - at) / 60000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    const hours = Math.round(minutes / 60);
    if (hours < 48) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    return Math.round(hours / 24) + ' days ago';
  }

  // What a queue record is doing, in words, and how its bar is drawn: active, paused,
  // waiting, warning, failed or done.
  function queueStatus(item) {
    const {status, state, tracked} = item;
    if (state === 'failed' || state === 'failedpending' || status === 'failed') return {label: 'Failed', tone: 'failed'};
    if (state === 'importing') return {label: 'Importing', tone: 'done'};
    if (state === 'importpending') return {label: tracked === 'warning' ? 'Can’t import' : 'Waiting to import', tone: tracked === 'warning' ? 'warning' : 'done'};
    if (state === 'imported') return {label: 'Imported', tone: 'done'};
    if (status === 'completed') return {label: 'Completed', tone: 'done'};
    if (status === 'paused') return {label: 'Paused', tone: 'paused'};
    if (status === 'queued') return {label: 'Queued', tone: 'waiting'};
    if (status === 'delay') return {label: 'Delayed', tone: 'waiting'};
    if (status === 'downloadclientunavailable') return {label: 'Client unavailable', tone: 'warning'};
    if (status === 'warning' || tracked === 'warning' || tracked === 'error') {
      return {label: duration(item.timeLeft) || 'Warning', tone: 'warning'};
    }
    if (status === 'downloading') return {label: duration(item.timeLeft) || 'Downloading', tone: 'active'};
    return {label: status ? status[0].toUpperCase() + status.slice(1) : 'Unknown', tone: 'waiting'};
  }

  const needsAttention = tone => tone === 'warning' || tone === 'failed';
  const ORDER = {active: 0, done: 1, warning: 2, failed: 3, paused: 4, waiting: 5};

  // One row per queue record: downloading first (soonest done first), then importing,
  // then problems, then paused and queued.
  function queueRows(items) {
    return (items || []).map(item => {
      const s = queueStatus(item);
      const progress = typeof item.progress === 'number' ? item.progress : null;
      const detail = needsAttention(s.tone) && item.message ? item.message : [item.quality, item.client].filter(Boolean).join(' · ');
      return {
        key: 'q' + item.id, movieId: item.movieId, title: item.title, year: item.year || '', poster: item.poster,
        percent: progress === null ? '' : Math.floor(progress * 100) + '%', progress, when: s.label, tone: s.tone, detail,
        sort: [ORDER[s.tone] ?? 9, typeof item.timeLeft === 'number' ? item.timeLeft : Infinity],
      };
    }).sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1]);
  }

  // "3 downloading · 4.1 GB left · 1 needs attention", or "Nothing downloading".
  function queueSummary(items, total) {
    const rows = queueRows(items);
    if (!rows.length) return 'Nothing downloading';
    const downloading = (items || []).filter(i => i.status === 'downloading');
    const problems = rows.filter(r => needsAttention(r.tone)).length;
    const left = bytes(downloading.reduce((sum, i) => sum + (i.left || 0), 0));
    const parts = [downloading.length ? downloading.length + ' downloading' : rows.length + ' in queue'];
    if (left) parts.push(left + ' left');
    if (problems) parts.push(problems + (problems === 1 ? ' needs attention' : ' need attention'));
    if (total > rows.length) parts.push(total - rows.length + ' more in Radarr');
    return parts.join(' · ');
  }

  // Coming up: each movie once, at its next release of the chosen types within `days`.
  // A monitored movie released in the last 14 days that Radarr calls available but has
  // no file for is listed first, as missing, with a Search button.
  function upcomingRows(items, {today, days, types, queue = [], searches = {}, now = 0}) {
    const end = addDays(today, days), start = addDays(today, -BEHIND_DAYS);
    const downloading = new Map((queue || []).map(q => [q.movieId, q]));
    const rows = [];
    for (const movie of items || []) {
      const releases = (movie.releases || [])
        .filter(r => types.includes(r.type) && r.date >= start && r.date <= end)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : TYPES.indexOf(a.type) - TYPES.indexOf(b.type)));
      const next = releases.find(r => r.date >= today);
      const missing = !next && movie.monitored && movie.available && !movie.hasFile;
      const release = next || (missing ? releases[releases.length - 1] : null);
      if (!release) continue;
      const queued = downloading.get(movie.id);
      const searched = searches[movie.id];
      let state = 'upcoming', when = relativeDay(release.date, today), big = '';
      if (movie.hasFile) { state = 'downloaded'; when = 'Downloaded'; }
      else if (queued) {
        state = 'queued';
        when = queued.status === 'downloading' ? 'Downloading' : 'In queue';
        big = typeof queued.progress === 'number' ? Math.floor(queued.progress * 100) + '%' : '';
      }
      else if (missing) { state = searched && now - searched < SEARCH_HOLD ? 'searching' : 'missing'; when = state === 'searching' ? 'Searching…' : 'Missing'; }
      const others = releases.filter(r => r !== release && r.date >= today).map(r => RELEASE[r.type] + ' ' + dateLabel(r.date, today).replace(/^\w+, /, ''));
      rows.push({
        key: 'u' + movie.id, movieId: movie.id, title: movie.title, year: movie.year || '', poster: movie.poster,
        date: release.date, detail: RELEASE[release.type] + ' · ' + dateLabel(release.date, today), others: others.join(' · '),
        when, big, state, searchable: state === 'missing',
      });
    }
    const rank = r => (r.state === 'missing' || r.state === 'searching' ? 0 : 1);
    return rows.sort((a, b) => rank(a) - rank(b) || (a.date < b.date ? -1 : a.date > b.date ? 1 : a.title.localeCompare(b.title)));
  }

  // A pane's state: loading (nothing yet), failed (nothing to show and the read failed),
  // or ready, which is stale when the latest read failed or the data is old.
  function paneState(section, now, maxAge) {
    const at = section?.at || 0, error = section?.error || null;
    if (!at) return error ? {kind: 'failed', error: error.message, auth: error.kind === 'auth'} : {kind: 'loading'};
    const stale = Boolean(error) || now - at > maxAge;
    const note = stale ? ['Last updated ' + ageLabel(at, now), error?.message].filter(Boolean).join(' · ') : '';
    return {kind: 'ready', stale, note, auth: error?.kind === 'auth'};
  }

  // Which pane a small placement opens on.
  function firstPane(choice, queueItems) {
    if (choice === 'queue' || choice === 'upcoming') return choice;
    return queueRows(queueItems).some(r => r.tone === 'active' || r.tone === 'warning') ? 'queue' : 'upcoming';
  }

  root.RadarrModel = {TYPES, MAX_AGE, settings, localDay, daysBetween, addDays, dateLabel, relativeDay, duration, bytes, ageLabel,
    queueStatus, queueRows, queueSummary, upcomingRows, paneState, firstPane};
})(globalThis);
