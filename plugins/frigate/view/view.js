// Frigate view. It runs in a sandboxed frame and reaches Dashledge only through
// window.Dashledge. The connector emits {cameras, signals, detections, …}; this view picks
// the placement's cameras, lays them out for its size, plays up to four live and shows
// snapshots for the rest, and draws each one plain or on a CRT security monitor.
(function () {
  const M = window.FrigateModel;
  const D = window.Dashledge;
  const $ = id => document.getElementById(id);
  const KEEP_ALIVE = 4 * 60 * 1000;
  const SNAPSHOT_EVERY = 1000;        // a tile without live video
  const POSTER_EVERY = 4000;          // a live tile until its video plays
  const CAPPED_FOR = 30 * 1000;       // before asking Dashledge for a refused stream again
  const MISSING_FOR = 5 * 60 * 1000;  // before asking go2rtc for a stream it didn't have
  const FRAME_MS = 1000 / 30;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  // How long a tile keeps its last video frame while the video reconnects, before the
  // latest snapshot replaces it.
  const HOLD_FRAME = 15 * 1000;
  // Each camera's real picture shape, learned from its video. Frigate's snapshots come at
  // its detect size, which can squash a panorama (5120 × 1552 into 1280 × 720); they're
  // drawn back at this shape so a snapshot frames the scene as the video does.
  const shapes = new Map();

  let data = null, stopped = '', prefs = M.settings(D.settings.values);
  let focused = '';                   // a camera shown full size after a tap
  let offered = '';
  const tiles = new Map();            // camera name → tile
  const capped = new Map();           // camera name → when Dashledge refused its stream
  const missing = new Map();          // stream name → when go2rtc didn't have it

  // ---- Talking to the connector -------------------------------------------------------
  async function watch(refresh = false) {
    if (document.hidden && !refresh) return;
    try {
      await D.command('watch', {refresh});
      stopped = '';
    } catch (error) {
      stopped = String(error?.message || error);
    }
    draw();
  }
  const retry = () => {
    stopped = '';
    capped.clear();
    missing.clear();
    for (const tile of tiles.values()) tile.failed = '';
    watch(true);
  };

  const set = (el, text) => { if (el.textContent !== text) el.textContent = text; };

  // ---- A tile: one camera ----------------------------------------------------------------
  function makeTile(camera) {
    const el = $('tileTemplate').content.firstElementChild.cloneNode(true);
    const q = s => el.querySelector(s);
    const tile = {
      name: camera.name, camera, el,
      screen: q('.screen'), img: q('.snap'), video: q('.video'), canvas: q('.crt'), paint: q('.paint'), paintCtx: null, paintTime: -1, painted: '', videoAt: 0, backdrop: null,
      pan: q('.pan'), panSize: q('.pan-size'), panning: false, panSaveTimer: 0, panSetting: false, focus: null,
      parts: {name: q('.name'), det: q('.detection'), detText: q('.det-text'), detWhen: q('.det-when'),
        pill: q('.pill'), pillText: q('.pill-text'), why: q('.why'), message: q('.message'),
        osdCam: q('.osd-cam'), osdDate: q('.osd-date'), osdTime: q('.osd-time'), osdRec: q('.osd-rec')},
      player: null, stream: '', playing: false, state: 'unknown', failed: '',
      snapTimer: 0, snapBusy: false, snapH: 0, hasSnap: false, snapVersion: 0, drawnSnap: -1,
      crt: null, glFailed: false, lastVideoTime: -1, index: 0,
    };
    el.dataset.name = camera.name;
    tile.video.addEventListener('playing', () => { tile.playing = true; tile.why = ''; tile.paintTime = -1; learnShape(tile); refreshTile(tile); });
    tile.video.addEventListener('resize', () => learnShape(tile));
    tile.video.addEventListener('loadeddata', wake);
    tile.video.addEventListener('waiting', () => { if (tile.video.readyState < 2) { tile.playing = false; refreshTile(tile); } });
    tile.img.addEventListener('load', () => { tile.hasSnap = true; tile.snapVersion++; paintStill(tile); refreshTile(tile); });
    // Fill and drag: the pan layer scrolls over the picture; where it's scrolled to is
    // the part that shows. Touch on the Edge and the trackpad in the preview both scroll it.
    tile.pan.addEventListener('scroll', () => {
      if (tile.panSetting) return;
      const p = tile.pan, rx = p.scrollWidth - p.clientWidth, ry = p.scrollHeight - p.clientHeight;
      tile.focus = {x: rx > 0 ? p.scrollLeft / rx : 0.5, y: ry > 0 ? p.scrollTop / ry : 0.5};
      tile.panning = true;
      repaint(tile);
      clearTimeout(tile.panSaveTimer);
      tile.panSaveTimer = setTimeout(() => {
        tile.panning = false;
        D.command('focus', {camera: tile.name, x: tile.focus.x, y: tile.focus.y}).catch(() => {});
      }, 700);
    }, {passive: true});
    el.addEventListener('click', () => toggleFocus(tile.name));
    el.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleFocus(tile.name); }
      if (event.key === 'Escape' && focused) { event.preventDefault(); toggleFocus(focused); }
    });
    return tile;
  }

  function stopPlayer(tile) {
    tile.player?.stop();
    tile.player = null;
    tile.stream = '';
    tile.playing = false;
    tile.video.removeAttribute('src');
    tile.video.srcObject = null;
  }
  function stopSnapshots(tile) {
    clearTimeout(tile.snapTimer);
    tile.snapTimer = 0;
  }
  function destroyTile(tile) {
    stopPlayer(tile);
    stopSnapshots(tile);
    tile.crt?.destroy();
    tile.el.remove();
  }

  // Ask Frigate for the latest frame, then again after `every`. One request at a time.
  function snapshots(tile, every) {
    if (tile.snapEvery === every && tile.snapTimer) return;
    stopSnapshots(tile);
    tile.snapEvery = every;
    const next = async () => {
      tile.snapTimer = 0;
      if (document.hidden || !tiles.has(tile.name) || tile.snapEvery !== every) return;
      if (!tile.snapBusy) {
        tile.snapBusy = true;
        try {
          const url = await D.image('api/' + tile.name + '/latest.jpg?h=' + tile.snapH, {fresh: true});
          if (tiles.get(tile.name) === tile) tile.img.src = url;
        } catch {
          // Keep the last frame; the pill and signal say what's wrong.
        } finally {
          tile.snapBusy = false;
        }
      }
      if (tiles.get(tile.name) === tile && tile.snapEvery === every) tile.snapTimer = setTimeout(next, every);
    };
    tile.snapTimer = setTimeout(next, 0);
  }

  // Decide what one tile plays and how it's labelled.
  function updateTile(tile, {camera, rect, live, index, now, hidden}) {
    tile.camera = camera;
    tile.index = index;
    const el = tile.el;
    el.hidden = hidden;
    if (hidden) {
      stopPlayer(tile);
      stopSnapshots(tile);
      return;
    }
    el.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    el.style.width = rect.w + 'px';
    el.style.height = rect.h + 'px';
    if (!el.classList.contains('placed')) requestAnimationFrame(() => el.classList.add('placed'));
    el.dataset.size = rect.h < 200 || rect.w < 300 ? 'tiny' : rect.h < 340 || rect.w < 560 ? 'small' : 'large';

    const dpr = window.devicePixelRatio || 1;
    tile.snapH = M.snapshotHeight(rect.h * dpr);
    const signal = M.signal(camera, data?.signals);
    const wanted = live ? M.stream(camera, rect.h, prefs.quality, prefs.look) : '';

    if (wanted && wanted !== tile.stream) {
      stopPlayer(tile);
      tile.stream = wanted;
      tile.failed = '';
      tile.player = window.FrigatePlayer(tile.video, wanted, {onState: (state, why) => onPlayerState(tile, wanted, state, why)});
    } else if (!wanted && tile.player) {
      stopPlayer(tile);
    }

    // Snapshots: the picture for a tile without video, and the poster until video plays.
    // Frigate's frame for a camera without signal is its own "No frames" card, so none is shown.
    if (signal === 'off' || signal === 'offline') stopSnapshots(tile);
    else if (tile.player && tile.playing) stopSnapshots(tile);
    else snapshots(tile, tile.player ? POSTER_EVERY : SNAPSHOT_EVERY);

    tile.signal = signal;
    set(tile.parts.name, M.label(camera, prefs));
    el.setAttribute('aria-label', M.label(camera, prefs) + (focused ? '. Show all cameras' : '. Show full size'));
    const det = prefs.detections ? M.detection(data?.detections?.[camera.name], now) : null;
    tile.parts.det.hidden = !det;
    if (det) {
      tile.parts.det.dataset.active = String(det.active);
      set(tile.parts.detText, det.text);
      set(tile.parts.detWhen, det.when === 'now' ? '' : det.when);
    }
    tile.parts.osdRec.hidden = !det?.active;
    set(tile.parts.osdCam, M.osd(index, new Date(now)).cam + ' ' + M.label(camera, prefs).toUpperCase());
    if (!(tile.player && tile.playing)) paintStill(tile);
    refreshTile(tile);
  }

  function onPlayerState(tile, stream, state, why = '') {
    if (tile.stream !== stream) return;
    tile.playerState = state;
    if (why) tile.why = why;
    if (state === 'capped') {
      capped.set(tile.name, Date.now());
      stopPlayer(tile);
      draw();
    } else if (state === 'missing' || state === 'unsupported') {
      missing.set(stream, Date.now());
      tile.failed = state;
      stopPlayer(tile);
      draw();
    } else {
      if (state !== 'live') {
        tile.playing = false;
        // Show the latest frame while the video comes back.
        if (!tile.snapTimer && tile.signal !== 'off') snapshots(tile, POSTER_EVERY);
      }
      refreshTile(tile);
    }
  }

  // The tile's picture source, pill and message, from its current state.
  function refreshTile(tile) {
    const video = !!(tile.player && tile.playing);
    let state;
    if (tile.signal === 'off') state = 'off';
    else if (tile.signal === 'offline') state = 'offline';
    else if (video) state = 'live';
    else if (tile.player) state = tile.playerState === 'error' || tile.playerState === 'reconnecting' ? 'error' : 'connecting';
    else state = 'snapshot';
    tile.state = state;
    const el = tile.el;
    el.dataset.state = state;
    // Everything shows on the paint canvas: live frames, the last frame while video comes
    // back, or the latest snapshot.
    el.dataset.picture = state !== 'off' && state !== 'offline' && (video || tile.painted) ? 'paint' : 'none';
    set(tile.parts.pillText, M.pill(state));
    tile.parts.pill.hidden = !M.pill(state);
    // Why live video is down, once it has failed: small, under the pill.
    const why = state === 'error' || state === 'connecting' || state === 'snapshot' ? tile.why || '' : '';
    set(tile.parts.why, why ? 'Live video: ' + why : '');
    tile.parts.why.hidden = !why;
    set(tile.parts.message, state === 'offline' ? 'No signal' : state === 'off' ? 'Turned off in Frigate' : '');
    tile.parts.message.hidden = !tile.parts.message.textContent;
    wake();
  }

  function toggleFocus(name) {
    const shown = chosenCameras();
    if (shown.length <= 1) return;
    focused = focused === name ? '' : name;
    draw();
    // Keep keyboard focus on the tile the user acted on.
    tiles.get(name)?.el.focus({preventScroll: true});
  }

  function chosenCameras() {
    return data && Array.isArray(data.cameras) ? M.chosen(data.cameras, prefs) : [];
  }

  // ---- The whole widget -------------------------------------------------------------------
  function show(id) {
    for (const panel of ['loading', 'unconnected', 'unavailable', 'stopped', 'empty']) $(panel).hidden = panel !== id;
    $('wall').hidden = Boolean(id);
    $('main').dataset.state = id || 'ready';
    if (id) clearTiles();
  }
  function clearTiles() {
    for (const tile of tiles.values()) destroyTile(tile);
    tiles.clear();
    focused = '';
    $('back').hidden = true;
  }

  function offerCameras() {
    const options = M.offer(data?.cameras);
    const key = JSON.stringify(options);
    if (!options.length || key === offered) return;
    offered = key;
    D.settings.offer('cameras', options).catch(() => { offered = ''; });
  }

  function banner(s) {
    const text = s.kind === 'ready' && s.error ? s.error + (s.stale ? '. Showing the cameras from last time.' : '') : '';
    $('banner').hidden = !text;
    set($('bannerText'), text);
    $('banner').querySelector('[data-fix]').hidden = !s.auth;
  }

  function draw() {
    const now = Date.now();
    for (const [name, at] of capped) if (now - at > CAPPED_FOR) capped.delete(name);
    for (const [name, at] of missing) if (now - at > MISSING_FOR) missing.delete(name);
    const main = $('main');
    main.dataset.look = prefs.look;
    main.dataset.fit = prefs.fit;
    main.dataset.motion = reduceMotion.matches ? 'reduced' : 'full';

    const s = M.status(data, stopped);
    banner(s);
    if (s.kind === 'stopped') { set($('stoppedText'), 'The Frigate connector stopped: ' + s.error); return show('stopped'); }
    if (s.kind === 'loading') return show('loading');
    if (s.kind === 'noconnection') return show('unconnected');
    if (s.kind === 'failed') {
      set($('unavailableText'), s.error);
      $('unavailable').querySelector('[data-fix]').hidden = !s.auth;
      return show('unavailable');
    }
    offerCameras();

    // Streams go2rtc didn't have play as snapshots for a while.
    const usable = name => (name && !missing.has(name) ? name : '');
    const cameras = chosenCameras().map(c => {
      const main = usable(c.main) || usable(c.sub);
      return {...c, main, sub: usable(c.sub) || main};
    });
    if (!cameras.length) {
      const gone = M.missing(data.cameras, prefs);
      set($('emptyText'), gone.length
        ? 'This Frigate has no camera named ' + gone.slice(0, 3).join(', ') + '. Choose the cameras to show.'
        : data.cameras.length ? 'Choose the cameras this placement shows.' : 'This Frigate has no cameras yet.');
      return show('empty');
    }
    show('');
    if (focused && !cameras.some(c => c.name === focused)) focused = '';
    $('back').hidden = !focused;
    main.dataset.count = String(cameras.length);
    main.dataset.focused = String(!!focused);

    // Keyed tiles: a refresh never rebuilds a playing video.
    const wall = $('wall');
    const keep = new Set(cameras.map(c => c.name));
    for (const [name, tile] of tiles) if (!keep.has(name)) { destroyTile(tile); tiles.delete(name); }
    cameras.forEach(camera => {
      if (!tiles.has(camera.name)) {
        const tile = makeTile(camera);
        tiles.set(camera.name, tile);
        wall.append(tile.el);
      }
    });

    const box = wall.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(wall).columnGap) || 0;
    const aspect = M.aspectOf(cameras.map(c => (shapes.has(c.name) ? {...c, aspect: shapes.get(c.name)} : c)));
    const shown = focused ? cameras.filter(c => c.name === focused) : cameras;
    const rects = focused ? [{x: 0, y: 0, w: Math.round(box.width), h: Math.round(box.height)}]
      : M.rects(prefs.layout, shown.length, box.width, box.height, aspect, gap);
    const order = shown.map((camera, i) => ({camera, rect: rects[i]}));
    const live = M.liveSet(order, prefs, data.signals, new Set(capped.keys()));

    cameras.forEach((camera, index) => {
      const at = order.findIndex(o => o.camera.name === camera.name);
      updateTile(tiles.get(camera.name), {camera, rect: at >= 0 ? order[at].rect : null, live: live.has(camera.name),
        index, now, hidden: at < 0});
    });
    clock();
  }

  // ---- Drawing the picture ----------------------------------------------------------------
  // Live video is decoded by the tile's <video> and drawn onto a canvas: plain in the
  // standard look, through the CRT shader in the monitor looks. Dashledge's Edge window
  // doesn't composite a <video> inside a widget's frame (it plays, decodes, and shows
  // black), while a canvas shows everywhere.
  let frame = 0, lastFrame = 0;
  const crtLook = () => prefs.look === 'crt' || prefs.look === 'crt-mono';
  const playing = tile => !tile.el.hidden && tile.state === 'live' && tile.video.readyState >= 2;
  const needsFrames = () => !document.hidden && tiles.size && (crtLook() || [...tiles.values()].some(playing));
  function wake() {
    if (!frame && needsFrames()) frame = requestAnimationFrame(render);
  }
  function fitCanvas(canvas, dpr) {
    const w = Math.min(2560, Math.max(1, Math.round(canvas.clientWidth * dpr)));
    const h = Math.min(1440, Math.max(1, Math.round(canvas.clientHeight * dpr)));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; return true; }
    return false;
  }
  // Where a camera's picture is panned to: this view's drag, else what the connector remembers.
  const focusOf = tile => tile.focus || data?.focus?.[tile.name] || null;
  function repaint(tile) {
    tile.paintTime = -1;
    tile.drawnStill = -1;
    if (tile.player && tile.playing) paint(tile, Math.min(window.devicePixelRatio || 1, 2)); else paintStill(tile);
    wake();
  }
  // Size the pan layer to the picture and scroll it to the focus, unless a drag is under way.
  function syncPan(tile, f, dpr) {
    const on = !!f?.pan;
    tile.el.dataset.pan = String(on);
    if (!on) return;
    const w = Math.round(f.dw / dpr) + 'px', h = Math.round(f.dh / dpr) + 'px';
    if (tile.panSize.style.width !== w) tile.panSize.style.width = w;
    if (tile.panSize.style.height !== h) tile.panSize.style.height = h;
    if (tile.panning) return;
    const p = tile.pan, rx = p.scrollWidth - p.clientWidth, ry = p.scrollHeight - p.clientHeight;
    const focus = focusOf(tile) || {x: 0.5, y: 0.5};
    const left = Math.round(rx * focus.x), top = Math.round(ry * focus.y);
    if (Math.abs(p.scrollLeft - left) > 1 || Math.abs(p.scrollTop - top) > 1) {
      tile.panSetting = true;
      p.scrollLeft = left; p.scrollTop = top;
      requestAnimationFrame(() => { tile.panSetting = false; });
    }
  }
  function learnShape(tile) {
    const v = tile.video;
    if (!v.videoWidth || !v.videoHeight) return;
    const aspect = Math.round(v.videoWidth / v.videoHeight * 1000) / 1000;
    if (shapes.get(tile.name) === aspect) return;
    shapes.set(tile.name, aspect);
    draw();
  }
  // Draw `source` at `aspect` into the tile's canvas: cropped to fill, or whole over a
  // blurred, darkened copy of itself (drawn tiny and stretched, which blurs for free).
  function drawPicture(tile, source, aspect) {
    const c = tile.paint;
    const ctx = tile.paintCtx || (tile.paintCtx = c.getContext('2d', {alpha: false}));
    if (!ctx) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const f = M.fit(c.width, c.height, aspect, prefs.fit, focusOf(tile));
    syncPan(tile, f, dpr);
    if (!f.cover) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, c.width, c.height);
    }
    if (f.backdrop) {
      const b = tile.backdrop || (tile.backdrop = document.createElement('canvas'));
      b.width = 48; b.height = Math.max(8, Math.round(48 * c.height / c.width));
      const bf = M.fit(b.width, b.height, aspect, 'pan');
      b.getContext('2d').drawImage(source, bf.dx, bf.dy, bf.dw, bf.dh);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // A real blur where the canvas has filters; past the edges so they don't darken.
      const r = Math.round(Math.max(c.width, c.height) / 40);
      if ('filter' in ctx) ctx.filter = 'blur(' + r + 'px)';
      ctx.drawImage(b, -2 * r, -2 * r, c.width + 4 * r, c.height + 4 * r);
      if ('filter' in ctx) ctx.filter = 'none';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ctx.drawImage(source, f.dx, f.dy, f.dw, f.dh);
    return true;
  }
  // The latest video frame.
  function paint(tile, dpr) {
    if (!playing(tile)) return;
    const v = tile.video;
    const resized = fitCanvas(tile.paint, dpr);
    if (!resized && v.currentTime === tile.paintTime) return;
    tile.paintTime = v.currentTime;
    if (!v.videoWidth || !v.videoHeight) return;
    if (drawPicture(tile, v, v.videoWidth / v.videoHeight)) { tile.painted = 'video'; tile.videoAt = Date.now(); }
  }
  // The latest snapshot, at the camera's real shape, unless a recent video frame is
  // holding the tile while the video reconnects.
  function paintStill(tile) {
    if (!tile.hasSnap || tile.el.hidden || (tile.player && tile.playing)) return;
    if (tile.painted === 'video' && Date.now() - tile.videoAt < HOLD_FRAME) {
      clearTimeout(tile.holdTimer);
      tile.holdTimer = setTimeout(() => { paintStill(tile); refreshTile(tile); }, HOLD_FRAME);
      return;
    }
    const img = tile.img, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resized = fitCanvas(tile.paint, dpr);
    if (!resized && tile.painted === 'snap' && tile.drawnStill === tile.snapVersion) return;
    if (!img.naturalWidth || !img.naturalHeight) return;
    tile.drawnStill = tile.snapVersion;
    if (drawPicture(tile, img, shapes.get(tile.name) || img.naturalWidth / img.naturalHeight)) tile.painted = 'snap';
  }
  function render(t) {
    frame = 0;
    if (!needsFrames()) return;
    frame = requestAnimationFrame(render);
    if (t - lastFrame < FRAME_MS) return;
    lastFrame = t;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!crtLook()) {
      for (const tile of tiles.values()) paint(tile, dpr);
      return;
    }
    const motion = !reduceMotion.matches;
    for (const tile of tiles.values()) {
      if (tile.el.hidden) continue;
      if (tile.glFailed) { paint(tile, dpr); continue; }
      if (!tile.crt) {
        tile.crt = window.FrigateCRT.create(tile.canvas);
        if (!tile.crt) { tile.glFailed = true; tile.el.dataset.gl = 'none'; continue; }
        tile.el.dataset.gl = 'on';
      }
      const w = Math.max(1, Math.round(tile.canvas.clientWidth * dpr)), h = Math.max(1, Math.round(tile.canvas.clientHeight * dpr));
      tile.crt.resize(Math.min(w, 2560), Math.min(h, 1440));
      const video = playing(tile);
      const noSignal = tile.state === 'offline' || tile.state === 'off';
      let source = null, fresh = true;
      if (video) {
        source = tile.video;
        fresh = tile.video.currentTime !== tile.lastVideoTime;
        tile.lastVideoTime = tile.video.currentTime;
      } else if (tile.hasSnap) {
        source = tile.img;
        fresh = tile.drawnSnap !== tile.snapVersion;
        tile.drawnSnap = tile.snapVersion;
      }
      const shape = video ? tile.video.videoWidth / tile.video.videoHeight : shapes.get(tile.name) || (tile.img.naturalWidth / tile.img.naturalHeight) || 16 / 9;
      const f = M.fit(w, h, shape, prefs.fit, focusOf(tile));
      syncPan(tile, f, dpr);
      const ok = tile.crt.draw(source, {mono: prefs.look === 'crt-mono', noSignal, cover: f.cover, aspect: shape, focus: focusOf(tile), time: t / 1000, motion, fresh});
      if (!ok) {
        tile.crt.destroy();
        tile.crt = null;
        tile.glFailed = true;
        tile.el.dataset.gl = 'none';
      }
    }
  }
  function dropCRT() {
    for (const tile of tiles.values()) {
      tile.crt?.destroy();
      tile.crt = null;
      tile.glFailed = false;
      delete tile.el.dataset.gl;
    }
  }

  // The monitor's on-screen date and time, once a second.
  function clock() {
    if (!crtLook()) return;
    const o = M.osd(0, new Date());
    for (const tile of tiles.values()) {
      if (tile.el.hidden) continue;
      set(tile.parts.osdDate, o.date);
      set(tile.parts.osdTime, o.time);
    }
  }

  // ---- Wiring --------------------------------------------------------------------------------
  D.subscribe(state => {
    const next = M.settings(state.settings);
    const lookChanged = next.look !== prefs.look;
    prefs = next;
    if (lookChanged) dropCRT();
    draw();
    wake();
  });
  D.onData(({data: next, error}) => {
    stopped = error ? String(error) : '';
    if (next && typeof next === 'object' && 'connected' in next) data = next;
    draw();
  });

  new ResizeObserver(() => draw()).observe($('wall'));
  $('back').addEventListener('click', () => { focused = ''; draw(); });
  document.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.hasAttribute('data-retry')) retry();
    if (target.hasAttribute('data-settings') || target.hasAttribute('data-fix')) D.settings.open().catch(() => {});
  });
  // Hidden: stop every stream and snapshot. Shown again: start over.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      for (const tile of tiles.values()) { stopPlayer(tile); stopSnapshots(tile); }
    } else {
      watch();
      draw();
      wake();
    }
  });
  reduceMotion.addEventListener?.('change', () => draw());
  setInterval(() => watch(), KEEP_ALIVE);
  setInterval(clock, 1000);
  // Keep "3 min ago" true and retry refused streams while nothing new arrives.
  setInterval(() => { if (!document.hidden) draw(); }, 15 * 1000);

  draw();
  watch();
})();
