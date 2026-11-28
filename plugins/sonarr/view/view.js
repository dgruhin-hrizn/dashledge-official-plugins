// Sonarr view. It runs in a sandboxed frame and reaches Dashledge only through
// window.Dashledge. The connector reads Sonarr and emits {status, calendar, queue,
// searching}. This view filters Coming up by its placement's settings and draws the queue
// as cards over each series' fanart, and Coming up as a shelf of posters, one per episode.
(function () {
  const M = window.SonarrModel;
  const D = window.Dashledge;
  const $ = id => document.getElementById(id);
  const KEEP_ALIVE = 5 * 60 * 1000;
  const SEARCH_ERROR_SHOWN = 15 * 1000;

  let data = null, stopped = '', prefs = M.settings(D.settings.values), tapped = '';
  const pending = new Set();        // episode IDs whose search is on its way
  const searchErrors = new Map();   // episode ID → {error, at}

  // The connector stops polling when nobody asks, so the view says it's on screen when it
  // appears, every few minutes while it stays, and on Retry (which reads everything now).
  async function watch(refresh = false) {
    if (document.hidden && !refresh) return;
    try {
      const answer = await D.command('watch', {refresh});
      if (answer && typeof answer === 'object' && !data) data = answer;
      stopped = '';
    } catch (error) {
      stopped = String(error?.message || error);
    }
    draw();
  }
  const retry = () => { stopped = ''; watch(true); };

  // ---- Artwork: one request per series and kind, cached. Sonarr keeps resized copies
  // (poster-500, fanart-360) beside the originals; fall back to those.
  const ART = {poster: ['poster-500.jpg', 'poster.jpg'], fanart: ['fanart-360.jpg', 'fanart.jpg']};
  const cache = new Map();
  function art(seriesId, kind) {
    const key = kind + ':' + seriesId;
    if (!cache.has(key)) {
      const base = 'api/v3/mediacover/' + seriesId + '/';
      const [first, second] = ART[kind];
      cache.set(key, D.image(base + first).catch(() => D.image(base + second)).catch(() => null));
    }
    return cache.get(key);
  }
  // Show one image in its box: the box keeps its space, and the series' initial, until it loads.
  function paint(box, seriesId, kind, wanted, name) {
    const img = box.querySelector('img');
    const id = wanted && Number.isInteger(seriesId) ? kind + ':' + seriesId : '';
    const ph = box.querySelector('.ph');
    if (ph) set(ph, (String(name || '?').replace(/^(the|a|an)\s+/i, '').trim().charAt(0) || '?').toUpperCase());
    if (box.dataset.art === id) return;
    box.dataset.art = id;
    box.classList.remove('loaded');
    img.removeAttribute('src');
    if (!id) return;
    art(seriesId, kind).then(url => {
      if (url && box.dataset.art === id) { img.src = url; box.classList.add('loaded'); }
    });
  }

  // ---- Keyed reuse, so a refresh every few seconds never rebuilds artwork or scrolls.
  function reconcile(list, rows, make, fill) {
    const existing = new Map([...list.children].map(el => [el.dataset.key, el]));
    rows.forEach((row, i) => {
      let el = existing.get(row.key);
      if (el) existing.delete(row.key); else { el = make(); el.dataset.key = row.key; }
      fill(el, row);
      if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
    });
    for (const el of existing.values()) el.remove();
  }
  function set(el, text) { if (el.textContent !== text) el.textContent = text; }
  const html = markup => { const t = document.createElement('template'); t.innerHTML = markup.trim(); return t.content.firstChild; };

  // ---- Queue cards.
  const makeCard = () => html(`
    <article class="card">
      <div class="backdrop"><img alt=""></div>
      <div class="film">
        <div class="sleeve"><span class="ph"></span><img alt=""></div>
        <div class="copy"><p class="eyebrow"></p><h3 class="title"></h3><p class="meta"></p><p class="note"></p></div>
      </div>
      <div class="rail">
        <span class="track"><i></i></span><span class="pct"></span>
        <span class="sub"><span class="amount"></span><span class="left"></span></span>
      </div>
    </article>`);
  function fillCard(card, row) {
    card.dataset.tone = row.tone;
    paint(card.querySelector('.backdrop'), row.seriesId, 'fanart', row.fanart, '');
    paint(card.querySelector('.sleeve'), row.seriesId, 'poster', row.poster, row.title);
    set(card.querySelector('.eyebrow'), row.eyebrow);
    set(card.querySelector('.title'), row.title);
    set(card.querySelector('.meta'), row.meta);
    set(card.querySelector('.note'), row.note);
    const track = card.querySelector('.track');
    track.hidden = row.progress === null;
    track.firstChild.style.width = ((row.progress || 0) * 100).toFixed(1) + '%';
    set(card.querySelector('.pct'), row.percent);
    set(card.querySelector('.amount'), row.amount);
    // While downloading, the reading is the time left; otherwise the eyebrow says it all.
    set(card.querySelector('.left'), row.left ? row.left + ' left' : '');
    card.setAttribute('aria-label', [row.title, row.eyebrow, row.percent, row.left && row.left + ' left'].filter(Boolean).join(', '));
  }

  // ---- Coming up shelf.
  const CLOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
  const makeTile = () => html(`
    <li class="tile">
      <div class="art">
        <span class="ph"></span><img alt="">
        <span class="chip"></span><span class="badge"></span>
        <span class="type">${CLOCK}<span></span></span>
        <span class="mini"><i></i></span>
      </div>
      <p class="name"><b></b> <span class="code"></span></p>
      <p class="when"></p>
    </li>`);
  const lower = day => (day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : day);
  function fillTile(tile, row) {
    const searching = pending.has(row.id);
    const state = searching && row.state === 'missing' ? 'searching' : row.state;
    tile.dataset.state = state;
    tile.dataset.soon = String(row.soon);
    tile.dataset.episode = String(row.id);
    const box = tile.querySelector('.art');
    paint(box, row.seriesId, 'poster', row.poster, row.series);
    set(tile.querySelector('.chip'), searching ? 'Searching…' : row.chip);
    const badge = tile.querySelector('.badge');
    set(badge, row.state === 'downloaded' ? '✓' : '');
    badge.hidden = !badge.textContent;
    set(tile.querySelector('.type').lastChild, row.time);
    tile.querySelector('.mini').hidden = row.progress === null;
    tile.querySelector('.mini i').style.width = (row.progress || 0) + '%';
    set(tile.querySelector('.name b'), row.series);
    set(tile.querySelector('.code'), row.code);
    // Under the poster: the episode's title; when it aired, for a missed one; or why a
    // search failed, for a little while.
    const failed = searchErrors.get(row.id);
    const rest = row.detail.slice(row.code.length + 3);
    const when = tile.querySelector('.when');
    when.classList.toggle('problem', Boolean(failed));
    set(when, failed ? failed.error
      : state === 'missing' || state === 'searching' ? ['Aired ' + lower(row.day), rest].filter(Boolean).join(' · ')
      : rest || 'Title to be announced');
    let button = box.querySelector('.search');
    const searchable = row.canSearch && !searching;
    if (searchable && !button) {
      button = html('<button class="dl-button search" type="button">Search</button>');
      button.addEventListener('click', () => search(Number(tile.dataset.episode)));
      box.append(button);
    } else if (!searchable && button) {
      button.remove();
      button = null;
    }
    if (button) button.setAttribute('aria-label', 'Search for ' + row.series + ' ' + row.code);
    tile.setAttribute('aria-label', [row.series, row.code, row.title, row.label || row.day + ' ' + row.time].filter(Boolean).join(', '));
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

  // ---- Panes and states.
  function paneFailure(name, s) {
    const failed = $(name + 'Failed');
    failed.hidden = s.kind !== 'failed';
    if (s.kind === 'failed') {
      set($(name + 'FailedText'), s.error);
      failed.querySelector('[data-fix]').hidden = !s.auth;
    }
    $(name + 'Loading').hidden = s.kind !== 'loading';
  }

  function drawQueue(rows, upcoming, now) {
    const s = M.paneState(data.queue, now, M.MAX_AGE.queue);
    paneFailure('queue', s);
    const ready = s.kind === 'ready';
    const cards = $('queueCards');
    cards.hidden = !ready || !rows.length;
    $('queueIdle').hidden = !ready || rows.length > 0;
    $('main').dataset.queue = ready && !rows.length ? 'empty' : 'busy';
    set($('queueCount'), rows.length ? rows.length + (data.queue.more ? '+' : '') + ' in queue' : '');
    if (!ready) return;
    // Up to three cards share the width; more scroll sideways, with the next one peeking.
    cards.style.setProperty('--cols', String(rows.length <= 3 ? Math.max(rows.length, 1) : 2.6));
    reconcile(cards, rows, makeCard, fillCard);
    // Fade the edge only while more cards wait off to the side.
    cards.dataset.more = String(cards.scrollWidth - cards.scrollLeft > cards.clientWidth + 2);
    if (!rows.length) {
      // An idle queue features the next episode to air, over its series' artwork.
      const next = M.nextUp(upcoming, now);
      const idle = $('queueIdle');
      paint(idle.querySelector('.backdrop'), next?.seriesId, 'fanart', next?.fanart, '');
      paint(idle.querySelector('.sleeve'), next?.seriesId, 'poster', next?.poster, next?.series || 'S');
      idle.querySelector('.sleeve').hidden = !next;
      set($('idleTitle'), next ? next.series : 'All caught up');
      set($('idleMeta'), next ? ['Next up', next.code, next.title, next.day + ' ' + next.time].filter(Boolean).join(' · ') : 'Sonarr’s queue is empty.');
    }
  }

  function drawUpcoming(view, now) {
    const {days, rows} = view;
    const s = M.paneState(data.calendar, now, M.MAX_AGE.calendar);
    paneFailure('upcoming', s);
    const ready = s.kind === 'ready';
    $('shelf').hidden = !ready || !rows.length;
    $('upcomingEmpty').hidden = !ready || rows.length > 0;
    const missing = rows.filter(r => r.state === 'missing').length;
    set($('upcomingCount'), (days === 1 ? 'Today' : 'Next ' + days + ' days') + (missing ? ' · ' + missing + ' missing' : ''));
    const span = days === 1 ? 'today' : 'in the next ' + days + ' days';
    set($('upcomingEmptyText'), prefs.hideDownloaded ? 'Nothing left to download ' + span + '.' : 'Nothing airing ' + span + '.');
    if (ready) reconcile($('shelf'), rows, makeTile, fillTile);
  }

  function drawHeader(now) {
    set($('server'), data?.connected ? D.displayName(data.status?.instanceName) || '' : '');
    const f = M.freshness(data, now);
    const status = $('status');
    status.dataset.kind = f.kind;
    set($('statusText'), f.label);
    set($('statusShort'), f.short || '');
    status.title = f.note;
    $('statusRetry').hidden = f.kind !== 'stale';
    const stats = Array.isArray(data?.queue?.items) ? M.queueStats(data.queue.items, data.queue.more) : [];
    const box = $('stats');
    const key = JSON.stringify(stats);
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.replaceChildren(...stats.map(stat => {
        const span = document.createElement('span');
        span.textContent = stat.text;
        if (stat.tone) span.dataset.tone = stat.tone;
        return span;
      }));
    }
  }

  function show(id) {
    for (const panel of ['loading', 'unconnected', 'unavailable', 'stopped']) $(panel).hidden = panel !== id;
    $('stage').hidden = Boolean(id);
    $('main').dataset.state = id || 'ready';
  }

  // A small placement shows the pane its setting names, until a tab is tapped.
  function select() {
    const pane = tapped || prefs.pane;
    $('main').dataset.show = pane;
    $('tabQueue').setAttribute('aria-pressed', String(pane === 'queue'));
    $('tabUpcoming').setAttribute('aria-pressed', String(pane === 'upcoming'));
  }

  function draw() {
    const now = Date.now();
    for (const [id, e] of searchErrors) if (now - e.at > SEARCH_ERROR_SHOWN) searchErrors.delete(id);
    drawHeader(now);
    select();
    const s = M.status(data, stopped, now);
    if (s.kind === 'stopped') {
      set($('stoppedText'), 'The Sonarr connector stopped: ' + s.error);
      return show('stopped');
    }
    if (s.kind === 'loading') return show('loading');
    if (s.kind === 'noconnection') return show('unconnected');
    if (s.kind === 'failed') {
      set($('unavailableText'), s.error);   // already says what Sonarr did
      $('unavailable').querySelector('[data-fix]').hidden = !s.auth;
      return show('unavailable');
    }
    show('');
    const rows = M.queueRows(data.queue?.items);
    const upcoming = M.upcoming(data, prefs, now);
    set($('tabQueueCount'), rows.length ? String(rows.length) : '');
    set($('tabUpcomingCount'), upcoming.rows.length ? String(upcoming.rows.length) : '');
    drawQueue(rows, upcoming.rows, now);
    drawUpcoming(upcoming, now);
  }

  D.subscribe(state => {
    const next = M.settings(state.settings);
    if (next.pane !== prefs.pane) tapped = '';   // a new saved choice wins over the last tap
    prefs = next;
    draw();
  });
  D.onData(({data: next, error}) => {
    stopped = error ? String(error) : '';
    if (next && typeof next === 'object' && 'connected' in next) data = next;
    draw();
  });

  $('queueCards').addEventListener('scroll', () => {
    const cards = $('queueCards');
    cards.dataset.more = String(cards.scrollWidth - cards.scrollLeft > cards.clientWidth + 2);
  }, {passive: true});
  window.addEventListener('resize', draw);
  // Where the chip has no room for its own Retry, the stale chip itself retries.
  $('status').addEventListener('click', event => {
    if ($('status').dataset.kind === 'stale' && !event.target.closest('button')) retry();
  });
  for (const tab of [$('tabQueue'), $('tabUpcoming')]) tab.addEventListener('click', () => { tapped = tab.dataset.pane; select(); });
  document.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.hasAttribute('data-retry')) retry();
    if (target.hasAttribute('data-settings') || target.hasAttribute('data-fix')) D.settings.open().catch(() => {});
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) watch(); });
  setInterval(() => watch(), KEEP_ALIVE);
  // Keep "Today", "Missing" and "Updated 5 min ago" true while nothing new arrives.
  setInterval(draw, 60 * 1000);

  draw();
  watch();
})();
