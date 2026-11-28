// Downloads view. It runs in a sandboxed frame and reaches Dashledge only through
// window.Dashledge: the connector reads every client, this view draws them and sends
// pause, resume and refresh commands.
(function () {
  const M = window.DownloadsModel;
  const D = window.Dashledge;
  const $ = id => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  // The speed graph keeps the last six minutes, one sample every three seconds. It lives only
  // in this view, so it starts empty whenever the widget opens.
  const SAMPLE_EVERY = 3000, SLOTS = 120;
  const MONOGRAM = {sabnzbd: 'SAB', nzbget: 'NZB', qbittorrent: 'qB'};
  let data = null, stopped = '', settings = {}, noticeTimer = 0, shown = 'now', chosen = false, last = null;
  const samples = [];
  const pending = new Set();          // commands in flight, by key, so a button can't double-fire
  const chips = new Map(), cards = new Map(), done = new Map();

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  // Product initials are decoration: the name beside them already says which client it is.
  const decor = className => { const node = el('span', className); node.setAttribute('aria-hidden', 'true'); return node; };
  function set(node, text) { if (node.textContent !== text) node.textContent = text; }

  function notice(text) {
    set($('notice'), text);
    $('notice').hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6000);
  }

  async function send(command, args, key) {
    if (pending.has(key)) return;
    pending.add(key);
    draw();
    try {
      await D.command(command, args);
    } catch (error) {
      notice(String(error?.message || error));
    } finally {
      pending.delete(key);
      draw();
    }
  }

  const PAUSE = 'M6.5 4h3.5v16H6.5zM14 4h3.5v16H14z';
  const PLAY = 'M7 4.5v15l12.5-7.5z';
  function icon(d) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  }
  function setIcon(button, paused) {
    if (button.dataset.icon === String(paused)) return;
    button.dataset.icon = String(paused);
    button.replaceChildren(icon(paused ? PLAY : PAUSE));
  }

  // Each client: its product tile, its name and state, and its pause, resume or retry button.
  function chip(c) {
    let node = chips.get(c.i);
    if (!node) {
      node = el('li', 'client');
      const who = el('span', 'who');
      who.append(el('strong'), el('span', 'product'));
      const act = el('button', 'dl-button act');
      act.type = 'button';
      act.addEventListener('click', () => {
        const c = node.client;
        if (c.state === 'failed' || c.state === 'stale') send('refresh', {client: c.i}, 'refresh:' + c.i);
        else send(c.paused ? 'resume' : 'pause', {client: c.i}, 'client:' + c.i);
      });
      node.append(decor('tile'), who, el('span', 'note'), act);
      chips.set(c.i, node);
    }
    node.client = c;
    node.dataset.type = c.type;
    node.dataset.state = c.state;
    set(node.querySelector('.tile'), MONOGRAM[c.type] || '');
    set(node.querySelector('strong'), c.name);
    set(node.querySelector('.product'), c.name === c.label ? '' : c.label);
    set(node.querySelector('.note'), c.note);
    const button = node.querySelector('.act');
    const retry = c.state === 'failed' || c.state === 'stale';
    const label = retry ? 'Retry' : c.paused ? 'Resume' : 'Pause';
    set(button, label);
    button.hidden = !retry && !c.canPause;
    button.disabled = pending.has((retry ? 'refresh:' : 'client:') + c.i);
    button.setAttribute('aria-label', label + ' ' + c.label + ' on ' + c.name);
    button.setAttribute('aria-pressed', String(!retry && c.paused));
    return node;
  }

  // One card per download, reused across refreshes so the row keeps its scroll position.
  function card(item, names, several) {
    let node = cards.get(item.key);
    if (!node) {
      node = el('article', 'card');
      const head = el('div', 'head');
      const label = el('div', 'label');
      label.append(el('p', 'eyebrow'), el('p', 'from'));
      const toggle = el('button', 'dl-button toggle');
      toggle.type = 'button';
      toggle.addEventListener('click', () => {
        const i = node.item;
        send(i.paused ? 'resume' : 'pause', {client: i.client, item: i.id}, 'item:' + i.key);
      });
      head.append(decor('tile'), label, toggle);
      const rail = el('div', 'rail');
      const track = el('span', 'track');
      track.append(el('i'));
      const sub = el('p', 'sub');
      sub.append(el('span', 'amount'), el('span', 'left'));
      rail.append(track, el('span', 'pct'), sub);
      node.append(decor('ghost'), head, el('h3', 'title'), el('p', 'meta'), rail);
      cards.set(item.key, node);
    }
    node.item = item;
    node.dataset.type = item.type;
    node.dataset.tone = item.tone;
    node.dataset.state = item.state;
    set(node.querySelector('.ghost'), MONOGRAM[item.type] || '');
    set(node.querySelector('.tile'), MONOGRAM[item.type] || '');
    set(node.querySelector('.eyebrow'), item.eyebrow);
    set(node.querySelector('.from'), several ? names.get(item.client) || '' : '');
    const title = node.querySelector('.title');
    set(title, item.title);
    title.title = item.name;
    set(node.querySelector('.meta'), [item.speed, item.state === 'downloading' ? '' : item.right !== item.eyebrow ? item.right : ''].filter(Boolean).join(' · '));
    node.querySelector('.track i').style.width = (Math.max(0, Math.min(1, item.progress)) * 100).toFixed(1) + '%';
    node.querySelector('.track').setAttribute('aria-label', item.percent ? item.percent + ' done' : item.eyebrow);
    set(node.querySelector('.pct'), item.percent);
    set(node.querySelector('.amount'), item.amount);
    const eta = item.state === 'downloading' && item.right && !item.right.endsWith('/s') && !item.right.endsWith('%') ? item.right : '';
    set(node.querySelector('.left'), eta ? (eta === 'under a minute' ? 'Under a minute' : eta + ' left') : '');
    const toggle = node.querySelector('.toggle');
    toggle.hidden = !item.canPause;
    toggle.disabled = pending.has('item:' + item.key);
    setIcon(toggle, item.paused);
    toggle.setAttribute('aria-pressed', String(item.paused));
    toggle.setAttribute('aria-label', (item.paused ? 'Resume ' : 'Pause ') + item.title + ' on ' + (names.get(item.client) || ''));
    return node;
  }

  function finishedRow(item, names, several) {
    let node = done.get(item.key);
    if (!node) {
      node = el('li', 'fin');
      const body = el('div', 'body');
      body.append(el('span', 'name'), el('span', 'meta'));
      node.append(el('span', 'tick'), body, el('span', 'when'));
      done.set(item.key, node);
    }
    node.dataset.type = item.type;
    node.dataset.ok = String(item.ok);
    const name = node.querySelector('.name');
    set(name, item.title);
    name.title = item.name;
    set(node.querySelector('.meta'), [item.meta, several ? names.get(item.client) : ''].filter(Boolean).join(' · '));
    set(node.querySelector('.when'), item.right);
    return node;
  }

  // Keep only the nodes still shown, in the new order.
  function place(list, cache, nodes) {
    const keep = new Set(nodes);
    for (const [key, node] of cache) if (!keep.has(node)) cache.delete(key);
    const current = [...list.children];
    if (current.length !== nodes.length || current.some((node, i) => node !== nodes[i])) list.replaceChildren(...nodes);
  }

  function drawTrend() {
    const t = M.trend(samples, 600, 200, SLOTS);
    $('trendArea').setAttribute('d', t.area);
    $('trendLine').setAttribute('d', t.line);
    set($('peak'), t.peak > 0 && samples.length > 3 ? 'Peak ' + M.speedText(t.peak) : '');
  }

  function drawHeader(s) {
    const f = s?.fresh || {kind: 'loading', label: stopped ? 'Stopped' : 'Connecting', short: '', note: ''};
    const status = $('status');
    status.dataset.kind = f.kind;
    set($('statusText'), f.label);
    set($('statusShort'), f.short || '');
    status.title = f.note || '';
    $('statusRetry').hidden = f.kind !== 'stale';
    const stats = s?.stats || [];
    const box = $('stats');
    const key = JSON.stringify(stats);
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.replaceChildren(...stats.map(stat => {
        const span = el('span', '', stat.text);
        if (stat.tone) span.dataset.tone = stat.tone;
        return span;
      }));
    }
  }

  function show(id) {
    for (const panel of ['loading', 'failed']) $(panel).hidden = panel !== id;
    $('stage').hidden = Boolean(id);
    $('main').dataset.state = id || 'ready';
  }

  // Between 1000 and 1599 pixels wide the speed is always on screen, and the tabs switch the
  // other column between the queue and what finished.
  const middle = window.matchMedia('(min-width:1000px) and (max-width:1599px)');
  function select(pane) {
    shown = pane;
    const visible = middle.matches && pane === 'now' ? 'queue' : pane;
    $('main').dataset.show = visible;
    for (const tab of document.querySelectorAll('.tab')) tab.setAttribute('aria-pressed', String(tab.dataset.pane === visible));
  }

  function draw() {
    const s = data ? M.summarize(data, settings, Date.now()) : null;
    last = s;
    drawHeader(s && s.status === 'ready' ? s
      : s && s.status === 'failed' ? {fresh: {kind: 'stale', label: 'Unavailable', short: 'Offline', note: s.error}, stats: []} : null);
    if (stopped && !data) {
      set($('failedText'), 'The Downloads connector stopped: ' + stopped);
      return show('failed');
    }
    if (!s || s.status === 'loading') return show('loading');
    if (s.status === 'failed') {
      set($('failedText'), s.clients.length > 1 ? 'No download client answered. ' + s.error : s.error);
      return show('failed');
    }
    show('');
    const several = s.clients.length > 1;
    const names = new Map(s.clients.map(c => [c.i, c.name]));
    $('main').dataset.clients = several ? 'several' : 'one';

    // Speed: the reading over the graph, then each client.
    set($('speed'), s.speed.value);
    set($('speedUnit'), s.speed.unit);
    $('main').dataset.paused = String(s.speed.unit === '');
    place($('clients'), chips, s.clients.map(chip));

    // Queue: up to three cards share the width; more scroll sideways with the next one peeking.
    const list = $('cards');
    place(list, cards, s.items.map(item => card(item, names, several)));
    list.style.setProperty('--cols', String(s.items.length <= 3 ? Math.max(s.items.length, 1) : 2.6));
    list.dataset.more = String(list.scrollWidth - list.scrollLeft > list.clientWidth + 2);
    list.hidden = s.empty;
    $('idle').hidden = !s.empty;
    $('main').dataset.queue = s.empty ? 'empty' : 'busy';
    if (s.empty) {
      const latest = s.finished.find(f => f.ok);
      set($('idleTitle'), latest ? latest.title : 'All caught up');
      $('idleTitle').title = latest ? latest.name : '';
      const seeding = s.seeding && !settings.seeding ? s.seeding + (s.seeding === 1 ? ' torrent is' : ' torrents are') + ' seeding' : '';
      set($('idleMeta'), [latest ? 'Finished ' + latest.right : 'The queue is empty', seeding].filter(Boolean).join(' · '));
      $('idle').querySelector('.eyebrow').textContent = latest ? 'Last finished' : 'Nothing downloading';
    }
    const count = s.items.length ? String(s.items.length) : '';
    set($('queueCount'), count);
    set($('tabQueueCount'), count);

    // Finished: the last day's downloads, newest first.
    const showDone = settings.finished !== false;
    $('main').dataset.done = String(showDone);
    if (!showDone && shown === 'done') select('now');
    place($('finished'), done, s.finished.map(item => finishedRow(item, names, several)));
    $('doneEmpty').hidden = s.finished.length > 0;
    set($('doneCount'), s.finished.length ? String(s.finished.length) : '');

    // A small placement opens on the queue when something is downloading, else on the speed,
    // decided once at the first reading; after that it stays where it is.
    if (!chosen) { select(s.items.some(i => i.state === 'downloading') ? 'queue' : 'now'); chosen = true; }
  }

  function retry() { stopped = ''; send('refresh', {}, 'refresh:all'); }

  // One graph sample every few seconds, from the latest reading. Nothing is drawn while no
  // client has answered, so a gap isn't shown as a drop to zero.
  setInterval(() => {
    if (!last || last.status !== 'ready' || last.fresh.kind === 'stale' && last.rate === 0) return;
    samples.push(last.rate);
    if (samples.length > SLOTS) samples.splice(0, samples.length - SLOTS);
    drawTrend();
  }, SAMPLE_EVERY);

  $('cards').addEventListener('scroll', () => {
    const list = $('cards');
    list.dataset.more = String(list.scrollWidth - list.scrollLeft > list.clientWidth + 2);
  }, {passive: true});
  // Where the chip has no room for its own Retry, the stale chip itself retries.
  $('status').addEventListener('click', event => {
    if ($('status').dataset.kind === 'stale' && !event.target.closest('button')) retry();
  });
  for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => { chosen = true; select(tab.dataset.pane); });
  document.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.hasAttribute('data-retry')) retry();
    if (target.hasAttribute('data-settings')) D.settings.open();
  });
  window.addEventListener('resize', draw);
  middle.addEventListener('change', () => select(shown));

  D.subscribe(state => {
    settings = state.settings || {};
    draw();
  });
  D.onData(({data: next, error}) => {
    if (next) data = next;
    stopped = error ? String(error) : '';
    draw();
  });
  // Ages ("12 min ago") move on even when nothing new arrives.
  setInterval(draw, 15000);
})();
