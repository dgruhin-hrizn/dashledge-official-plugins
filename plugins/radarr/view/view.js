// Radarr view. It runs in a sandboxed frame and reaches Dashledge only through
// window.Dashledge. The connector reads Radarr and emits {status, queue, calendar,
// searches}. This view filters Coming up by its placement's settings and draws the queue
// as cards over each movie's fanart, and Coming up as a shelf of posters.
(function () {
  const M = window.RadarrModel;
  const D = window.Dashledge;
  const $ = id => document.getElementById(id);

  let data = null, stopped = '', prefs = M.settings(D.settings.values), shown = '', chosen = false;

  // ---- Artwork: one request per movie and kind, cached. Radarr keeps resized copies
  // (poster-500, poster-250, fanart-360) beside the originals; fall back to those.
  const ART = {poster: ['poster-500.jpg', 'poster.jpg'], thumb: ['poster-250.jpg', 'poster.jpg'], fanart: ['fanart-360.jpg', 'fanart.jpg']};
  const cache = new Map();
  function art(movieId, kind) {
    const key = kind + ':' + movieId;
    if (!cache.has(key)) {
      const base = 'api/v3/mediacover/' + movieId + '/';
      const [first, second] = ART[kind];
      cache.set(key, D.image(base + first).catch(() => D.image(base + second)).catch(() => null));
    }
    return cache.get(key);
  }
  // Show one image in its box: the box keeps its space, and its initial, until it loads.
  function paint(box, movieId, kind, wanted, title) {
    const img = box.querySelector('img');
    const id = wanted && movieId ? kind + ':' + movieId : '';
    const ph = box.querySelector('.ph');
    if (ph) set(ph, (title || '?').trim().charAt(0).toUpperCase());
    if (box.dataset.art === id) return;
    box.dataset.art = id;
    box.classList.remove('loaded');
    img.removeAttribute('src');
    if (!id) return;
    art(movieId, kind).then(url => {
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
    paint(card.querySelector('.backdrop'), row.movieId, 'fanart', row.fanart, '');
    paint(card.querySelector('.sleeve'), row.movieId, 'thumb', row.poster, row.title);
    set(card.querySelector('.eyebrow'), row.phase);
    set(card.querySelector('.title'), row.title);
    set(card.querySelector('.meta'), row.meta);
    set(card.querySelector('.note'), row.note);
    const track = card.querySelector('.track');
    track.hidden = row.progress === null;
    track.firstChild.style.width = ((row.progress || 0) * 100).toFixed(1) + '%';
    set(card.querySelector('.pct'), row.percent);
    set(card.querySelector('.amount'), row.amount);
    // While downloading, the reading is the time left; otherwise the phase says it all.
    set(card.querySelector('.left'), row.phase === 'Downloading' && /\d/.test(row.when) ? row.when + ' left' : '');
    card.setAttribute('aria-label', [row.title, row.phase, row.percent, row.when].filter(Boolean).join(', '));
  }

  // ---- Coming up shelf.
  const ICONS = {
    cinema: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5 20 4.5l.6 3-16 3zM4.6 10.5H20V19a1 1 0 0 1-1 1H5.6a1 1 0 0 1-1-1zM8 4.9l2 2.6M12.5 4l2 2.7"/></svg>',
    digital: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="1.5"/><path d="M8 20h8M10.5 8.2v4.6l4-2.3z"/></svg>',
    physical: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.2"/><path d="M12 5.5a6.5 6.5 0 0 1 6.5 6.5"/></svg>',
  };
  const makeTile = () => html(`
    <li class="tile">
      <div class="art">
        <span class="ph"></span><img alt="">
        <span class="chip"></span><span class="badge"></span>
        <span class="type"></span>
        <span class="mini"><i></i></span>
      </div>
      <p class="name"><b></b> <span class="year"></span></p>
      <p class="when"></p>
    </li>`);
  function fillTile(tile, row) {
    tile.dataset.state = row.state;
    tile.dataset.soon = String(row.chip === 'Today' || row.chip === 'Tomorrow');
    const box = tile.querySelector('.art');
    paint(box, row.movieId, 'poster', row.poster, row.title);
    set(tile.querySelector('.chip'), row.chip);
    const badge = tile.querySelector('.badge');
    set(badge, row.state === 'downloaded' ? '✓' : '');
    badge.hidden = !badge.textContent;
    const type = tile.querySelector('.type');
    if (type.dataset.type !== row.type) { type.dataset.type = row.type; type.innerHTML = ICONS[row.type] + '<span></span>'; }
    set(type.lastChild, row.typeLabel);
    tile.querySelector('.mini').hidden = row.progress === null;
    tile.querySelector('.mini i').style.width = ((row.progress || 0) * 100).toFixed(1) + '%';
    set(tile.querySelector('.name b'), row.title);
    set(tile.querySelector('.year'), String(row.year));
    const when = row.state === 'downloaded' ? 'On disk · ' + row.dateText
      : row.state === 'queued' ? row.when + (row.big ? ' · ' + row.big : '')
      : row.state === 'missing' || row.state === 'searching' ? 'Out ' + row.dateText
      : row.others ? row.dateText + ' · then ' + row.others : row.dateText;
    set(tile.querySelector('.when'), when);
    let button = box.querySelector('.search');
    if (row.searchable && !button) {
      button = html('<button class="dl-button search" type="button">Search</button>');
      button.addEventListener('click', () => search(Number(tile.dataset.movie), button));
      box.append(button);
    } else if (!row.searchable && button) {
      button.remove();
      button = null;
    }
    if (button) button.setAttribute('aria-label', 'Search for ' + row.title);
    tile.dataset.movie = String(row.movieId);
    tile.setAttribute('aria-label', [row.title, row.chip, row.typeLabel].join(', '));
  }

  async function search(movieId, button) {
    button.disabled = true;
    try {
      const answer = await D.command('search', {movieId});
      if (!answer?.ok) button.title = answer?.error || '';
    } catch (error) {
      button.title = String(error?.message || error);
    } finally {
      button.disabled = false;
    }
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

  function drawQueue(rows, upcoming, today, now) {
    const s = M.paneState(data.queue, now, M.MAX_AGE.queue);
    paneFailure('queue', s);
    const ready = s.kind === 'ready';
    const cards = $('queueCards');
    cards.hidden = !ready || !rows.length;
    $('queueIdle').hidden = !ready || rows.length > 0;
    $('main').dataset.queue = ready && !rows.length ? 'empty' : 'busy';
    set($('queueCount'), rows.length ? (data.queue.total || rows.length) + ' in queue' : '');
    if (!ready) return;
    // Up to three cards share the width; more scroll sideways, with the next one peeking.
    cards.style.setProperty('--cols', String(rows.length <= 3 ? Math.max(rows.length, 1) : 2.6));
    reconcile(cards, rows, makeCard, fillCard);
    // Fade the edge only while more cards wait off to the side.
    cards.dataset.more = String(cards.scrollWidth - cards.scrollLeft > cards.clientWidth + 2);
    if (!rows.length) {
      // An idle queue features the next release, over its artwork.
      const next = M.nextRelease(upcoming, today);
      const idle = $('queueIdle');
      paint(idle.querySelector('.backdrop'), next?.movieId, 'fanart', next?.fanart, '');
      paint(idle.querySelector('.sleeve'), next?.movieId, 'thumb', next?.poster, next?.title || 'R');
      idle.querySelector('.sleeve').hidden = !next;
      set($('idleTitle'), next ? next.title : 'All caught up');
      set($('idleMeta'), next ? 'Next up · ' + next.typeLabel + ' · ' + next.chip : 'Radarr’s queue is empty.');
    }
  }

  function drawUpcoming(rows, now) {
    const s = M.paneState(data.calendar, now, M.MAX_AGE.calendar);
    paneFailure('upcoming', s);
    const ready = s.kind === 'ready';
    $('shelf').hidden = !ready || !rows.length;
    $('upcomingEmpty').hidden = !ready || rows.length > 0;
    set($('upcomingCount'), 'Next ' + prefs.days + (prefs.days === 1 ? ' day' : ' days'));
    const what = prefs.types.length === 3 ? 'releases' : prefs.types.join(' or ') + ' releases';
    set($('upcomingEmptyText'), prefs.types.length ? 'No ' + what + ' in the next ' + prefs.days + (prefs.days === 1 ? ' day.' : ' days.') : 'No release dates are chosen.');
    if (ready) reconcile($('shelf'), rows, makeTile, fillTile);
  }

  function drawHeader(now) {
    set($('server'), data ? D.displayName(data.status?.instanceName) || '' : '');
    const f = M.freshness(data, now);
    const status = $('status');
    status.dataset.kind = data?.connected === false ? 'loading' : f.kind;
    set($('statusText'), data?.connected === false ? 'Not set up' : f.label);
    status.title = f.note;
    $('statusRetry').hidden = f.kind !== 'stale';
    const stats = data?.queue?.at ? M.queueStats(data.queue.items, data.queue.total) : [];
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

  function select(pane) {
    shown = pane;
    $('main').dataset.show = pane;
    $('tabQueue').setAttribute('aria-pressed', String(pane === 'queue'));
    $('tabUpcoming').setAttribute('aria-pressed', String(pane === 'upcoming'));
  }

  function draw() {
    const now = Date.now();
    drawHeader(now);
    if (stopped && !data) {
      set($('stoppedText'), 'The Radarr connector stopped: ' + stopped);
      return show('stopped');
    }
    if (!data) return show('loading');
    if (!data.connected) return show('unconnected');
    // Nothing read yet and both reads failed: one message for the widget, not one per pane.
    const q = M.paneState(data.queue, now, M.MAX_AGE.queue), c = M.paneState(data.calendar, now, M.MAX_AGE.calendar);
    if (q.kind === 'failed' && c.kind === 'failed') {
      set($('unavailableText'), q.error);
      $('unavailable').querySelector('[data-fix]').hidden = !q.auth;
      return show('unavailable');
    }
    show('');

    const today = M.localDay(now, new Date(now).getTimezoneOffset());
    const queueItems = data.queue?.items || [];
    const rows = M.queueRows(queueItems);
    const upcoming = M.upcomingRows(data.calendar?.items, {today, days: prefs.days, types: prefs.types, queue: queueItems, searches: data.searches || {}, now});
    set($('tabQueueCount'), rows.length ? String(rows.length) : '');
    set($('tabUpcomingCount'), upcoming.length ? String(upcoming.length) : '');
    drawQueue(rows, upcoming, today, now);
    drawUpcoming(upcoming, now);
    // A small placement opens on the pane its setting names, decided once the queue is in,
    // and then stays where the user puts it.
    if (!chosen && data.queue?.at) { select(M.firstPane(prefs.first, queueItems)); chosen = true; }
    else if (!shown) select(prefs.first === 'upcoming' ? 'upcoming' : 'queue');
  }

  async function retry() {
    stopped = '';
    try { await D.command('refresh', {}); } catch (error) { stopped = String(error?.message || error); }
    draw();
  }

  D.subscribe(state => {
    const next = M.settings(state.settings);
    if (next.first !== prefs.first) chosen = false;
    prefs = next;
    draw();
  });
  D.onData(({data: next, error}) => {
    stopped = error ? String(error) : '';
    if (next && typeof next === 'object' && 'queue' in next) data = next;
    draw();
  });

  $('queueCards').addEventListener('scroll', () => {
    const cards = $('queueCards');
    cards.dataset.more = String(cards.scrollWidth - cards.scrollLeft > cards.clientWidth + 2);
  }, {passive: true});
  window.addEventListener('resize', draw);
  for (const tab of [$('tabQueue'), $('tabUpcoming')]) tab.addEventListener('click', () => { chosen = true; select(tab.dataset.pane); });
  document.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.hasAttribute('data-retry')) retry();
    if (target.hasAttribute('data-settings') || target.hasAttribute('data-fix')) D.settings.open();
  });
  // Keep "Today", "In 3 days" and "Updated 5 min ago" true while nothing new arrives.
  setInterval(draw, 60 * 1000);

  draw();
})();
