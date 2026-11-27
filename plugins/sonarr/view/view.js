// Sonarr view. It runs in a sandboxed frame and reaches Dashledge only through
// window.Dashledge. The connector reads Sonarr; this view filters what it sent by the
// placement's settings and draws it.
(function () {
  const M = window.SonarrModel;
  const D = window.Dashledge;
  const $ = id => document.getElementById(id);
  const KEEP_ALIVE = 5 * 60 * 1000;
  const SEARCH_ERROR_SHOWN = 15 * 1000;
  let data = null, stopped = '', settings = {}, pane = '';
  const posters = new Map();        // seriesId → blob URL, '' while loading, null when missing
  const searchErrors = new Map();   // episodeId → {error, at}
  const pending = new Set();        // episode IDs whose search is on its way

  const readSettings = values => ({
    days: Math.min(14, Math.max(1, Math.round(Number(values?.days) || 7))),
    hideDownloaded: values?.hideDownloaded === true,
    pane: values?.pane === 'queue' ? 'queue' : 'upcoming',
  });

  async function watch(refresh = false) {
    if (document.hidden) return;
    try {
      const answer = await D.command('watch', {refresh});
      if (answer && !data) data = answer;
      stopped = '';
    } catch (error) {
      stopped = String(error?.message || error);
    }
    draw();
  }

  // ---- Posters: reserved space, filled when Sonarr has one ----

  // The series' initial shows until (or unless) Sonarr has a poster.
  function poster(seriesId, name) {
    const box = document.createElement('span');
    box.className = 'poster';
    box.dataset.initial = (String(name || '').replace(/^(the|a|an)\s+/i, '').trim()[0] || '').toUpperCase();
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    box.append(img);
    if (!Number.isInteger(seriesId)) return box;
    img.dataset.series = String(seriesId);
    const known = posters.get(seriesId);
    if (known) img.src = known;
    else if (known === undefined) {
      posters.set(seriesId, '');
      D.image('api/v3/mediacover/' + seriesId + '/poster-250.jpg').then(url => {
        posters.set(seriesId, url);
        for (const el of document.querySelectorAll('img[data-series="' + seriesId + '"]')) el.src = url;
      }, () => posters.set(seriesId, null));
    }
    return box;
  }

  const text = (tag, className, value) => {
    const el = document.createElement(tag);
    el.className = className;
    el.textContent = value;
    return el;
  };

  // ---- Panes ----

  function upcomingRow(r) {
    const li = document.createElement('li');
    li.className = 'dl-row item ' + r.state;
    const main = document.createElement('div');
    main.className = 'main';
    main.append(text('span', 'title', r.series), text('span', 'detail', r.detail));
    const side = document.createElement('div');
    side.className = 'side';
    side.append(text('span', 'when', r.day + ' · ' + r.time));
    const failed = searchErrors.get(r.id);
    const status = document.createElement('span');
    status.className = 'status';
    if (r.canSearch && !pending.has(r.id)) {
      if (failed) status.append(text('span', 'note problem', failed.error));
      else status.append(text('span', 'note', r.label));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dl-button search';
      button.textContent = 'Search';
      button.setAttribute('aria-label', 'Search for ' + r.series + ' ' + r.detail.split(' · ')[0]);
      button.addEventListener('click', () => search(r.id));
      status.append(button);
    } else {
      status.append(text('span', 'note', pending.has(r.id) ? 'Searching…' : r.label));
    }
    side.append(status);
    li.append(poster(r.seriesId, r.series), main, side);
    return li;
  }

  function queueRow(r) {
    const li = document.createElement('li');
    li.className = 'dl-row item tone-' + r.tone;
    const main = document.createElement('div');
    main.className = 'main';
    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', r.series + ' progress');
    if (r.progress !== null) {
      bar.setAttribute('aria-valuenow', String(r.progress));
      bar.style.setProperty('--progress', r.progress + '%');
    }
    main.append(text('span', 'title', r.series), text('span', 'detail', r.detail), bar);
    const side = document.createElement('div');
    side.className = 'side';
    side.append(text('span', 'percent', r.percent), text('span', 'note', r.note));
    li.append(poster(r.seriesId, r.series), main, side);
    return li;
  }

  function showPane(name, kind, message) {
    $(name + 'List').hidden = kind !== 'list';
    $(name + 'Empty').hidden = kind !== 'empty';
    $(name + 'Loading').hidden = kind !== 'loading';
    $(name + 'Error').hidden = kind !== 'failed';
    if (kind === 'empty') $(name + 'Empty').textContent = message;
    if (kind === 'failed') $(name + 'Error').textContent = message;
  }

  function drawUpcoming(now) {
    const {days, rows} = M.upcoming(data, settings, now);
    $('upcomingNote').textContent = days === 1 ? 'Today' : 'Next ' + days + ' days';
    const missing = rows.filter(r => r.state === 'missing').length;
    $('countUpcoming').textContent = rows.length ? String(rows.length) : '';
    const p = M.pane(data.calendar);
    if (p.kind !== 'list' && p.kind !== 'empty') return showPane('upcoming', p.kind, p.error);
    if (!rows.length) {
      return showPane('upcoming', 'empty', settings.hideDownloaded
        ? 'Nothing left to download in the ' + (days === 1 ? 'day' : days + ' days') + ' ahead'
        : 'Nothing airing ' + (days === 1 ? 'today' : 'in the next ' + days + ' days'));
    }
    $('upcomingNote').textContent += missing ? ' · ' + missing + ' missing' : '';
    $('upcomingList').replaceChildren(...rows.map(upcomingRow));
    showPane('upcoming', 'list');
  }

  function drawQueue() {
    const q = data.queue;
    const rows = M.queueRows(q?.items);
    const total = Array.isArray(q?.items) ? rows.length + (q.more ? '+' : '') : '';
    $('countQueue').textContent = rows.length ? String(total) : '';
    $('queueNote').textContent = rows.length ? String(total) : '';
    const p = M.pane(q);
    if (p.kind !== 'list') return showPane('queue', p.kind, p.kind === 'empty' ? 'Nothing downloading' : p.error);
    const list = rows.map(queueRow);
    if (q.more) list.push(text('li', 'dl-row more', '+' + q.more + ' more in Sonarr'));
    $('queueList').replaceChildren(...list);
    showPane('queue', 'list');
  }

  function show(id) {
    for (const panel of ['content', 'loading', 'empty', 'failed']) $(panel).hidden = panel !== id;
  }

  function draw() {
    const now = Date.now();
    for (const [id, e] of searchErrors) if (now - e.at > SEARCH_ERROR_SHOWN) searchErrors.delete(id);
    const s = M.status(data, stopped, now);
    if (s.kind === 'stopped') {
      $('failedText').textContent = 'The Sonarr connector stopped: ' + s.error;
      $('fix').hidden = true;
      return show('failed');
    }
    if (s.kind === 'loading') return show('loading');
    if (s.kind === 'noconnection') return show('empty');
    if (s.kind === 'failed') {
      $('failedText').textContent = s.error;   // already says what Sonarr did
      $('fix').hidden = !s.auth;
      return show('failed');
    }
    $('server').textContent = D.displayName(data.status?.instanceName) || 'Sonarr';
    $('stale').hidden = !s.stale;
    $('staleText').textContent = s.note;
    $('staleFix').hidden = !s.auth;
    const active = pane || settings.pane;
    $('app').dataset.pane = active;
    $('tabUpcoming').setAttribute('aria-pressed', String(active === 'upcoming'));
    $('tabQueue').setAttribute('aria-pressed', String(active === 'queue'));
    drawUpcoming(now);
    drawQueue();
    show('content');
  }

  async function search(id) {
    pending.add(id);
    searchErrors.delete(id);
    draw();
    try {
      const answer = await D.command('search', {episodeId: id});
      if (!answer?.ok) searchErrors.set(id, {error: answer?.error || 'Search failed', at: Date.now()});
    } catch (error) {
      searchErrors.set(id, {error: String(error?.message || error), at: Date.now()});
    }
    pending.delete(id);
    draw();
  }

  D.subscribe(state => {
    const next = readSettings(state.settings);
    if (next.pane !== settings.pane) pane = '';   // a new saved choice wins over the last tap
    settings = next;
    if (data) draw();
  });

  D.onData(({data: next, error}) => {
    stopped = error ? String(error) : '';
    if (next) data = next;
    draw();
  });

  const openSettings = () => D.settings.open().catch(() => {});
  $('choose').addEventListener('click', openSettings);
  $('fix').addEventListener('click', openSettings);
  $('staleFix').addEventListener('click', openSettings);
  $('retry').addEventListener('click', () => { stopped = ''; watch(true); });
  $('staleRetry').addEventListener('click', () => watch(true));
  $('tabUpcoming').addEventListener('click', () => { pane = 'upcoming'; draw(); });
  $('tabQueue').addEventListener('click', () => { pane = 'queue'; draw(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) watch(); });
  // The connector stops polling when nobody asks, so keep asking while on screen, and
  // redraw each minute so "Today", "Last updated" and Missing stay true.
  setInterval(() => watch(), KEEP_ALIVE);
  setInterval(draw, 60 * 1000);

  settings = readSettings(D.settings.values);
  draw();
  watch();
})();
