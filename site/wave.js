/* Nami Mail landing page — emergent biological ALife dot matrix background.
 *
 * Simulates an autonomous living organism colony (bioluminescent plankton / amoeboid ALife)
 * exhibiting organic breathing, pseudopodia motility, mycelium signaling bridges, and mitosis
 * across a Cartesian dot matrix, strictly in monochrome (black, white, gray):
 * - Biological emergence: organisms breathe with rhythmic membrane pulsation, drift with
 *   spontaneous organic crawling, and form living protoplasmic/mycelium tendril bridges
 *   when passing near one another.
 * - Mitosis & Life cycle: mature organisms undergo cell division into daughter cells, with
 *   graceful aging and natural dissolution, maintaining perpetual ecological vitality.
 * - Base/dark dots: slightly boosted brightness (baseAlpha 0.22 / 0.18) so matrix structure is clear.
 * - Illuminated/living regions: dots expand up to 5.6px and render as crisp square pixels.
 * - Pointer interaction: cursor acts as an environmental stimulus; organisms organically avoid
 *   and weave around the touchpoint.
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
  var lastTimestamp = 0;

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

  // Living Bioluminescent Organism (Plankton / Amoeba Entity)
  function Organism(x, y, radius, gen) {
    this.x = x !== undefined ? x : (width || 1200) * (0.15 + 0.7 * Math.random());
    this.y = y !== undefined ? y : (height || 800) * (0.15 + 0.7 * Math.random());
    this.radius = radius || (28 + Math.random() * 20);
    this.gen = gen || 0;

    // Motility velocity — slow, tranquil organic drift
    var angle = Math.random() * Math.PI * 2;
    var speed = 0.20 + Math.random() * 0.22;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;

    // Internal biological clock & slow meditative breathing respiration
    this.pulsePhase = Math.random() * Math.PI * 2;
    this.pulseSpeed = 0.014 + Math.random() * 0.008;
    this.wanderAngle = Math.random() * Math.PI * 2;

    // Pseudopodia morphology (living amoebic lobes)
    this.lobes = 3 + Math.floor(Math.random() * 3);
    this.lobePhase = Math.random() * Math.PI * 2;

    this.age = 0;
    this.lifespan = 1200 + Math.random() * 800;
    this.mitosisAge = 420 + Math.random() * 260;
    this.hasDivided = false;
  }

  Organism.prototype.update = function (colony, ptr) {
    this.age++;
    this.pulsePhase += this.pulseSpeed;
    this.lobePhase += 0.007;

    // Organic wandering crawl — gentle curved heading
    this.wanderAngle += (Math.random() - 0.5) * 0.12;
    var fx = Math.cos(this.wanderAngle) * 0.08;
    var fy = Math.sin(this.wanderAngle) * 0.08;

    // Soft ecological repulsion to avoid crowding
    var repX = 0, repY = 0;
    for (var i = 0; i < colony.length; i++) {
      var other = colony[i];
      if (other === this) continue;
      var dx = this.x - other.x;
      var dy = this.y - other.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      var minDist = (this.radius + other.radius) * 1.25;
      if (d < minDist && d > 0) {
        var weight = (1 - d / minDist) * 0.25;
        repX += (dx / d) * weight;
        repY += (dy / d) * weight;
      }
    }

    // Pointer environmental stimulus (gentle living avoidance)
    var ptrX = 0, ptrY = 0;
    if (ptr && ptr.active && ptr.x > -1000) {
      var pdx = this.x - ptr.x;
      var pdy = this.y - ptr.y;
      var pd = Math.sqrt(pdx * pdx + pdy * pdy);
      if (pd < 180 && pd > 0) {
        var pf = (1 - pd / 180) * 0.65;
        ptrX = (pdx / pd) * pf;
        ptrY = (pdy / pd) * pf;
      }
    }

    // Gentle boundary soft turning
    var pad = 80;
    var boundX = 0, boundY = 0;
    if (this.x < pad) boundX = (pad - this.x) * 0.012;
    if (this.x > width - pad) boundX = -(this.x - (width - pad)) * 0.012;
    if (this.y < pad) boundY = (pad - this.y) * 0.012;
    if (this.y > height - pad) boundY = -(this.y - (height - pad)) * 0.012;

    this.vx += (fx + repX + ptrX + boundX) * 0.08;
    this.vy += (fy + repY + ptrY + boundY) * 0.08;

    // Smooth speed regulation — tranquil slow speed ceiling
    var curSpeed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    var maxSpeed = 0.62;
    if (curSpeed > maxSpeed) {
      this.vx = (this.vx / curSpeed) * maxSpeed;
      this.vy = (this.vy / curSpeed) * maxSpeed;
    }

    this.x += this.vx;
    this.y += this.vy;

    // Mitosis: cell division when mature and population permits
    if (!this.hasDivided && this.age >= this.mitosisAge && colony.length < 13) {
      this.hasDivided = true;
      var splitAngle = Math.random() * Math.PI * 2;
      var daughter = new Organism(
        this.x + Math.cos(splitAngle) * this.radius * 0.7,
        this.y + Math.sin(splitAngle) * this.radius * 0.7,
        this.radius * 0.88,
        this.gen + 1
      );
      daughter.vx = Math.cos(splitAngle) * 0.35;
      daughter.vy = Math.sin(splitAngle) * 0.35;
      this.vx = -Math.cos(splitAngle) * 0.35;
      this.vy = -Math.sin(splitAngle) * 0.35;
      colony.push(daughter);
    }
  };

  Organism.prototype.getIntensity = function (gx, gy) {
    var dx = gx - this.x;
    var dy = gy - this.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    var angle = Math.atan2(dy, dx);

    // Living breathing pulsation & pseudopodia lobe wave
    var breathing = Math.sin(this.pulsePhase) * 5.0;
    var pseudopod = Math.sin(angle * this.lobes + this.lobePhase) * 9.0;
    var effRadius = this.radius + breathing + pseudopod;

    if (d > effRadius + 28) return 0;

    var val = 0;
    if (d < effRadius - 8) {
      val = 0.95 + 0.05 * Math.sin(this.pulsePhase * 2);
    } else {
      val = Math.max(0, 1 - (d - (effRadius - 8)) / 36);
    }

    // Graceful life cycle fade
    var lifeFade = 1.0;
    if (this.age < 60) {
      lifeFade = this.age / 60;
    } else if (this.age > this.lifespan - 120) {
      lifeFade = Math.max(0, (this.lifespan - this.age) / 120);
    }

    return val * lifeFade;
  };

  var colony = [];
  function initColony() {
    colony = [];
    var initialCount = width < 768 ? 6 : 9;
    for (var i = 0; i < initialCount; i++) {
      colony.push(new Organism(
        (width || 1200) * (0.15 + 0.7 * Math.random()),
        (height || 800) * (0.15 + 0.7 * Math.random()),
        26 + Math.random() * 22,
        0
      ));
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

    if (colony.length === 0) {
      initColony();
      // Warm up colony
      for (var s = 0; s < 45; s++) {
        for (var i = 0; i < colony.length; i++) {
          colony[i].update(colony, null);
        }
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
        // Living bright squares: pure luminous white
        peakR: 255, peakG: 255, peakB: 255,
        peakAlpha: 0.90,
      };
    }
    return {
      isDark: false,
      // Base dark dots: slightly boosted brightness
      baseR: 105, baseG: 110, baseB: 125,
      baseAlpha: 0.18,
      // Living bright squares: deep slate black
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
      pointer.x += (pointer.targetX - pointer.x) * 0.18;
      pointer.y += (pointer.targetY - pointer.y) * 0.18;
    } else {
      pointer.x += (-9999 - pointer.x) * 0.18;
      pointer.y += (-9999 - pointer.y) * 0.18;
    }

    // Step colony life cycle
    for (var i = colony.length - 1; i >= 0; i--) {
      var org = colony[i];
      org.update(colony, pointer);
      if (org.age > org.lifespan) {
        colony.splice(i, 1);
      }
    }

    // Ecological homeostasis: replenish colony if too sparse
    var minCount = width < 768 ? 4 : 6;
    if (colony.length < minCount) {
      colony.push(new Organism(
        width * (0.1 + 0.8 * Math.random()),
        height * (0.1 + 0.8 * Math.random()),
        26 + Math.random() * 20,
        0
      ));
    }

    var startX = (width - (cols - 1) * SPACING) / 2;
    var startY = (height - (rows - 1) * SPACING) / 2;

    // 1. Decay previous grid energy
    var totalCells = cols * rows;
    for (var i = 0; i < totalCells; i++) {
      gridEnergy[i] *= 0.82;
    }

    // 2. Splat living organisms into local grid neighborhood in O(N)
    for (var oIdx = 0; oIdx < colony.length; oIdx++) {
      var o = colony[oIdx];
      var gc = Math.round((o.x - startX) / SPACING);
      var gr = Math.round((o.y - startY) / SPACING);
      var cellRadius = Math.ceil((o.radius + 28) / SPACING);

      for (var dr = -cellRadius; dr <= cellRadius; dr++) {
        var r = gr + dr;
        if (r < 0 || r >= rows) continue;
        var cy = startY + r * SPACING;

        for (var dc = -cellRadius; dc <= cellRadius; dc++) {
          var c = gc + dc;
          if (c < 0 || c >= cols) continue;
          var cx = startX + c * SPACING;

          var val = o.getIntensity(cx, cy);
          if (val > 0) {
            var idx = r * cols + c;
            if (val > gridEnergy[idx]) {
              gridEnergy[idx] = val;
            }
          }
        }
      }
    }

    // 3. Mycelium protoplasmic tendrils connecting nearby organisms (living emergent network)
    for (var i = 0; i < colony.length; i++) {
      for (var j = i + 1; j < colony.length; j++) {
        var o1 = colony[i];
        var o2 = colony[j];
        var mdx = o2.x - o1.x;
        var mdy = o2.y - o1.y;
        var dist = Math.sqrt(mdx * mdx + mdy * mdy);

        var maxConnectDist = 220;
        if (dist < maxConnectDist && dist > 20) {
          var connectFactor = 1 - dist / maxConnectDist;
          var bridgeStrength = connectFactor * connectFactor * 0.72;

          var steps = Math.ceil(dist / SPACING);
          for (var s = 1; s < steps; s++) {
            var frac = s / steps;
            var bx = o1.x + mdx * frac;
            var by = o1.y + mdy * frac;

            var bgc = Math.round((bx - startX) / SPACING);
            var bgr = Math.round((by - startY) / SPACING);

            if (bgc >= 0 && bgc < cols && bgr >= 0 && bgr < rows) {
              var bidx = bgr * cols + bgc;
              if (bridgeStrength > gridEnergy[bidx]) {
                gridEnergy[bidx] = bridgeStrength;
              }
            }
          }
        }
      }
    }

    // 4. Render dot matrix
    for (var r = 0; r < rows; r++) {
      var y = startY + r * SPACING;

      for (var c = 0; c < cols; c++) {
        var idx = r * cols + c;
        var x = startX + c * SPACING;

        var energy = gridEnergy[idx];
        if (energy > 1.0) energy = 1.0;

        // Pointer proximity gentle illumination
        var pointerGlow = 0;
        if (pointer.active && pointer.x > -1000) {
          var pdx = x - pointer.x;
          var pdy = y - pointer.y;
          var pd2 = pdx * pdx + pdy * pdy;
          if (pd2 < 25600) { // 160px
            pointerGlow = Math.exp(-pd2 / 9000);
          }
        }

        var totalGlow = energy + pointerGlow * 0.65;
        if (totalGlow > 1.0) totalGlow = 1.0;

        var red = Math.round(palette.baseR * (1 - totalGlow) + palette.peakR * totalGlow);
        var green = Math.round(palette.baseG * (1 - totalGlow) + palette.peakG * totalGlow);
        var blue = Math.round(palette.baseB * (1 - totalGlow) + palette.peakB * totalGlow);
        var alpha = palette.baseAlpha + totalGlow * (palette.peakAlpha - palette.baseAlpha);

        ctx.fillStyle = "rgba(" + red + "," + green + "," + blue + "," + alpha.toFixed(3) + ")";

        // "增加暗部亮度一点点，亮部点阵则扩大并且为方形"
        if (totalGlow > 0.18) {
          // Living active organism / protoplasm: expanded square pixel (2.4px -> 5.6px)
          var size = 2.4 + totalGlow * 3.2;
          var half = size / 2;
          ctx.fillRect(Math.round(x - half), Math.round(y - half), Math.round(size), Math.round(size));
        } else {
          // Resting background dot
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
