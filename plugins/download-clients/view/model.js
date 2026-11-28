// Pure helpers for the Downloads view: formatting and turning the connector's clients into
// what the view draws. No DOM here, so the tests can run it.
(function (root) {
  const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const STALE_AFTER = 20000;     // a client unread for this long is shown as stale
  const ORDER = {downloading: 0, processing: 1, checking: 2, stalled: 3, queued: 4, paused: 5, failed: 6, seeding: 7};
  const STATE_LABEL = {downloading: 'Downloading', processing: 'Processing', checking: 'Checking', stalled: 'Stalled',
    queued: 'Queued', paused: 'Paused', failed: 'Failed', seeding: 'Uploading'};
  // A card's colour: active is the accent, warning amber, failed danger, waiting and paused muted.
  const TONE = {downloading: 'active', processing: 'active', checking: 'active', stalled: 'warning',
    queued: 'waiting', paused: 'paused', failed: 'failed', seeding: 'done'};
  const EXTENSION = /\.(nzb|torrent|mkv|mp4|m4v|avi|iso|zip|rar|7z|flac|mp3|m4a|m4b|epub|pdf)$/i;

  // Usenet and torrent names are dot-separated ("Show.Name.S01E05.1080p.WEB.H.264-GRP"). With
  // no spaces at all, dots and underscores become spaces, except in a number like 5.1 or 24.04
  // (a dot between digits with one or two after it; "2025.1080p" is a year and a resolution).
  function cleanName(name) {
    const raw = String(name || '').trim();
    let text = raw.replace(EXTENSION, '');
    const keep = (str, i) => /\d/.test(str[i - 1] || '') && /^\d{1,2}(?!\d)/.test(str.slice(i + 1));
    if (!/\s/.test(text) && /[._]/.test(text)) text = text.replace(/_+/g, ' ').replace(/\./g, (dot, i, str) => keep(str, i) ? '.' : ' ');
    return text.replace(/\s+/g, ' ').trim() || raw;
  }

  // Three significant digits, so a changing value keeps its width: 1.23, 12.3, 123.
  function bytes(n) {
    n = Math.max(0, Number(n) || 0);
    let i = 0;
    while (n >= 1000 && i < UNITS.length - 1) { n /= 1024; i++; }
    const value = i === 0 ? String(Math.round(n)) : n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : String(Math.round(n));
    return {value, unit: UNITS[i]};
  }
  const size = n => { const b = bytes(n); return b.value + ' ' + b.unit; };
  function speed(n) { const b = bytes(n); return {value: b.value, unit: b.unit + '/s'}; }
  const speedText = n => { const s = speed(n); return s.value + ' ' + s.unit; };

  function eta(seconds) {
    if (seconds === null || seconds === undefined || !(seconds > 0)) return '';
    if (seconds < 60) return 'under a minute';
    const m = Math.round(seconds / 60);
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60), mm = m % 60;
    if (h < 24) return h + ' h' + (mm ? ' ' + mm + ' min' : '');
    const d = Math.floor(h / 24), hh = h % 24;
    return d + ' d' + (hh ? ' ' + hh + ' h' : '');
  }

  function ago(at, now) {
    if (!at) return '';
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  }

  // How a client is doing: ok, paused, stale (last good reading is old), failed (nothing to
  // show) or loading (no answer yet).
  function clientState(c, now) {
    if (!c.reading) return c.error ? 'failed' : 'loading';
    if (!c.ok && (c.error || c.restored)) return 'stale';
    if (c.restored) return 'stale';
    if (c.at && now - c.at > STALE_AFTER) return 'stale';
    if (c.reading.offline) return 'offline';
    return c.reading.paused ? 'paused' : 'ok';
  }

  function clientNote(c, state, now) {
    if (state === 'failed') return c.error || 'Unavailable';
    if (state === 'loading') return 'Connecting…';
    if (state === 'stale') return (c.error ? c.error + ' · ' : '') + 'from ' + ago(c.at, now);
    if (state === 'offline') return 'Not connected to peers';
    const r = c.reading;
    if (state === 'paused') return 'Paused' + (r.total ? ' · ' + r.total + ' in queue' : '');
    if (r.speed > 0) return speedText(r.speed);
    const busy = (r.items || []).some(item => item.state === 'processing');
    return busy ? 'Processing' : r.total ? 'Idle · ' + r.total + ' in queue' : 'Idle';
  }

  function itemRight(item) {
    if (item.state === 'downloading') return eta(item.eta) || (item.speed ? speedText(item.speed) : Math.floor(item.progress * 100) + '%');
    if (item.state === 'seeding') return speedText(item.speed) + ' up';
    return item.detail || STATE_LABEL[item.state] || '';
  }

  // "5.00 GB of 8.00 GB", or the size alone once nothing is left.
  function itemAmount(item) {
    if (!(item.size > 0)) return '';
    if (item.state === 'processing' || item.state === 'seeding' || !(item.left > 0)) return size(item.size);
    return size(item.size - item.left) + ' of ' + size(item.size);
  }

  function itemMeta(item) {
    const parts = [];
    if (item.state === 'processing' || item.state === 'seeding') parts.push(size(item.size));
    else if (item.size > 0) parts.push(size(item.size - item.left) + ' of ' + size(item.size));
    if (item.state === 'downloading' && item.speed && item.eta) parts.push(speedText(item.speed));
    if (item.detail && item.state !== 'processing' && item.state !== 'failed' && item.detail !== STATE_LABEL[item.state]) parts.push(item.detail);
    if (item.category) parts.push(item.category);
    return parts.join(' · ');
  }

  // The header's status chip: stale (some client isn't answering), paused, live or idle.
  function freshness(views, usable, {allPaused, total, now}) {
    const down = views.filter(v => v.state === 'failed' || v.state === 'stale');
    if (down.length) {
      const first = down[0];
      const raw = usable.find(c => c.i === first.i);
      const age = first.state === 'stale' && raw ? ago(raw.at, now) : '';
      const who = views.length > 1 ? first.name + ' ' : '';
      return {kind: 'stale', label: age ? who + 'updated ' + age : who + 'unavailable',
        short: age ? age[0].toUpperCase() + age.slice(1) : 'Offline', note: down.map(v => v.name + ': ' + v.note).join('\n')};
    }
    if (allPaused) return {kind: 'paused', label: 'Paused', short: '', note: ''};
    return total > 0 ? {kind: 'live', label: 'Live', short: '', note: ''} : {kind: 'idle', label: 'Up to date', short: '', note: ''};
  }

  // The speed graph: SVG paths for `samples` (bytes per second, oldest first) in a width × height
  // box, right-aligned so the newest sample is at the right edge and older ones scroll left.
  function trend(samples, width, height, slots) {
    const n = Math.max(2, slots || samples.length);
    const list = samples.slice(-n);
    const peak = Math.max(0, ...list);
    if (list.length < 2 || !(peak > 0)) return {line: '', area: '', peak};
    const step = width / (n - 1);
    const top = height * 0.12;
    const points = list.map((v, i) => [width - (list.length - 1 - i) * step, height - (Math.max(0, v) / peak) * (height - top)]);
    const line = points.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join('');
    const area = line + 'L' + width + ' ' + height + 'L' + points[0][0].toFixed(1) + ' ' + height + 'Z';
    return {line, area, peak};
  }

  // Everything the view draws, from the connector's data and this placement's settings.
  function summarize(data, settings, now) {
    const clients = (data && data.clients) || [];
    const showFinished = settings?.finished !== false;
    const showSeeding = settings?.seeding === true;
    const views = clients.map(c => {
      const state = clientState(c, now);
      return {i: c.i, type: c.type, label: c.label, name: c.name || c.host || c.label,
        state, note: clientNote(c, state, now), paused: !!c.reading?.paused,
        // qBittorrent offers Pause only while something downloads, and Resume only for what it paused.
        canPause: !!c.reading && state !== 'failed' && c.reading.canPause !== false};
    });
    const usable = clients.filter(c => c.reading);
    if (!clients.length) return {status: 'loading', clients: views, items: [], finished: []};
    if (!usable.length) {
      return views.every(v => v.state === 'failed')
        ? {status: 'failed', clients: views, items: [], finished: [], error: views.map(v => v.note).filter(Boolean)[0] || 'Unavailable'}
        : {status: 'loading', clients: views, items: [], finished: []};
    }
    const items = [];
    for (const c of usable) {
      const list = (c.reading.items || []).concat(showSeeding ? c.reading.seedingItems || [] : []);
      for (const item of list) {
        // A paused client's next download is waiting, not downloading.
        const held = c.reading.paused && item.state === 'downloading';
        const state = held ? 'queued' : item.state;
        items.push({key: c.i + ':' + item.id, client: c.i, type: c.type, id: item.id, name: item.name, state,
          progress: item.progress, meta: itemMeta(item), right: held ? 'Client paused' : itemRight(item),
          title: cleanName(item.name), eyebrow: held ? 'Waiting' : STATE_LABEL[item.state] || '', tone: TONE[state] || 'waiting',
          percent: item.state === 'processing' ? '' : Math.floor(clamp01(item.progress) * 100) + '%', amount: itemAmount(item),
          speed: item.state === 'downloading' && item.speed > 0 ? speedText(item.speed) : '',
          canPause: !!item.canPause && ['downloading', 'queued', 'stalled', 'checking', 'paused', 'seeding'].includes(item.state),
          paused: item.state === 'paused'});
      }
    }
    items.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.client - b.client);
    const finished = showFinished ? usable.flatMap(c => (c.reading.finished || []).map(f => ({
      key: c.i + ':' + f.id, client: c.i, type: c.type, name: f.name, title: cleanName(f.name), ok: f.ok, at: f.at,
      right: f.ok ? ago(f.at, now) : 'Failed', meta: f.ok ? size(f.size) : (f.detail || 'Failed'),
    }))).sort((a, b) => b.at - a.at).slice(0, 8) : [];
    const live = usable.filter(c => clientState(c, now) !== 'stale');
    const total = live.reduce((sum, c) => sum + (c.reading.paused ? 0 : c.reading.speed || 0), 0);
    const left = usable.reduce((sum, c) => sum + (c.reading.left || 0), 0);
    const downloading = items.filter(i => i.state === 'downloading').length;
    const waiting = items.filter(i => i.state !== 'downloading' && i.state !== 'seeding' && i.state !== 'failed').length;
    const etas = live.map(c => c.reading.eta).filter(s => s > 0);
    const allPaused = views.length > 0 && views.filter(v => v.state !== 'failed').every(v => v.paused);
    const parts = [];
    if (downloading) parts.push(downloading + ' downloading');
    if (waiting) parts.push(waiting + ' waiting');
    if (left > 0) parts.push(size(left) + ' left');
    if (etas.length && !allPaused) parts.push('about ' + eta(Math.max(...etas)));
    const reading = speed(total);
    const failing = items.filter(i => i.state === 'failed').length;
    const stats = parts.map(text => ({text}));
    if (failing) stats.push({text: failing + ' failed', tone: 'warning'});
    return {
      status: 'ready', clients: views, items, finished, stats, rate: allPaused ? 0 : total,
      fresh: freshness(views, usable, {allPaused, total, now}),
      speed: allPaused ? {value: 'Paused', unit: ''} : reading,
      line: parts.join(' · ') || (allPaused ? 'Everything is paused' : 'Nothing downloading'),
      empty: !items.length,
      seeding: usable.reduce((sum, c) => sum + (c.reading.seeding || 0), 0),
    };
  }

  const clamp01 = n => Math.max(0, Math.min(1, Number(n) || 0));

  root.DownloadsModel = {bytes, size, speed, speedText, eta, ago, clientState, cleanName, trend, summarize};
})(typeof window === 'undefined' ? globalThis : window);
