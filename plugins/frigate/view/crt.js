// The CRT security monitor: draws a camera's picture onto a canvas through a shader that
// bends it like the glass of an old tube, with scanlines that follow the curve, an aperture
// grille, a little colour fringing, a darker rim and grain. With `mono` it's a black and
// white monitor with a cool phosphor; with `noSignal` it shows snow.
//
// One WebGL context per tile. A frame is drawn only when asked (the view's loop does that
// at most 30 times a second), so a paused tile costs nothing. If WebGL isn't available,
// or the picture can't be read into a texture, `create` returns null and the view keeps
// the plain <video>/<img> with CSS scanlines instead.
(() => {
  const VERTEX = `
    attribute vec2 p;
    varying vec2 uv;
    void main() { uv = p * 0.5 + 0.5; uv.y = 1.0 - uv.y; gl_Position = vec4(p, 0.0, 1.0); }`;

  const FRAGMENT = `
    precision mediump float;
    varying vec2 uv;
    uniform sampler2D tex;
    uniform vec2 size;        // canvas pixels
    uniform vec2 fit;         // texture scale for cover/contain
    uniform float time;
    uniform float mono;
    uniform float noSignal;
    uniform float hasPicture;
    uniform float lines;      // scanlines over the screen's height
    uniform float motion;     // 0 with reduced motion
    uniform float curve;

    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }

    vec2 bend(vec2 q) {
      q = q * 2.0 - 1.0;
      vec2 o = abs(q.yx) * curve;
      q += q * o * o;
      return q * 0.5 + 0.5;
    }

    vec3 picture(vec2 q) {
      vec2 t = (q - 0.5) * fit + 0.5;
      if (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) return vec3(0.0);
      float shift = 0.0012 * (1.0 - mono);
      return vec3(
        texture2D(tex, t + vec2(shift, 0.0)).r,
        texture2D(tex, t).g,
        texture2D(tex, t - vec2(shift, 0.0)).b);
    }

    void main() {
      vec2 q = bend(uv);
      if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

      // A slow hum bar rolling down the picture, as on a monitor near mains power.
      float roll = fract(time * 0.07 * motion);
      float bar = smoothstep(0.0, 0.08, abs(q.y - roll)) * 0.06 + 0.94;

      vec3 color;
      if (noSignal > 0.5 || hasPicture < 0.5) {
        float n = rand(floor(q * size / 2.0) + floor(time * 24.0 * motion + 1.0));
        float band = 0.85 + 0.15 * sin(q.y * 40.0 + time * 12.0 * motion);
        color = vec3(n * band * 0.85);
      } else {
        color = picture(q);
        // A touch of bloom: lift the darks, push the brights.
        color = pow(color, vec3(0.92)) * 1.12;
      }

      if (mono > 0.5) {
        float l = dot(color, vec3(0.299, 0.587, 0.114));
        l = clamp((l - 0.04) * 1.12, 0.0, 1.0);
        color = l * vec3(0.86, 0.95, 1.0);
      }

      // Scanlines that follow the curve, and an aperture grille.
      float scan = 0.62 + 0.38 * pow(abs(sin(q.y * lines * 3.14159)), 1.4);
      vec3 grille = mod(gl_FragCoord.x, 3.0) < 1.0 ? vec3(1.06, 0.97, 0.97) : mod(gl_FragCoord.x, 3.0) < 2.0 ? vec3(0.97, 1.06, 0.97) : vec3(0.97, 0.97, 1.06);
      color *= scan * mix(grille, vec3(1.0), mono * 0.7) * bar;

      // A darker rim where the tube curves away, and grain.
      vec2 v = q * (1.0 - q.yx);
      color *= pow(v.x * v.y * 18.0, 0.22);
      color += (rand(q * size + time) - 0.5) * 0.045;
      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }`;

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'shader');
    return shader;
  }

  window.FrigateCRT = {
    // Returns {draw(source, opts), resize(w, h), destroy()} or null.
    create(canvas) {
      const gl = canvas.getContext('webgl', {alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false});
      if (!gl) return null;
      let program;
      try {
        program = gl.createProgram();
        gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
        gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
      } catch {
        return null;
      }
      gl.useProgram(program);
      const quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const p = gl.getAttribLocation(program, 'p');
      gl.enableVertexAttribArray(p);
      gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      const u = name => gl.getUniformLocation(program, name);
      const uni = {size: u('size'), fit: u('fit'), time: u('time'), mono: u('mono'), noSignal: u('noSignal'), hasPicture: u('hasPicture'), lines: u('lines'), motion: u('motion'), curve: u('curve')};
      let lost = false, uploaded = false, shrink = null;
      // A picture much larger than the screen is drawn down to the screen's size first, so
      // a 5K main stream doesn't upload 7 million pixels a frame.
      const fitted = (source, sw, sh) => {
        const w = canvas.width, h = canvas.height;
        if (sw * sh <= w * h * 2) return source;
        shrink = shrink || document.createElement('canvas');
        const scale = Math.min(1, Math.max(w / sw, h / sh) * 1.25);
        const tw = Math.max(1, Math.round(sw * scale)), th = Math.max(1, Math.round(sh * scale));
        if (shrink.width !== tw || shrink.height !== th) { shrink.width = tw; shrink.height = th; }
        shrink.getContext('2d').drawImage(source, 0, 0, tw, th);
        return shrink;
      };
      canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; });

      return {
        resize(w, h) {
          if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
          gl.viewport(0, 0, canvas.width, canvas.height);
        },
        // source: a playing <video> or a loaded <img>, or null for snow.
        // Returns false when the picture can't be read (the view then drops the shader).
        draw(source, {mono = false, noSignal = false, cover = true, time = 0, motion = true, fresh = true} = {}) {
          if (lost) return false;
          const w = canvas.width, h = canvas.height;
          let sw = 0, sh = 0;
          if (source && !noSignal) {
            sw = source.videoWidth || source.naturalWidth || 0;
            sh = source.videoHeight || source.naturalHeight || 0;
            if (sw && sh && fresh) {
              try {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, fitted(source, sw, sh));
                uploaded = true;
              } catch {
                return false;
              }
            }
          }
          const has = !!(sw && sh && uploaded);
          // Scale the texture so the picture covers (or fits inside) the screen.
          let fx = 1, fy = 1;
          if (has) {
            const screen = w / h, picture = sw / sh;
            if (cover ? picture > screen : picture < screen) fx = screen / picture; else fy = picture / screen;
          }
          gl.uniform2f(uni.size, w, h);
          gl.uniform2f(uni.fit, fx, fy);
          gl.uniform1f(uni.time, time);
          gl.uniform1f(uni.mono, mono ? 1 : 0);
          gl.uniform1f(uni.noSignal, noSignal ? 1 : 0);
          gl.uniform1f(uni.hasPicture, has ? 1 : 0);
          // About one scanline per 3 CSS pixels, at least 120 so tiny tiles still read as a CRT.
          gl.uniform1f(uni.lines, Math.max(120, Math.round(h / (3 * (window.devicePixelRatio || 1)))));
          gl.uniform1f(uni.motion, motion ? 1 : 0);
          gl.uniform1f(uni.curve, 0.22);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          return true;
        },
        destroy() {
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        },
      };
    },
  };
})();
