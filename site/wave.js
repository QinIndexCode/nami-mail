/* Nami Mail landing page — emergent vortex fluid flow dot matrix background.
 *
 * Simulates a 2D Hamiltonian vortex fluid field (Kirchhoff vortex dynamics) advecting
 * continuous stream tracers across a Cartesian dot matrix, strictly in monochrome (black, white, gray):
 * - Emergent chaotic fluid flow: vortices mutually induce velocities, producing natural
 *   meandering river streams, turbulent eddies, and organic branching currents.
 * - Base/dark dots: slightly boosted brightness (baseAlpha 0.22 / 0.18) so matrix structure is clear.
 * - Illuminated/bright streams: dots expand up to 5.6px and render as crisp square pixels.
 * - Pointer interaction: cursor injects local vorticity and velocity, dispersing fluid streams.
 * - Conserves battery: pauses when off-screen or tab is hidden, respects prefers-reduced-motion.
 */
(function () {
  "use strict";

  var canvas = document.getElementById("hero-wave-canvas");
  if (!canvas) return;

  var hero = canvas.closest(".hero") || canvas.parentElement;
  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var root = document.documentElement;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var width = 0;
  var height = 0;

  var animId = null;
  var isRunning = false;
  var isIntersecting = true;
  var isVisible = !document.hidden;
  var prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var SPACING = 24; // 24px grid pitch
  var cols = 0;
  var rows = 0;
  var gridEnergy = null;

  var pointer = {
    x: -9999,
    y: -9999,
    targetX: -9999,
    targetY: -9999,
    active: false,
  };

  // Hamiltonian fluid vortices
  var VORTEX_COUNT = 8;
  var vortices = [];

  function initVortices() {
    vortices = [];
    for (var i = 0; i < VORTEX_COUNT; i++) {
      vortices.push({
        x: width * (0.15 + 0.7 * Math.random()),
        y: height * (0.15 + 0.7 * Math.random()),
        gamma: (Math.random() > 0.5 ? 1 : -1) * (1400 + Math.random() * 1600),
      });
    }
  }

  // Stream tracers (fluid advection particles)
  var TRACER_COUNT = 160;
  var tracers = [];

  function Tracer() {
    this.reset();
  }

  Tracer.prototype.reset = function () {
    this.x = Math.random() * (width || 1200);
    this.y = Math.random() * (height || 800);
    this.vx = 0;
    this.vy = 0;
    this.life = 0;
    this.maxLife = 140 + Math.random() * 160;
  };

  Tracer.prototype.update = function (vorts, ptr) {
    // Biot-Savart induced velocity from all vortices
    var u = 0, v = 0;
    for (var i = 0; i < vorts.length; i++) {
      var vt = vorts[i];
      var dx = this.x - vt.x;
      var dy = this.y - vt.y;
      var r2 = dx * dx + dy * dy + 3600; // Soften core singularity
      var factor = vt.gamma / (r2 * 6.28);
      u += -dy * factor;
      v += dx * factor;
    }

    // Ambient gentle meandering flow (drives continuous screen-wide current)
    u += 0.85;
    v += Math.sin(this.x * 0.003) * 0.45;

    // Pointer disturbance
    if (ptr && ptr.active && ptr.x > -1000) {
      var pdx = this.x - ptr.x;
      var pdy = this.y - ptr.y;
      var pr2 = pdx * pdx + pdy * pdy;
      if (pr2 < 32400) { // 180px
        var pr = Math.sqrt(pr2) || 1;
        var pf = (1 - pr / 180) * 4.0;
        u += (pdx / pr) * pf - (pdy / pr) * pf * 0.75;
        v += (pdy / pr) * pf + (pdx / pr) * pf * 0.75;
      }
    }

    // Velocity integration with smooth momentum
    this.vx += (u - this.vx) * 0.12;
    this.vy += (v - this.vy) * 0.12;

    this.x += this.vx;
    this.y += this.vy;

    this.life++;
    if (this.life > this.maxLife || this.x < -40 || this.x > width + 40 || this.y < -40 || this.y > height + 40) {
      this.reset();
    }
  };

  function initTracers() {
    tracers = [];
    for (var i = 0; i < TRACER_COUNT; i++) {
      tracers.push(new Tracer());
    }
  }

  function updateVortices() {
    for (var i = 0; i < vortices.length; i++) {
      var v1 = vortices[i];
      var vx = 0, vy = 0;
      for (var j = 0; j < vortices.length; j++) {
        if (i === j) continue;
        var v2 = vortices[j];
        var dx = v1.x - v2.x;
        var dy = v1.y - v2.y;
        var r2 = dx * dx + dy * dy + 8000;
        var factor = v2.gamma / (r2 * 6.28);
        vx += -dy * factor;
        vy += dx * factor;
      }
      v1.x += vx * 0.35;
      v1.y += vy * 0.35;

      // Soft boundary turn
      var pad = 100;
      if (v1.x < pad) v1.x += (pad - v1.x) * 0.02;
      if (v1.x > width - pad) v1.x -= (v1.x - (width - pad)) * 0.02;
      if (v1.y < pad) v1.y += (pad - v1.y) * 0.02;
      if (v1.y > height - pad) v1.y -= (v1.y - (height - pad)) * 0.02;
    }
  }

  function updateSize() {
    var rect = canvas.getBoundingClientRect();
    width = Math.floor(rect.width);
    height = Math.floor(rect.height);
    if (width <= 0 || height <= 0) return false;

    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    cols = Math.ceil(width / SPACING) + 2;
    rows = Math.ceil(height / SPACING) + 2;
    gridEnergy = new Float32Array(cols * rows);

    if (vortices.length === 0) initVortices();
    if (tracers.length === 0) initTracers();

    // Warm up simulation
    for (var s = 0; s < 60; s++) {
      updateVortices();
      for (var t = 0; t < tracers.length; t++) {
        tracers[t].update(vortices, null);
      }
    }
    return true;
  }

  function getMonochromePalette() {
    var isDark = root.dataset.theme === "dark" ||
      (!root.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);

    if (isDark) {
      return {
        isDark: true,
        // Base dark dots: slightly boosted brightness
        baseR: 170, baseG: 175, baseB: 190,
        baseAlpha: 0.22,
        // Bright squares: crisp pure white
        peakR: 255, peakG: 255, peakB: 255,
        peakAlpha: 0.90,
      };
    }
    return {
      isDark: false,
      // Base dark dots: slightly boosted brightness
      baseR: 105, baseG: 110, baseB: 125,
      baseAlpha: 0.18,
      // Bright squares: deep slate black
      peakR: 18, peakG: 19, peakB: 24,
      peakAlpha: 0.85,
    };
  }

  function renderFrame() {
    if (width <= 0 || height <= 0 || !gridEnergy) return;
    ctx.clearRect(0, 0, width, height);

    var palette = getMonochromePalette();

    // Smooth pointer tracking
    if (pointer.active) {
      pointer.x += (pointer.targetX - pointer.x) * 0.16;
      pointer.y += (pointer.targetY - pointer.y) * 0.16;
    } else {
      pointer.x += (-9999 - pointer.x) * 0.16;
      pointer.y += (-9999 - pointer.y) * 0.16;
    }

    // Step physical vortices and advect fluid tracers
    updateVortices();
    for (var i = 0; i < tracers.length; i++) {
      tracers[i].update(vortices, pointer);
    }

    var startX = (width - (cols - 1) * SPACING) / 2;
    var startY = (height - (rows - 1) * SPACING) / 2;

    // 1. Decay previous grid energy
    var totalCells = cols * rows;
    for (var i = 0; i < totalCells; i++) {
      gridEnergy[i] *= 0.88;
    }

    // 2. Splat tracer energy into local neighborhood in O(N)
    for (var t = 0; t < tracers.length; t++) {
      var tr = tracers[t];
      var gc = Math.round((tr.x - startX) / SPACING);
      var gr = Math.round((tr.y - startY) / SPACING);

      for (var dr = -2; dr <= 2; dr++) {
        var r = gr + dr;
        if (r < 0 || r >= rows) continue;
        for (var dc = -2; dc <= 2; dc++) {
          var c = gc + dc;
          if (c < 0 || c >= cols) continue;
          var d2 = dc * dc + dr * dr;
          if (d2 <= 5) {
            var w = 1 - d2 / 6;
            gridEnergy[r * cols + c] += w * 0.28;
          }
        }
      }
    }

    // 3. Render grid points
    for (var r = 0; r < rows; r++) {
      var y = startY + r * SPACING;

      for (var c = 0; c < cols; c++) {
        var idx = r * cols + c;
        var x = startX + c * SPACING;

        var energy = Math.min(1.0, gridEnergy[idx]);

        // Pointer proximity illumination
        var pointerGlow = 0;
        if (pointer.active && pointer.x > -1000) {
          var pdx = x - pointer.x;
          var pdy = y - pointer.y;
          var pd2 = pdx * pdx + pdy * pdy;
          if (pd2 < 25600) { // 160px
            pointerGlow = Math.exp(-pd2 / 9000);
          }
        }

        var totalGlow = Math.min(1.0, energy * 0.95 + pointerGlow * 0.65);

        // Strict monochrome interpolation
        var red = Math.round(palette.baseR * (1 - totalGlow) + palette.peakR * totalGlow);
        var green = Math.round(palette.baseG * (1 - totalGlow) + palette.peakG * totalGlow);
        var blue = Math.round(palette.baseB * (1 - totalGlow) + palette.peakB * totalGlow);
        var alpha = palette.baseAlpha + totalGlow * (palette.peakAlpha - palette.baseAlpha);

        ctx.fillStyle = "rgba(" + red + "," + green + "," + blue + "," + alpha.toFixed(3) + ")";

        // "增加暗部亮度一点点，亮部点阵则扩大并且为方形"
        if (totalGlow > 0.16) {
          // Bright part: expanded size (2.4px -> 5.6px) and rendered as square!
          var size = 2.4 + totalGlow * 3.4;
          var half = size / 2;
          ctx.fillRect(Math.round(x - half), Math.round(y - half), Math.round(size), Math.round(size));
        } else {
          // Dark part: subtle round dot with boosted base brightness
          var radius = 1.2;
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  function loop(timestamp) {
    if (!isRunning) return;
    if (!lastTimestamp) lastTimestamp = timestamp;
    var dt = (timestamp - lastTimestamp) / 1000;
    if (dt >= 0.015) {
      lastTimestamp = timestamp;
      renderFrame();
    }
    animId = requestAnimationFrame(loop);
  }

  function start() {
    if (isRunning) return;
    if (prefersReducedMotion) {
      renderFrame();
      return;
    }
    if (!isIntersecting || !isVisible) return;
    isRunning = true;
    animId = requestAnimationFrame(loop);
  }

  function stop() {
    isRunning = false;
    if (animId) {
      cancelAnimationFrame(animId);
      animId = null;
    }
  }

  function onPointerMove(e) {
    var rect = canvas.getBoundingClientRect();
    pointer.targetX = e.clientX - rect.left;
    pointer.targetY = e.clientY - rect.top;
    pointer.active = true;
  }

  function onPointerLeave() {
    pointer.active = false;
  }

  // Setup event listeners
  window.addEventListener("resize", function () {
    if (updateSize()) {
      if (prefersReducedMotion) renderFrame();
    }
  }, { passive: true });

  if (hero) {
    hero.addEventListener("pointermove", onPointerMove, { passive: true });
    hero.addEventListener("pointerleave", onPointerLeave, { passive: true });
  }

  document.addEventListener("visibilitychange", function () {
    isVisible = !document.hidden;
    if (isVisible) start();
    else stop();
  });

  var observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].target === hero) {
        isIntersecting = entries[i].isIntersecting;
        if (isIntersecting) start();
        else stop();
      }
    }
  }, { threshold: 0.05 }) : null;

  if (observer && hero) {
    observer.observe(hero);
  }

  // Observe theme changes on documentElement
  if (typeof MutationObserver === "function") {
    var themeObserver = new MutationObserver(function () {
      if (!isRunning) renderFrame();
    });
    themeObserver.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  }

  // Listen for reduced motion preference changes
  var motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (motionQuery.addEventListener) {
    motionQuery.addEventListener("change", function (e) {
      prefersReducedMotion = e.matches;
      if (prefersReducedMotion) {
        stop();
        renderFrame();
      } else {
        start();
      }
    });
  }

  // Initialize
  if (updateSize()) {
    start();
  }
})();
