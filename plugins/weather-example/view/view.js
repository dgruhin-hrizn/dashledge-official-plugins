// Weather (example) view. It runs in a sandboxed frame and reaches Dashledge only through
// window.Dashledge. The connector fetches; this view names its placement's place with the
// `watch` command and draws whatever the connector knows about it.
(function () {
  const M = window.WeatherModel;
  const $ = id => document.getElementById(id);
  const KEEP_ALIVE = 5 * 60 * 1000;
  let query = '', units = 'fahrenheit', entry = null, stopped = '';

  const settings = values => ({
    query: String(values?.location || '').replace(/\s+/g, ' ').trim(),
    units: values?.units === 'celsius' ? 'celsius' : 'fahrenheit',
  });

  async function watch(refresh = false) {
    if (!query || document.hidden) return;
    try {
      const answer = await window.Dashledge.command('watch', {query, refresh});
      // The connector's broadcast is newer when it has arrived; otherwise use the answer.
      if (answer && answer.query && (!entry || entry.query.toLowerCase() !== query.toLowerCase())) entry = answer;
    } catch (error) {
      stopped = String(error?.message || error);
    }
    draw();
  }

  function show(id) {
    for (const panel of ['content', 'loading', 'empty', 'failed']) $(panel).hidden = panel !== id;
  }

  function draw() {
    if (stopped && !entry?.weather) {
      $('failedText').textContent = 'The weather connector stopped: ' + stopped;
      return show('failed');
    }
    const s = M.status(entry, query, Date.now());
    if (s.kind === 'empty') {
      $('emptyText').textContent = 'Choose a place for this widget.';
      $('emptyAction').textContent = 'Choose a place';
      return show('empty');
    }
    if (s.kind === 'notfound') {
      $('emptyText').textContent = 'Open-Meteo has no place called “' + s.query + '”.';
      $('emptyAction').textContent = 'Change place';
      return show('empty');
    }
    if (s.kind === 'loading') return show('loading');
    if (s.kind === 'failed') {
      $('failedText').textContent = 'Weather unavailable. ' + s.error;
      return show('failed');
    }
    const r = M.reading(entry, units);
    $('place').textContent = r.place || query;
    $('temp').textContent = r.temp ?? '—';
    $('unit').textContent = r.unit;
    $('label').textContent = r.label;
    $('detail').textContent = r.detail;
    $('staleText').textContent = s.note;
    $('stale').hidden = !s.stale;
    const svg = $('chart');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', M.chartPath(entry.weather.hours, 240, 80));
    svg.replaceChildren(path);
    $('hours').replaceChildren(...M.marks(entry.weather.hours, units).map(mark => {
      const item = document.createElement('li');
      const time = document.createElement('span'), temp = document.createElement('strong');
      time.textContent = mark.time;
      temp.textContent = mark.temp === null ? '—' : mark.temp + '°';
      item.append(time, temp);
      return item;
    }));
    show('content');
  }

  window.Dashledge.subscribe(state => {
    const next = settings(state.settings);
    const moved = next.query.toLowerCase() !== query.toLowerCase();
    units = next.units;
    if (moved) { query = next.query; entry = null; stopped = ''; watch(); }
    draw();
  });

  window.Dashledge.onData(({data, error}) => {
    stopped = error ? String(error) : '';
    const found = query ? data?.places?.[query.toLowerCase()] : null;
    if (found) entry = found;
    draw();
  });

  $('emptyAction').addEventListener('click', () => window.Dashledge.settings.open());
  $('retry').addEventListener('click', () => { stopped = ''; watch(true); });
  $('staleRetry').addEventListener('click', () => watch(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) watch(); });
  // The connector forgets places nobody asks about, so keep asking while on screen,
  // and redraw so "Last updated" stays true.
  setInterval(() => watch(), KEEP_ALIVE);
  setInterval(draw, 60 * 1000);

  const first = settings(window.Dashledge.settings.values);
  query = first.query;
  units = first.units;
  draw();
  watch();
})();
