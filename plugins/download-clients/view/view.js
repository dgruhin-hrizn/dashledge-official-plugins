// Downloads view. It runs in a sandboxed frame and reaches Dashledge only through
// window.Dashledge: the connector reads every client, this view draws them and sends
// pause, resume and refresh commands.
(function () {
  const M = window.DownloadsModel;
  const D = window.Dashledge;
  const $ = id => document.getElementById(id);
  let data = null, stopped = '', settings = {}, noticeTimer = 0;
  const pending = new Set();          // commands in flight, by key, so a button can't double-fire
  const rows = new Map(), chips = new Map(), done = new Map();

  function show(id) {
    for (const panel of ['content', 'loading', 'failed']) $(panel).hidden = panel !== id;
  }

  function notice(text) {
    $('notice').textContent = text;
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

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

  const PAUSE = 'M5 3h4.5v18H5zM14.5 3H19v18h-4.5z';
  const PLAY = 'M6 3.5v17l14-8.5z';
  function icon(d) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  }

  // One chip per client: its brand mark, name, state and its pause or retry button.
  function chip(c) {
    let node = chips.get(c.i);
    if (!node) {
      node = el('li', 'client');
      node.append(el('span', 'mark'), el('span', 'who'), el('span', 'note'), el('button', 'dl-button act'));
      node.querySelector('.who').append(el('strong'), el('span', 'product'));
      node.querySelector('.act').type = 'button';
      node.querySelector('.act').addEventListener('click', () => {
        const c = node.client;
        if (c.state === 'failed' || c.state === 'stale') send('refresh', {client: c.i}, 'refresh:' + c.i);
        else send(c.paused ? 'resume' : 'pause', {client: c.i}, 'client:' + c.i);
      });
      chips.set(c.i, node);
    }
    node.client = c;
    node.dataset.type = c.type;
    node.dataset.state = c.state;
    setText(node.querySelector('strong'), c.name);
    setText(node.querySelector('.product'), c.name === c.label ? '' : c.label);
    setText(node.querySelector('.note'), c.note);
    const button = node.querySelector('.act');
    const retry = c.state === 'failed' || c.state === 'stale';
    const label = retry ? 'Retry' : c.paused ? 'Resume' : 'Pause';
    setText(button, label);
    button.hidden = !retry && !c.canPause;
    button.disabled = pending.has((retry ? 'refresh:' : 'client:') + c.i);
    button.setAttribute('aria-label', label + ' ' + c.label + ' on ' + c.name);
    button.setAttribute('aria-pressed', String(!retry && c.paused));
    return node;
  }

  // One row per download, reused across refreshes so the list keeps its scroll position.
  function row(item, names) {
    let node = rows.get(item.key);
    if (!node) {
      node = el('li', 'dl-row item');
      const body = el('div', 'body');
      body.append(el('span', 'name'), el('span', 'meta'), el('span', 'bar'));
      body.querySelector('.bar').append(el('span', 'fill'));
      const button = el('button', 'dl-button dl-icon-button toggle');
      button.type = 'button';
      button.addEventListener('click', () => {
        const i = node.item;
        send(i.paused ? 'resume' : 'pause', {client: i.client, item: i.id}, 'item:' + i.key);
      });
      node.append(el('span', 'mark'), body, el('span', 'right'), button);
      rows.set(item.key, node);
    }
    node.item = item;
    node.dataset.type = item.type;
    node.dataset.state = item.state;
    setText(node.querySelector('.name'), item.name);
    node.querySelector('.name').title = item.name;
    setText(node.querySelector('.meta'), item.meta);
    setText(node.querySelector('.right'), item.right);
    node.querySelector('.fill').style.width = (item.progress * 100).toFixed(1) + '%';
    node.querySelector('.bar').setAttribute('aria-label', Math.round(item.progress * 100) + '% done');
    const button = node.querySelector('.toggle');
    button.hidden = !item.canPause;
    button.disabled = pending.has('item:' + item.key);
    if (button.dataset.icon !== String(item.paused)) {
      button.dataset.icon = String(item.paused);
      button.replaceChildren(icon(item.paused ? PLAY : PAUSE));
    }
    button.setAttribute('aria-pressed', String(item.paused));
    button.setAttribute('aria-label', (item.paused ? 'Resume ' : 'Pause ') + item.name + ' on ' + (names.get(item.client) || ''));
    return node;
  }

  function finishedRow(item) {
    let node = done.get(item.key);
    if (!node) {
      node = el('li', 'dl-row done');
      const body = el('div', 'body');
      body.append(el('span', 'name'), el('span', 'meta'));
      node.append(el('span', 'mark'), body, el('span', 'right'));
      done.set(item.key, node);
    }
    node.dataset.type = item.type;
    node.dataset.ok = String(item.ok);
    setText(node.querySelector('.name'), item.name);
    node.querySelector('.name').title = item.name;
    setText(node.querySelector('.meta'), item.meta);
    setText(node.querySelector('.right'), item.right);
    return node;
  }

  // Keep only the nodes still shown, in the new order.
  function place(list, cache, nodes) {
    const keep = new Set(nodes);
    for (const [key, node] of cache) if (!keep.has(node)) cache.delete(key);
    const current = [...list.children];
    if (current.length !== nodes.length || current.some((node, i) => node !== nodes[i])) list.replaceChildren(...nodes);
  }

  function draw() {
    if (stopped && !data) {
      $('failedText').textContent = 'The Downloads connector stopped: ' + stopped;
      return show('failed');
    }
    const s = M.summarize(data, settings, Date.now());
    if (s.status === 'loading') return show('loading');
    if (s.status === 'failed') {
      $('failedText').textContent = s.clients.length > 1 ? 'No download client answered. ' + s.error : s.error;
      return show('failed');
    }
    setText($('speed'), s.speed.value);
    setText($('speedUnit'), s.speed.unit);
    setText($('line'), s.line);
    place($('clients'), chips, s.clients.map(chip));
    const names = new Map(s.clients.map(c => [c.i, c.name]));
    place($('items'), rows, s.items.map(item => row(item, names)));
    $('nothing').hidden = !s.empty;
    setText($('nothing'), s.seeding && !settings.seeding ? 'Nothing downloading. ' + s.seeding + ' torrents are seeding.' : 'Nothing in the queue.');
    $('finishedBox').hidden = !s.finished.length;
    place($('finished'), done, s.finished.map(finishedRow));
    document.body.classList.toggle('single', s.clients.length === 1);
    show('content');
  }

  $('retry').addEventListener('click', () => { stopped = ''; send('refresh', {}, 'refresh:all'); });

  D.subscribe(state => {
    settings = state.settings || {};
    draw();
  });
  D.onData(({data: next, error}) => {
    if (next) data = next;
    stopped = error ? String(error) : '';
    draw();
  });
  // Ages ("from 5 min ago") move on even when nothing new arrives.
  setInterval(draw, 15000);
})();
