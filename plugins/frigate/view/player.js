// Live video from Frigate's go2rtc as fragmented MP4 over the manifest's `live` stream,
// played with Media Source Extensions. Adapted from Dashledge's samples/mse-player.js.
//
// The view runs in a sandboxed frame with an opaque origin, where a blob: media URL
// doesn't play, so the MediaSource is attached with `video.srcObject`.
//
// States reported to onState: connecting, live, reconnecting, capped (Dashledge refused
// another stream: the placement has all it may keep), missing (go2rtc doesn't serve the
// stream), unsupported (this Mac can't decode it), error. capped, missing and unsupported
// don't retry; the view shows snapshots instead and decides when to try again.
(() => {
  const M = window.FrigateModel;
  const Source = window.ManagedMediaSource || window.MediaSource;
  // What go2rtc may send, best first: H.264, H.265, then audio it can pair (muted here).
  const CANDIDATES = ['avc1.640029', 'avc1.64002A', 'avc1.640033', 'hvc1.1.6.L153.B0', 'mp4a.40.2', 'mp4a.40.5', 'flac', 'opus'];
  const supported = () => CANDIDATES.filter(codec => Source?.isTypeSupported(`video/mp4; codecs="${codec}"`)).join(',');
  const STALL = 12000;

  window.FrigatePlayer = function play(video, stream, {onState = () => {}, maxBuffer = 10} = {}) {
    let lastError = '', socket = null, source = null, buffer = null, queue = [], stopped = false, retry = 1000, timer = 0, watchdog = 0, lastData = 0, lastTrim = 0;
    video.muted = true;
    video.playsInline = true;
    video.disableRemotePlayback = true; // ManagedMediaSource needs this before attaching.

    const reset = () => {
      queue = [];
      buffer = null;
      if (source && video.srcObject === source) video.srcObject = null;
      if (objectURL) { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(objectURL); objectURL = ''; }
      source = null;
    };
    // Append queued segments one at a time; stay near the live edge and trim old video.
    // WebKit won't evict the group of pictures being played, so with a camera's long
    // keyframe interval a trim can remove nothing. Trimming at most every 5 seconds, behind
    // the playhead, keeps that from looping on remove and starving the appends.
    const pump = () => {
      if (!buffer || buffer.updating) return;
      const ranges = buffer.buffered;
      if (ranges.length) {
        const start = ranges.start(0), end = ranges.end(ranges.length - 1);
        if (end - video.currentTime > 2.5) video.currentTime = end - 0.4;
        const now = Date.now();
        // A camera that rarely sends a keyframe can't be trimmed at all; start it afresh
        // before its buffer grows without bound.
        if (end - start > 90) return restart('reconnecting', 'buffer full');
        if (video.currentTime - start > maxBuffer * 1.5 && now - lastTrim > 5000) {
          lastTrim = now;
          try { buffer.remove(start, video.currentTime - maxBuffer); return; } catch {}
        }
      }
      const next = queue.shift();
      if (next) {
        try { buffer.appendBuffer(next); } catch (error) { restart('error', 'append: ' + (error?.name || error)); }
      }
    };
    let objectURL = '';
    const attach = mime => {
      source = new Source();
      try {
        video.srcObject = source;
      } catch {
        // Engines without MediaSource as srcObject (Chromium) play a blob: URL instead.
        // Dashledge's WebKit never gets here.
        objectURL = URL.createObjectURL(source);
        video.src = objectURL;
      }
      source.addEventListener('sourceopen', () => {
        try {
          buffer = source.addSourceBuffer(mime);
          buffer.mode = 'segments';
          buffer.addEventListener('updateend', pump);
          pump();
          video.play().catch(error => onState('blocked', 'play: ' + (error?.name || error)));
        } catch (error) {
          end('unsupported', mime + ': ' + (error?.message || error));
        }
      }, {once: true});
    };
    // Forget the current socket first, so its own close event doesn't restart it again.
    const drop = () => {
      const current = socket;
      socket = null;
      clearInterval(watchdog);
      current?.close();
      reset();
    };
    // `why` says what went wrong, for the tile to show while live video is down.
    const restart = (state, why = '') => {
      if (stopped) return;
      onState(state || 'reconnecting', why);
      drop();
      clearTimeout(timer);
      timer = setTimeout(start, retry);
      retry = Math.min(retry * 2, 15000);
    };
    // Stop for good: the view falls back to snapshots.
    const end = (state, why = '') => {
      stopped = true;
      clearTimeout(timer);
      drop();
      onState(state, why);
    };
    async function start() {
      if (stopped || socket) return;
      if (!Source) return end('unsupported', 'no Media Source Extensions');
      onState('connecting');
      let current;
      try {
        current = await Dashledge.stream.open('live', {stream});
      } catch (error) {
        const message = String(error?.message || error);
        if (M.isCapError(message)) return end('capped', message);
        return restart('error', message);
      }
      if (stopped) return current.close();
      socket = current;
      lastData = Date.now();
      lastError = '';
      let opened = false;
      // Restart when go2rtc goes quiet, or when data arrives but the picture stops moving
      // (a decoder that fell behind and dropped segments it needed).
      let lastTime = -1, still = Date.now();
      watchdog = setInterval(() => {
        const now = Date.now();
        if (now - lastData > STALL) return restart('reconnecting', socket && opened ? 'no video from go2rtc for 12 s' : 'the stream never opened');
        if (!buffer || video.paused || document.hidden) { still = now; return; }
        if (video.currentTime !== lastTime) { lastTime = video.currentTime; still = now; }
        else if (now - still > STALL) restart('reconnecting', 'the picture stopped');
      }, 3000);
      current.onopen = () => { opened = true; current.send(JSON.stringify({type: 'mse', value: supported()})).catch(error => restart('error', 'send: ' + (error?.message || error))); };
      current.onerror = ({message}) => { lastError = String(message || 'stream error'); };
      current.onmessage = ({data}) => {
        if (socket !== current) return;
        lastData = Date.now();
        if (typeof data !== 'string') {
          queue.push(data);
          if (queue.length > 90) queue.splice(0, queue.length - 45); // fell behind: drop the oldest
          return pump();
        }
        let message;
        try { message = JSON.parse(data); } catch { return; }
        if (message.type === 'mse') { retry = 1000; onState('live'); attach(String(message.value || '')); }
        else if (message.type === 'error') {
          if (M.isMissingStream(message.value)) end('missing', String(message.value));
          else if (/codec/i.test(String(message.value))) end('unsupported', String(message.value));
          else restart('error', 'go2rtc: ' + String(message.value).slice(0, 120));
        }
      };
      current.onclose = ({code} = {}) => {
        if (socket !== current) return;
        socket = null;
        restart('reconnecting', (lastError ? lastError + ', ' : '') + 'closed' + (code ? ' (' + code + ')' : '') + (opened ? '' : ' before opening'));
      };
    }
    start();
    return {
      stop() {
        stopped = true;
        clearTimeout(timer);
        drop();
      },
    };
  };
})();
