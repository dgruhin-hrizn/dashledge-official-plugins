// The Frigate view's pure logic: which cameras a placement shows, how they're laid out,
// which play live video, and the words on each tile. No DOM, so tests run it in Node.
(function (global) {
  // A placement keeps at most this many live streams; the others show snapshots.
  const MAX_LIVE = 4;
  // Below this tile height (CSS pixels) Automatic quality plays a camera's sub stream.
  const SUB_BELOW = 480;
  const SNAPSHOT_HEIGHTS = [180, 360, 540, 720, 1080];
  const LOOKS = ['standard', 'crt', 'crt-mono'];

  function settings(values) {
    const v = values && typeof values === 'object' ? values : {};
    const pick = (value, options, fallback) => (options.includes(value) ? value : fallback);
    return {
      cameras: Array.isArray(v.cameras) ? v.cameras.filter(c => typeof c === 'string') : ['*'],
      names: v.names && typeof v.names === 'object' ? v.names : {},
      layout: pick(v.layout, ['grid', 'spotlight'], 'grid'),
      look: pick(v.look, LOOKS, 'standard'),
      video: pick(v.video, ['live', 'snapshots'], 'live'),
      quality: pick(v.quality, ['auto', 'main', 'sub'], 'auto'),
      // How a picture fills its tile: smart (crop a little, show very wide pictures whole),
      // pan (always fill; drag to choose what shows) or whole. 1.0 drafts had a fill toggle.
      fit: pick(v.fit, ['smart', 'pan', 'whole'], v.fill === false ? 'whole' : 'smart'),
      detections: v.detections !== false,
    };
  }

  // A camera's value in the placement's settings is its Frigate name. Early 1.0.0 builds
  // stored "front.door" for "front_door" (from a misread of Dashledge's value rule, which
  // allows _); Frigate names never contain ".", so reading "." as "_" keeps those working.
  const toValue = name => String(name);
  const fromValue = value => String(value).replace(/\./g, '_');

  // The cameras this placement shows, in Frigate's order. "*" is every camera Frigate
  // puts on its own dashboard; a list names cameras, and ones Frigate no longer has are
  // left out (the view says so when none are left).
  function chosen(cameras, prefs) {
    const list = Array.isArray(cameras) ? cameras : [];
    if (prefs.cameras.includes('*')) return list.filter(c => c.enabled !== false && c.dashboard !== false);
    const wanted = new Set(prefs.cameras.map(fromValue));
    return list.filter(c => wanted.has(c.name));
  }
  // Names the placement chose that this Frigate doesn't have (renamed or removed).
  function missing(cameras, prefs) {
    if (prefs.cameras.includes('*')) return [];
    const have = new Set((cameras || []).map(c => c.name));
    return prefs.cameras.map(fromValue).filter(n => !have.has(n));
  }

  function label(camera, prefs) {
    const names = prefs.names || {};
    const saved = names[camera.name] ?? names[camera.name.replace(/_/g, '.')];
    const own = typeof saved === 'string' ? saved.trim() : '';
    return own || camera.label || camera.name;
  }

  // The options a placement's Cameras setting lists.
  function offer(cameras) {
    return (cameras || []).slice(0, 64).map(c => ({
      value: toValue(c.name), label: c.label || c.name,
      detail: !c.enabled ? 'Turned off in Frigate' : c.main ? 'Live video' : 'Snapshots only (no go2rtc stream)',
    }));
  }

  // ---- Layout ---------------------------------------------------------------------------

  // The aspect to pack tiles for: the cameras' own, kept between 4:3 and 21:9.
  function aspectOf(cameras) {
    const list = (cameras || []).map(c => c.aspect).filter(a => typeof a === 'number' && a > 0);
    if (!list.length) return 16 / 9;
    const mean = list.reduce((s, a) => s + a, 0) / list.length;
    return Math.min(21 / 9, Math.max(4 / 3, mean));
  }

  // The columns × rows that show n pictures of `aspect` largest in w × h, gap between.
  // Within 1% of each other, the arrangement with fewer empty cells wins, then the one
  // with fewer rows (the Edge is wide).
  function grid(n, w, h, aspect, gap = 0) {
    if (n <= 0 || w <= 0 || h <= 0) return {cols: 0, rows: 0, cellW: 0, cellH: 0, picture: 0};
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      if ((cols - 1) * rows >= n) continue;   // a whole empty column
      const cellW = (w - gap * (cols - 1)) / cols, cellH = (h - gap * (rows - 1)) / rows;
      if (cellW <= 0 || cellH <= 0) continue;
      const pw = Math.min(cellW, cellH * aspect);
      const picture = pw * (pw / aspect);
      const empty = cols * rows - n;
      const better = !best || picture > best.picture * 1.01 ||
        (picture >= best.picture * 0.99 && (empty < best.empty || (empty === best.empty && rows < best.rows)));
      if (better) best = {cols, rows, cellW, cellH, picture, empty};
    }
    return best || {cols: 1, rows: n, cellW: w, cellH: h / n, picture: 0, empty: 0};
  }

  // Rectangles for n tiles filling w × h. A short last row is centred.
  function gridRects(n, w, h, aspect, gap = 0, x0 = 0, y0 = 0) {
    const g = grid(n, w, h, aspect, gap);
    const rects = [];
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / g.cols), col = i % g.cols;
      const inRow = row === g.rows - 1 ? n - row * g.cols : g.cols;
      const offset = (g.cols - inRow) * (g.cellW + gap) / 2;
      rects.push(round({x: x0 + offset + col * (g.cellW + gap), y: y0 + row * (g.cellH + gap), w: g.cellW, h: g.cellH}));
    }
    return rects;
  }

  // One large tile and the rest packed beside it (wide) or below it (tall). The large
  // tile gets the camera's aspect at full height or width, but always leaves the others
  // at least a fifth of the space.
  function spotlightRects(n, w, h, aspect, gap = 0) {
    if (n <= 1) return n ? [round({x: 0, y: 0, w, h})] : [];
    const wide = w / h >= aspect * 0.9;
    if (wide) {
      const main = Math.min(w * 0.8, Math.max(w * 0.5, h * aspect));
      return [round({x: 0, y: 0, w: main, h}), ...gridRects(n - 1, w - main - gap, h, aspect, gap, main + gap, 0)];
    }
    const main = Math.min(h * 0.8, Math.max(h * 0.5, w / aspect));
    return [round({x: 0, y: 0, w, h: main}), ...gridRects(n - 1, w, h - main - gap, aspect, gap, 0, main + gap)];
  }

  function rects(layout, n, w, h, aspect, gap) {
    return layout === 'spotlight' ? spotlightRects(n, w, h, aspect, gap) : gridRects(n, w, h, aspect, gap);
  }

  const round = r => ({x: Math.round(r.x), y: Math.round(r.y), w: Math.max(0, Math.round(r.w)), h: Math.max(0, Math.round(r.h))});

  // ---- What each tile plays ---------------------------------------------------------------

  // A camera's signal from the connector's stats: 'live' while it sends frames, 'offline'
  // when it sends none, 'off' when turned off in Frigate, 'unknown' before stats arrive.
  function signal(camera, signals) {
    if (camera.enabled === false) return 'off';
    const s = signals && signals[camera.name];
    if (!s) return 'unknown';
    return s.fps > 0 ? 'live' : 'offline';
  }

  // The go2rtc stream for a tile of `height` CSS pixels. A CRT shows a few hundred lines
  // whatever it's fed, so Automatic plays the sub stream there at any size.
  function stream(camera, height, quality, look = 'standard') {
    if (!camera.main) return '';
    if (quality === 'main') return camera.main;
    if (quality === 'sub') return camera.sub || camera.main;
    return height < SUB_BELOW || look !== 'standard' ? camera.sub || camera.main : camera.main;
  }

  // Which tiles play live: the first MAX_LIVE (in order) whose camera has a stream and
  // isn't known to be offline, unless the placement wants snapshots. `capped` holds the
  // cameras Dashledge refused a stream to lately; they stay on snapshots for now.
  function liveSet(tiles, prefs, signals, capped = new Set()) {
    const live = new Set();
    if (prefs.video !== 'live') return live;
    for (const t of tiles) {
      if (live.size >= MAX_LIVE) break;
      const s = signal(t.camera, signals);
      if (t.camera.main && s !== 'offline' && s !== 'off' && !capped.has(t.camera.name)) live.add(t.camera.name);
    }
    return live;
  }

  // The snapshot height to ask Frigate for: the tile's device pixels, in a few steps so
  // resizing doesn't ask for a new size every frame.
  function snapshotHeight(px) {
    return SNAPSHOT_HEIGHTS.find(s => s >= px) || SNAPSHOT_HEIGHTS[SNAPSHOT_HEIGHTS.length - 1];
  }

  // Dashledge's answer when a placement or widget has all the streams it may keep:
  // "Stream limit: …" from the release with per-placement limits, "A widget may keep at
  // most 4 streams open." before it.
  const isCapError = message => /^Stream limit:|at most \d+ streams?/i.test(String(message || ''));
  // go2rtc's answer for a stream it doesn't serve.
  const isMissingStream = message => /stream not found|no such stream|not found/i.test(String(message || ''));

  // ---- Words ------------------------------------------------------------------------------

  const LABELS = {person: 'Person', car: 'Car', dog: 'Dog', cat: 'Cat', bicycle: 'Bicycle', motorcycle: 'Motorcycle',
    package: 'Package', bird: 'Bird', truck: 'Truck', bus: 'Bus', face: 'Face', license_plate: 'License plate', amazon: 'Amazon',
    ups: 'UPS', fedex: 'FedEx', usps: 'USPS', dhl: 'DHL', horse: 'Horse', deer: 'Deer', bear: 'Bear', fox: 'Fox'};
  const word = label => LABELS[label] || (label ? label.charAt(0).toUpperCase() + label.slice(1).replace(/_/g, ' ') : 'Something');

  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  }

  // The tile's detection line: what's in view now, else the latest one. Older than
  // `within` is left out so a quiet camera's tile stays clean.
  function detection(list, now, within = 2 * 60 * 60 * 1000) {
    if (!Array.isArray(list) || !list.length) return null;
    const active = list.filter(d => d.end === null);
    if (active.length) {
      const names = [...new Set(active.map(d => d.sub || word(d.label)))];
      return {active: true, text: names.slice(0, 2).join(', ') + (names.length > 2 ? ' +' + (names.length - 2) : ''), when: 'now'};
    }
    const last = list[0];
    if (now - (last.end || last.start) > within) return null;
    return {active: false, text: last.sub || word(last.label), when: ago(now - (last.end || last.start))};
  }

  // The on-screen display a CRT security monitor shows: "CAM 01", "11-28-2026", "21:04:07".
  function osd(index, date) {
    const p = n => String(n).padStart(2, '0');
    return {
      cam: 'CAM ' + p(index + 1),
      date: p(date.getMonth() + 1) + '-' + p(date.getDate()) + '-' + date.getFullYear(),
      time: p(date.getHours()) + ':' + p(date.getMinutes()) + ':' + p(date.getSeconds()),
    };
  }

  // What the tile's state pill says.
  function pill(state) {
    return {
      live: 'Live', connecting: 'Connecting', snapshot: 'Snapshot', offline: 'No signal', off: 'Off',
      unsupported: 'Snapshot', missing: 'Snapshot', capped: 'Snapshot', error: 'Reconnecting', unknown: '',
    }[state] ?? '';
  }

  // Where a picture of `aspect` goes in a w × h tile, for a fit mode (see settings):
  // - smart crops at most `maxCrop` of the picture; a wider one (a dual-lens camera's
  //   3.3 : 1 panorama in a 16 : 9 tile) shows whole over a blurred copy (`backdrop`);
  // - pan always fills, and `focus` ({x, y}, 0–1) chooses which part shows;
  // - whole shows the whole picture with black bars.
  // `pan` says the picture overflows the tile, so a drag can move it.
  function fit(w, h, aspect, mode = 'smart', focus = null, maxCrop = 0.3) {
    const tile = w / h;
    const crop = 1 - Math.min(aspect / tile, tile / aspect);
    const cover = mode === 'pan' || (mode === 'smart' && crop <= maxCrop);
    let dw, dh;
    if (cover ? aspect > tile : aspect < tile) { dh = h; dw = h * aspect; } else { dw = w; dh = w / aspect; }
    const fx = clamp01(focus?.x), fy = clamp01(focus?.y);
    const dx = dw > w ? (w - dw) * fx : (w - dw) / 2, dy = dh > h ? (h - dh) * fy : (h - dh) / 2;
    return {cover, backdrop: mode === 'smart' && !cover, pan: mode === 'pan' && (dw > w + 1 || dh > h + 1), dw, dh, dx, dy};
  }
  const clamp01 = v => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);

  // The whole widget's state from the connector's snapshot. Once cameras are known they
  // stay on screen through a failed read, with a banner instead.
  function status(data, stopped) {
    if (stopped) return {kind: 'stopped', error: stopped};
    if (!data) return {kind: 'loading'};
    if (!data.connected) return {kind: 'noconnection'};
    const cameras = Array.isArray(data.cameras) ? data.cameras : [];
    const error = data.error || null;
    if (!cameras.length && error) return {kind: 'failed', error: error.message, auth: error.kind === 'auth'};
    if (!cameras.length && !data.updated?.config) return {kind: 'loading'};
    return {kind: 'ready', error: error ? error.message : '', auth: error?.kind === 'auth', stale: !!data.stale};
  }

  global.FrigateModel = {
    MAX_LIVE, status, settings, toValue, fromValue, fit, chosen, missing, label, offer, aspectOf, grid, gridRects, spotlightRects, rects,
    signal, stream, liveSet, snapshotHeight, isCapError, isMissingStream, word, ago, detection, osd, pill,
  };
})(typeof window !== 'undefined' ? window : globalThis);
