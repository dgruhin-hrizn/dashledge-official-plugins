// Sonarr view model: what a placement shows, with no DOM, so tests run it in Node.
// view.js draws it. Times are shown in `zone`, the Mac's time zone unless a test names one.
(function (root) {
  const DAY = 24 * 60 * 60 * 1000;
  const pad = n => String(n).padStart(2, '0');
  const code = (season, episode) => 'S' + pad(season) + 'E' + pad(episode);

  // Days since 1970 of the calendar date `when` falls on in `zone`.
  function dayIndex(when, zone) {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'})
      .formatToParts(new Date(when));
    const get = type => Number(parts.find(p => p.type === type)?.value);
    return Math.round(Date.UTC(get('year'), get('month') - 1, get('day')) / DAY);
  }

  // "Today", "Tomorrow", "Wed" this week, "Wed, Dec 9" further out; and "9:00 PM".
  function when(iso, now, zone) {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return {day: '', time: ''};
    const diff = dayIndex(at, zone) - dayIndex(now, zone);
    const day = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday'
      : new Intl.DateTimeFormat('en-US', diff > 1 && diff < 7 ? {timeZone: zone, weekday: 'short'}
        : {timeZone: zone, weekday: 'short', month: 'short', day: 'numeric'}).format(at);
    // Some ICU versions put a narrow no-break space before AM/PM.
    const time = new Intl.DateTimeFormat('en-US', {timeZone: zone, hour: 'numeric', minute: '2-digit'}).format(at).replace(/\s/g, ' ');
    return {day, time};
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

  function ageLabel(at, now) {
    if (!at) return '';
    const minutes = Math.max(0, Math.round((now - at) / 60000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    const hours = Math.round(minutes / 60);
    return hours + (hours === 1 ? ' hour ago' : ' hours ago');
  }

  const STATES = {
    downloading: ['Downloading', 'ok'], paused: ['Paused', 'paused'], queued: ['Queued', 'paused'],
    delay: ['Delayed', 'paused'], completed: ['Completed', 'ok'], importPending: ['Waiting to import', 'warning'],
    importing: ['Importing', 'ok'], imported: ['Imported', 'ok'], warning: ['Needs attention', 'warning'],
    failed: ['Failed', 'error'],
  };
  const stateOf = state => STATES[state] || STATES.downloading;
  // Problems first, since they need someone; then what's downloading, soonest done first.
  const RANK = {failed: 0, warning: 1, importPending: 2, importing: 3, downloading: 4, completed: 5, imported: 5,
    queued: 6, delay: 7, paused: 8};

  const percent = progress => (typeof progress === 'number' && Number.isFinite(progress) ? Math.floor(progress * 100) : null);

  // A queue row's second line: one episode, a season pack, or several episodes.
  function episodesLabel(episodes) {
    const list = Array.isArray(episodes) ? episodes : [];
    if (list.length === 1) return code(list[0].season, list[0].episode) + (list[0].title ? ' · ' + list[0].title : '');
    if (!list.length) return '';
    const seasons = new Set(list.map(e => e.season));
    return seasons.size === 1 ? 'Season ' + list[0].season + ' · ' + list.length + ' episodes' : list.length + ' episodes';
  }

  // The queue, ready to draw.
  function queueRows(items) {
    return (Array.isArray(items) ? items : []).map((row, index) => {
      const [label, tone] = stateOf(row.state);
      const pct = percent(row.progress);
      const left = row.state === 'downloading' ? duration(row.timeLeft) : '';
      const problem = (tone === 'warning' || tone === 'error') && row.message ? row.message : '';
      return {
        key: row.key, seriesId: row.seriesId, series: row.series,
        detail: problem ? [episodesLabel(row.episodes).split(' · ')[0], problem].filter(Boolean).join(' · ') : episodesLabel(row.episodes),
        progress: pct, percent: pct === null ? '—' : pct + '%',
        note: left ? left + ' left' : label, state: row.state, label, tone,
        order: [RANK[row.state] ?? 4, row.state === 'downloading' && typeof row.timeLeft === 'number' ? row.timeLeft : Infinity, index],
      };
    }).sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2])
      .map(({order, ...row}) => row);
  }

  // Episodes from today through `days` days (counting today) in `zone`, joined with the
  // queue: each says whether it's downloaded, downloading, being searched for, missing
  // (aired, monitored, no file: it can be searched) or still to air. Yesterday's episodes
  // stay while they have no file, so last night's missed episode can still be searched.
  function upcoming(data, settings, now, zone) {
    const days = Math.min(14, Math.max(1, Math.round(Number(settings?.days) || 7)));
    const today = dayIndex(now, zone);
    const queued = new Map();
    for (const row of data?.queue?.items || []) for (const e of row.episodes || []) queued.set(e.id, row);
    const searching = new Set(data?.searching || []);
    const rows = [];
    for (const e of data?.calendar?.items || []) {
      const at = Date.parse(e.airDateUtc);
      if (!Number.isFinite(at)) continue;
      const diff = dayIndex(at, zone) - today;
      if (diff < -1 || diff >= days || (diff === -1 && e.hasFile)) continue;
      if (settings?.hideDownloaded && e.hasFile) continue;
      const q = queued.get(e.id);
      let state, label, progress = null, canSearch = false;
      if (e.hasFile) { state = 'downloaded'; label = 'Downloaded'; }
      else if (q) {
        const [qLabel, tone] = stateOf(q.state);
        progress = percent(q.progress);
        state = tone === 'error' || tone === 'warning' ? 'trouble' : 'downloading';
        label = q.state === 'downloading' && progress !== null ? 'Downloading ' + progress + '%' : qLabel;
      } else if (searching.has(e.id)) { state = 'searching'; label = 'Searching…'; }
      else if (at <= now && e.monitored) { state = 'missing'; label = 'Missing'; canSearch = true; }
      else { state = 'upcoming'; label = ''; }
      const w = when(e.airDateUtc, now, zone);
      rows.push({
        id: e.id, seriesId: e.seriesId, series: e.series,
        detail: code(e.season, e.episode) + (e.title ? ' · ' + e.title : '') + (e.finale ? ' · ' + e.finale[0].toUpperCase() + e.finale.slice(1) + ' finale' : ''),
        day: w.day, time: w.time, state, label, progress, canSearch,
      });
    }
    return {days, rows};
  }

  // What the whole placement shows:
  //   stopped (the connector stopped), noconnection, loading, failed (nothing to show:
  //   wrong key or Sonarr unavailable), or ready, with a stale note when the last
  //   refresh of something already shown failed.
  function status(data, stopped, now) {
    if (stopped && !data?.connected) return {kind: 'stopped', error: stopped};
    if (!data) return {kind: 'loading'};
    if (data.connected === false) return {kind: 'noconnection'};
    const feeds = [data.calendar, data.queue].filter(Boolean);
    const shown = feeds.filter(f => Array.isArray(f.items));
    if (!shown.length) {
      const failed = feeds.find(f => f.state === 'error');
      if (failed && feeds.every(f => f.state === 'error')) {
        return {kind: 'failed', auth: feeds.some(f => f.kind === 'auth'), error: failed.error || 'Sonarr didn’t answer.'};
      }
      return {kind: 'loading'};
    }
    const stale = shown.filter(f => f.state === 'error');
    if (!stale.length && !stopped) return {kind: 'ready', stale: false, note: '', auth: false};
    const oldest = Math.min(...(stale.length ? stale : shown).map(f => f.at || now));
    const error = stale[0]?.error || stopped;
    return {kind: 'ready', stale: true, auth: stale.some(f => f.kind === 'auth'),
      note: 'Last updated ' + ageLabel(oldest, now) + (error ? ' · ' + error : '')};
  }

  // One pane's own state, once the placement is ready.
  function pane(feed) {
    if (!feed || !Array.isArray(feed.items)) {
      return feed?.state === 'error' ? {kind: 'failed', error: feed.error, auth: feed.kind === 'auth'} : {kind: 'loading'};
    }
    return {kind: feed.items.length ? 'list' : 'empty'};
  }

  root.SonarrModel = {code, dayIndex, when, duration, ageLabel, episodesLabel, queueRows, upcoming, status, pane};
})(globalThis);
