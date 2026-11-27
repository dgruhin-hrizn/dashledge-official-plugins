// Radarr view. It runs in a sandboxed frame and reaches Dashledge only through
// window.Dashledge. The connector reads Radarr and emits {status, queue, calendar,
// searches}. This view filters Coming up by its placement's settings and draws both panes.
(function () {
  const M = window.RadarrModel;
  const D = window.Dashledge;
  const $ = id => document.getElementById(id);
  const WIDE = window.matchMedia('(min-width: 1000px)');

  let data = null, stopped = '', prefs = M.settings(D.settings.values), shown = '', chosen = false;

  // ---- Posters: one request per movie, cached, with poster.jpg when there's no resized copy.
  const posters = new Map();
  function posterUrl(movieId) {
    if (!posters.has(movieId)) {
      const path = 'api/v3/mediacover/' + movieId + '/';
      posters.set(movieId, D.image(path + 'poster-250.jpg').catch(() => D.image(path + 'poster.jpg')).catch(() => null));
    }
    return posters.get(movieId);
  }
  function fillPoster(box, row) {
    if (box.dataset.movie === String(row.movieId)) return;
    box.dataset.movie = String(row.movieId);
    box.dataset.initial = (row.title || '?').trim().charAt(0).toUpperCase();
    const img = box.querySelector('img');
    img.removeAttribute('src');
    box.classList.remove('loaded');
    if (!row.poster || !row.movieId) return;
    posterUrl(row.movieId).then(url => {
      if (url && box.dataset.movie === String(row.movieId)) { img.src = url; box.classList.add('loaded'); }
    });
  }

  // ---- Rows, reused by key so a refresh doesn't rebuild posters or move the list.
  function rowElement(kind) {
    const li = document.createElement('li');
    li.className = 'dl-row item ' + kind;
    li.innerHTML = '<span class="poster"><img alt=""></span>' +
      '<span class="main"><span class="title"><span class="name"></span> <span class="year"></span></span>' +
      '<span class="detail"></span>' + (kind === 'queue' ? '<span class="bar"><span></span></span>' : '<span class="others"></span>') +
      '</span><span class="side"><span class="big"></span><span class="when"></span></span>';
    return li;
  }
  function reconcile(list, rows, kind, fill) {
    const existing = new Map([...list.children].map(li => [li.dataset.key, li]));
    const next = rows.map(row => {
      const li = existing.get(row.key) || rowElement(kind);
      li.dataset.key = row.key;
      existing.delete(row.key);
      fill(li, row);
      return li;
    });
    for (const li of existing.values()) li.remove();
    next.forEach((li, i) => { if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null); });
  }
  const set = (el, text) => { if (el.textContent !== text) el.textContent = text; };

  function fillQueue(li, row) {
    fillPoster(li.querySelector('.poster'), row);
    set(li.querySelector('.name'), row.title);
    set(li.querySelector('.year'), String(row.year));
    set(li.querySelector('.detail'), row.detail);
    li.dataset.tone = row.tone;
    const bar = li.querySelector('.bar');
    bar.hidden = row.progress === null;
    bar.firstChild.style.width = ((row.progress || 0) * 100).toFixed(1) + '%';
    set(li.querySelector('.big'), row.percent);
    set(li.querySelector('.when'), row.when);
  }

  function fillUpcoming(li, row) {
    fillPoster(li.querySelector('.poster'), row);
    set(li.querySelector('.name'), row.title);
    set(li.querySelector('.year'), String(row.year));
    set(li.querySelector('.detail'), row.detail);
    set(li.querySelector('.others'), row.others);
    li.dataset.state = row.state;
    const side = li.querySelector('.side');
    let button = side.querySelector('button');
    if (row.searchable) {
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'dl-button search';
        button.textContent = 'Search';
        button.addEventListener('click', () => search(Number(li.dataset.movie), button));
        side.prepend(button);
      }
      li.dataset.movie = String(row.movieId);
      button.setAttribute('aria-label', 'Search for ' + row.title);
    } else if (button) {
      button.remove();
    }
    set(li.querySelector('.big'), row.big);
    set(li.querySelector('.when'), row.when);
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

  // ---- Panes.
  function drawPane(name, section, rows, emptyText) {
    const s = M.paneState(section, Date.now(), M.MAX_AGE[name === 'queue' ? 'queue' : 'calendar']);
    const list = $(name + 'List');
    $(name + 'Loading').hidden = s.kind !== 'loading';
    const failed = $(name + 'Failed');
    failed.hidden = s.kind !== 'failed';
    if (s.kind === 'failed') {
      set($(name + 'FailedText'), s.error);
      failed.querySelector('[data-fix]').hidden = !s.auth;
    }
    const ready = s.kind === 'ready';
    list.hidden = !ready || !rows.length;
    $(name + 'Empty').hidden = !ready || rows.length > 0;
    if (name === 'upcoming') set($('upcomingEmptyText'), emptyText);
    const stale = $(name + 'Stale');
    stale.hidden = !(ready && s.stale);
    if (ready && s.stale) set(stale.firstChild, s.note);
    if (ready) reconcile(list, rows, name, name === 'queue' ? fillQueue : fillUpcoming);
  }

  function show(id) {
    for (const panel of ['loading', 'unconnected', 'unavailable', 'stopped']) $(panel).hidden = panel !== id;
    $('top').hidden = $('panes').hidden = Boolean(id);
  }

  function select(pane) {
    shown = pane;
    $('main').dataset.show = pane;
    $('tabQueue').setAttribute('aria-pressed', String(pane === 'queue'));
    $('tabUpcoming').setAttribute('aria-pressed', String(pane === 'upcoming'));
  }

  function draw() {
    if (stopped && !data) {
      set($('stoppedText'), 'The Radarr connector stopped: ' + stopped);
      return show('stopped');
    }
    if (!data) return show('loading');
    if (!data.connected) return show('unconnected');
    // Nothing read yet and both reads failed: one message for the widget, not one per pane.
    const now0 = Date.now();
    const q = M.paneState(data.queue, now0, M.MAX_AGE.queue), c = M.paneState(data.calendar, now0, M.MAX_AGE.calendar);
    if (q.kind === 'failed' && c.kind === 'failed') {
      set($('unavailableText'), q.error);
      $('unavailable').querySelector('[data-fix]').hidden = !q.auth;
      return show('unavailable');
    }
    show('');

    const now = Date.now();
    const today = M.localDay(now, new Date(now).getTimezoneOffset());
    const queueItems = data.queue?.items || [];
    const queueRows = M.queueRows(queueItems);
    const upcoming = M.upcomingRows(data.calendar?.items, {today, days: prefs.days, types: prefs.types, queue: queueItems, searches: data.searches || {}, now});

    set($('server'), D.displayName(data.status?.instanceName) || 'Radarr');
    const summary = data.queue?.at ? M.queueSummary(queueItems, data.queue.total) : '';
    set($('summary'), summary);
    set($('queueNote'), queueRows.length ? (data.queue.total || queueRows.length) + ' in queue' : '');
    set($('upcomingNote'), 'Next ' + prefs.days + (prefs.days === 1 ? ' day' : ' days'));
    set($('tabQueueCount'), queueRows.length ? String(queueRows.length) : '');
    set($('tabUpcomingCount'), upcoming.length ? String(upcoming.length) : '');
    const what = prefs.types.length === 3 ? 'releases' : prefs.types.map(t => ({cinema: 'cinema', digital: 'digital', physical: 'physical'})[t]).join(' or ') + ' releases';
    const emptyText = prefs.types.length ? 'No ' + what + ' in the next ' + prefs.days + (prefs.days === 1 ? ' day.' : ' days.') : 'No release dates are chosen.';

    drawPane('queue', data.queue, queueRows, '');
    drawPane('upcoming', data.calendar, upcoming, emptyText);
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

  for (const tab of [$('tabQueue'), $('tabUpcoming')]) tab.addEventListener('click', () => { chosen = true; select(tab.dataset.pane); });
  document.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.hasAttribute('data-retry')) retry();
    if (target.hasAttribute('data-settings') || target.hasAttribute('data-fix')) D.settings.open();
  });
  WIDE.addEventListener?.('change', draw);
  // Keep "Today", "In 3 days" and "Last updated" true while nothing new arrives.
  setInterval(draw, 60 * 1000);

  draw();
})();
