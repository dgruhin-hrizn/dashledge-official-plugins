// Sonarr view model: what each pane shows, with no DOM, so tests run it in Node. view.js
// draws it. Times are shown in `zone`, the Mac's time zone unless a test names one, and
// every function that depends on the time takes `now`, so nothing here reads the clock.
(function (root) {
  const DAY = 24 * 60 * 60 * 1000;
  const pad = n => String(n).padStart(2, '0');
  const code = (season, episode) => 'S' + pad(season) + 'E' + pad(episode);
  // Older than this, a section's data is stale even without an error, as after a restart.
  const MAX_AGE = {queue: 2 * 60 * 1000, calendar: 60 * 60 * 1000};

  // This placement's settings, tidied.
  function settings(values) {
    return {
      days: Math.min(14, Math.max(1, Math.round(Number(values?.days) || 7))),
      hideDownloaded: values?.hideDownloaded === true,
      pane: values?.pane === 'queue' ? 'queue' : 'upcoming',
    };
  }

  // Days since 1970 of the calendar date `when` falls on in `zone`.
  function dayIndex(when, zone) {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'})
      .formatToParts(new Date(when));
    const get = type => Number(parts.find(p => p.type === type)?.value);
    return Math.round(Date.UTC(get('year'), get('month') - 1, get('day')) / DAY);
  }

  // "Today", "Tomorrow", "Wed" this week, "Wed, Dec 9" further out; and "9:00 PM".
  // `chip` is the short form a poster carries: "Dec 9" rather than "Wed, Dec 9".
  function when(iso, now, zone) {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return {day: '', time: '', chip: '', diff: NaN};
    const diff = dayIndex(at, zone) - dayIndex(now, zone);
    const near = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : '';
    const format = options => new Intl.DateTimeFormat('en-US', {timeZone: zone, ...options}).format(at);
    const day = near || (diff > 1 && diff < 7 ? format({weekday: 'short'}) : format({weekday: 'short', month: 'short', day: 'numeric'}));
    const chip = near || (diff > 1 && diff < 7 ? day : format({month: 'short', day: 'numeric'}));
    // Some ICU versions put a narrow no-break space before AM/PM.
    const time = format({hour: 'numeric', minute: '2-digit'}).replace(/\s/g, ' ');
    return {day, time, chip, diff};
  }

  // 754 → "12 min", 7500 → "2 h 05 min", 97200 → "1 d 3 h".
  function duration(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
    if (seconds < 60) return '<1 min';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + ' min';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + ' h ' + pad(minutes % 60) + ' min';
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

  // What a queue row is doing: its phase in words and the tone it's drawn in (active,
  // done, warning, failed, paused or waiting).
  const STATES = {
    downloading: ['Downloading', 'active'], importing: ['Importing', 'done'], imported: ['Imported', 'done'],
    completed: ['Completed', 'done'], importPending: ['Waiting to import', 'done'], warning: ['Needs attention', 'warning'],
    failed: ['Failed', 'failed'], paused: ['Paused', 'paused'], queued: ['Queued', 'waiting'], delay: ['Delayed', 'waiting'],
  };
  const stateOf = state => STATES[state] || STATES.downloading;
  const needsAttention = tone => tone === 'warning' || tone === 'failed';
  // Downloading first (soonest done first), then importing, then problems, then the rest.
  const ORDER = {active: 0, done: 1, warning: 2, failed: 3, paused: 4, waiting: 5};

  const percent = progress => (typeof progress === 'number' && Number.isFinite(progress) ? Math.floor(progress * 100) : null);

  // What a download holds: one episode, a season pack, or several episodes.
  function episodesLabel(episodes) {
    const list = Array.isArray(episodes) ? episodes : [];
    if (list.length === 1) return code(list[0].season, list[0].episode) + (list[0].title ? ' · ' + list[0].title : '');
    if (!list.length) return '';
    const seasons = new Set(list.map(e => e.season));
    return seasons.size === 1 ? 'Season ' + list[0].season + ' · ' + list.length + ' episodes' : list.length + ' episodes';
  }

  // One card per download, ready to draw. The eyebrow carries the episode and phase
  // ("S02E10 · Downloading"); the title is the series.
  function queueRows(items) {
    return (Array.isArray(items) ? items : []).map((row, index) => {
      const [phase, tone] = stateOf(row.state);
      const progress = typeof row.progress === 'number' && Number.isFinite(row.progress) ? row.progress : null;
      const pct = percent(progress);
      const [which, ...rest] = episodesLabel(row.episodes).split(' · ');
      const done = row.size > 0 ? bytes(row.size - (row.left || 0)) || '0 B' : '';
      return {
        key: row.key, seriesId: row.seriesId, title: row.series, poster: row.poster !== false, fanart: row.fanart !== false,
        phase, tone, eyebrow: [which, phase].filter(Boolean).join(' · '),
        meta: [rest.join(' · '), row.quality, row.client].filter(Boolean).join(' · '),
        note: needsAttention(tone) ? row.message || '' : '',
        progress, percent: pct === null ? '' : pct + '%',
        left: row.state === 'downloading' ? duration(row.timeLeft) : '',
        amount: done && progress !== null && progress < 1 ? done + ' of ' + bytes(row.size) : bytes(row.size),
        order: [ORDER[tone] ?? 9, row.state === 'downloading' && typeof row.timeLeft === 'number' ? row.timeLeft : Infinity, index],
      };
    }).sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2])
      .map(({order, ...row}) => row);
  }

  // The header's figures: [{text, tone}], such as "2 downloading", "4.8 GB left" and
  // "1 needs attention" (tone warning), or "Nothing downloading".
  function queueStats(items, more) {
    const list = Array.isArray(items) ? items : [];
    const rows = queueRows(list);
    if (!rows.length) return [{text: 'Nothing downloading', tone: ''}];
    const downloading = list.filter(i => i.state === 'downloading');
    const problems = rows.filter(r => needsAttention(r.tone)).length;
    const left = bytes(downloading.reduce((sum, i) => sum + (i.left || 0), 0));
    const stats = [{text: downloading.length ? downloading.length + ' downloading' : rows.length + ' in queue', tone: ''}];
    if (left) stats.push({text: left + ' left', tone: ''});
    if (problems) stats.push({text: problems + (problems === 1 ? ' needs attention' : ' need attention'), tone: 'warning'});
    if (more > 0) stats.push({text: more + ' more in Sonarr', tone: ''});
    return stats;
  }

  // Episodes from today through `days` days (counting today) in `zone`, joined with the
  // queue: each says whether it's downloaded, downloading (or in trouble), being searched
  // for, missing (aired, monitored, no file: it can be searched) or still to air.
  // Yesterday's episodes stay while they have no file, so last night's missed episode can
  // still be searched. Missing episodes come first, then the rest by air time.
  function upcoming(data, values, now, zone) {
    const {days, hideDownloaded} = settings(values);
    const queued = new Map();
    for (const row of data?.queue?.items || []) for (const e of row.episodes || []) queued.set(e.id, row);
    const searching = new Set(data?.searching || []);
    const rows = [];
    for (const e of data?.calendar?.items || []) {
      const at = Date.parse(e.airDateUtc);
      if (!Number.isFinite(at)) continue;
      const w = when(e.airDateUtc, now, zone);
      if (w.diff < -1 || w.diff >= days || (w.diff === -1 && e.hasFile)) continue;
      if (hideDownloaded && e.hasFile) continue;
      const q = queued.get(e.id);
      let state, label, chip = w.chip, progress = null, canSearch = false;
      if (e.hasFile) { state = 'downloaded'; label = 'Downloaded'; }
      else if (q) {
        const [phase, tone] = stateOf(q.state);
        progress = percent(q.progress);
        state = needsAttention(tone) ? 'trouble' : 'downloading';
        label = q.state === 'downloading' && progress !== null ? 'Downloading ' + progress + '%' : phase;
        chip = q.state === 'downloading' && progress !== null ? progress + '%' : phase;
      } else if (searching.has(e.id)) { state = 'searching'; label = chip = 'Searching…'; }
      else if (at <= now && e.monitored) { state = 'missing'; label = chip = 'Missing'; canSearch = true; }
      else { state = 'upcoming'; label = ''; }
      rows.push({
        key: 'e' + e.id, id: e.id, seriesId: e.seriesId, series: e.series, at,
        poster: e.poster !== false, fanart: e.fanart !== false,
        code: code(e.season, e.episode), title: e.title || '',
        detail: code(e.season, e.episode) + (e.title ? ' · ' + e.title : '') + (e.finale ? ' · ' + e.finale[0].toUpperCase() + e.finale.slice(1) + ' finale' : ''),
        day: w.day, time: w.time, chip, soon: state === 'upcoming' || state === 'downloaded' ? w.diff === 0 || w.diff === 1 : false,
        state, label, progress, canSearch,
      });
    }
    const rank = r => (r.state === 'missing' || r.state === 'searching' ? 0 : 1);
    return {days, rows: rows.sort((a, b) => rank(a) - rank(b) || a.at - b.at || a.id - b.id)};
  }

  // The episode an idle queue features: the next one still to air.
  const nextUp = (rows, now) => (rows || []).find(r => r.state === 'upcoming' && r.at > now) || null;

  // What the whole placement shows: stopped (the connector stopped), loading,
  // noconnection, failed (nothing read yet and every read failed: one message for the
  // widget, not one per pane), or ready.
  function status(data, stopped, now) {
    if (stopped && !data?.connected) return {kind: 'stopped', error: stopped};
    if (!data) return {kind: 'loading'};
    if (data.connected === false) return {kind: 'noconnection'};
    const q = paneState(data.queue, now, MAX_AGE.queue), c = paneState(data.calendar, now, MAX_AGE.calendar);
    if (q.kind === 'failed' && c.kind === 'failed') return {kind: 'failed', auth: q.auth || c.auth, error: q.error || c.error};
    if (q.kind === 'loading' && c.kind === 'loading') return {kind: 'loading'};
    return {kind: 'ready'};
  }

  // One pane's state: loading (nothing yet), failed (nothing to show and the read
  // failed), or ready, which is stale when the latest read failed or the data is old.
  function paneState(feed, now, maxAge) {
    if (!feed || !Array.isArray(feed.items)) {
      return feed?.state === 'error' ? {kind: 'failed', error: feed.error || 'Sonarr didn’t answer.', auth: feed.kind === 'auth'} : {kind: 'loading'};
    }
    const at = feed.at || 0;
    const failed = feed.state === 'error';
    const stale = failed || !at || now - at > maxAge;
    const note = stale ? [at ? 'Last updated ' + ageLabel(at, now) : '', failed ? feed.error : ''].filter(Boolean).join(' · ') : '';
    return {kind: 'ready', stale, note, auth: failed && feed.kind === 'auth'};
  }

  // The header's status chip: live (something is downloading), idle, stale (with when
  // and why, and Retry) or connecting. Stale wins when either section is.
  function freshness(data, now) {
    if (!data?.connected) return {kind: 'loading', label: data?.connected === false ? 'Not set up' : 'Connecting', short: '', note: ''};
    const q = paneState(data.queue, now, MAX_AGE.queue), c = paneState(data.calendar, now, MAX_AGE.calendar);
    if (q.kind === 'loading' && c.kind === 'loading') return {kind: 'loading', label: 'Connecting', short: '', note: ''};
    const stale = [q, c].find(s => s.stale || s.kind === 'failed');
    if (stale) {
      const at = Math.max(data.queue?.at || 0, data.calendar?.at || 0);
      const age = at ? ageLabel(at, now) : '';
      return {kind: 'stale', label: at ? 'Updated ' + age : 'Unavailable', short: age ? age[0].toUpperCase() + age.slice(1) : 'Offline',
        note: stale.note || stale.error || '', auth: Boolean(stale.auth)};
    }
    const busy = (data.queue?.items || []).some(i => i.state === 'downloading');
    return {kind: busy ? 'live' : 'idle', label: busy ? 'Live' : 'Up to date', short: '', note: ''};
  }

  root.SonarrModel = {MAX_AGE, settings, code, dayIndex, when, duration, bytes, ageLabel, episodesLabel, queueRows, queueStats,
    upcoming, nextUp, status, paneState, freshness};
})(globalThis);
