/* Nami Mail landing page — monochromatic boids flocking dot matrix background.
 *
 * Renders a clean 2D Cartesian dot grid strictly in black, white, and gray tones.
 * Uses a Craig Reynolds Boids flocking simulation to create emergent, organic randomness:
 * - Resting/dark background dots have increased base brightness for crisp structure.
 * - Illuminated/bright areas expand in size and render as sharp square pixels.
 * - Flocking boids steer gracefully with separation, alignment, cohesion, and wander forces,
 *   scattering upon pointer proximity and leaving a subtle trailing energy wake.
 * - Conserves battery by pausing when scrolled off-screen or tab is hidden.
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
  var elapsed = 0;

  var SPACING = 24; // 24px grid pitch
  var BOID_COUNT = 38;

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

  // Boid flock agent
  function Boid(x, y, angle) {
    this.x = x;
    this.y = y;
    var a = angle !== undefined ? angle : Math.random() * Math.PI * 2;
    var speed = 1.8 + Math.random() * 1.4;
    this.vx = Math.cos(a) * speed;
    this.vy = Math.sin(a) * speed;
    this.maxSpeed = 3.0;
    this.maxForce = 0.10;
    this.wanderAngle = Math.random() * Math.PI * 2;
  }

  Boid.prototype.update = function (boids, w, h, ptr) {
    var sepX = 0, sepY = 0, sepCount = 0;
    var aliVx = 0, aliVy = 0, aliCount = 0;
    var cohX = 0, cohY = 0, cohCount = 0;

    var sepDist = 70;
    var neighborDist = 160;

    for (var i = 0; i < boids.length; i++) {
      var other = boids[i];
      if (other === this) continue;
      var dx = other.x - this.x;
      var dy = other.y - this.y;
      var dist = Math.hypot(dx, dy);

      if (dist > 0 && dist < sepDist) {
        var weight = (1 - dist / sepDist);
        sepX -= (dx / dist) * weight * 1.6;
        sepY -= (dy / dist) * weight * 1.6;
        sepCount++;
      }

      if (dist > 0 && dist < neighborDist) {
        aliVx += other.vx;
        aliVy += other.vy;
        aliCount++;

        cohX += other.x;
        cohY += other.y;
        cohCount++;
      }
    }

    var fx = 0, fy = 0;

    if (sepCount > 0) {
      fx += sepX * 2.0;
      fy += sepY * 2.0;
    }

    if (aliCount > 0) {
      aliVx /= aliCount;
      aliVy /= aliCount;
      fx += (aliVx - this.vx) * 0.75;
      fy += (aliVy - this.vy) * 0.75;
    }

    if (cohCount > 0) {
      cohX /= cohCount;
      cohY /= cohCount;
      var toTargetX = cohX - this.x;
      var toTargetY = cohY - this.y;
      var dTarget = Math.hypot(toTargetX, toTargetY);
      if (dTarget > 50) {
        var desiredVx = (toTargetX / dTarget) * this.maxSpeed;
        var desiredVy = (toTargetY / dTarget) * this.maxSpeed;
        fx += (desiredVx - this.vx) * 0.22;
        fy += (desiredVy - this.vy) * 0.22;
      }
    }

    // Organic wander force
    this.wanderAngle += (Math.random() - 0.5) * 0.5;
    fx += Math.cos(this.wanderAngle) * 0.55;
    fy += Math.sin(this.wanderAngle) * 0.55;

    // Boundary soft containment
    var pad = 90;
    if (this.x < pad) fx += (pad - this.x) * 0.035;
    if (this.x > w - pad) fx -= (this.x - (w - pad)) * 0.035;
    if (this.y < pad) fy += (pad - this.y) * 0.035;
    if (this.y > h - pad) fy -= (this.y - (h - pad)) * 0.035;

    // Pointer avoidance
    if (ptr && ptr.active && ptr.x > -1000) {
      var pdx = this.x - ptr.x;
      var pdy = this.y - ptr.y;
      var pdist = Math.hypot(pdx, pdy);
      if (pdist < 180 && pdist > 0) {
        var pforce = (1 - pdist / 180) * 2.8;
        fx += (pdx / pdist) * pforce;
        fy += (pdy / pdist) * pforce;
      }
    }

    // Force clamping
    var fMag = Math.hypot(fx, fy);
    if (fMag > this.maxForce) {
      fx = (fx / fMag) * this.maxForce;
      fy = (fy / fMag) * this.maxForce;
    }

    this.vx += fx;
    this.vy += fy;

    // Speed clamping
    var speed = Math.hypot(this.vx, this.vy);
    if (speed > this.maxSpeed) {
      this.vx = (this.vx / speed) * this.maxSpeed;
      this.vy = (this.vy / speed) * this.maxSpeed;
    } else if (speed < 1.0) {
      this.vx = (this.vx / (speed || 1)) * 1.0;
      this.vy = (this.vy / (speed || 1)) * 1.0;
    }

    this.x += this.vx;
    this.y += this.vy;

    // Safety edge wrap
    if (this.x < -40) this.x = w + 40;
    if (this.x > w + 40) this.x = -40;
    if (this.y < -40) this.y = h + 40;
    if (this.y > h + 40) this.y = -40;
  };

  var boids = [];

  function initBoids() {
    boids = [];
    for (var i = 0; i < BOID_COUNT; i++) {
      var x = width * (0.2 + 0.6 * Math.random());
      var y = height * (0.2 + 0.5 * Math.random());
      var angle = -0.3 + (Math.random() - 0.5) * 1.4;
      boids.push(new Boid(x, y, angle));
    }
    // Warm up simulation
    for (var f = 0; f < 100; f++) {
      for (var b = 0; b < boids.length; b++) {
        boids[b].update(boids, width, height, null);
      }
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

    if (boids.length === 0) {
      initBoids();
    }
    return true;
  }

  function getMonochromePalette() {
    var isDark = root.dataset.theme === "dark" ||
      (!root.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);

    if (isDark) {
      return {
        isDark: true,
        // Resting dark dots: increased brightness slightly (baseAlpha: 0.22)
        baseR: 170, baseG: 175, baseB: 190,
        baseAlpha: 0.22,
        // Bright squares: crisp pure white (peakAlpha: 0.90)
        peakR: 255, peakG: 255, peakB: 255,
        peakAlpha: 0.90,
      };
    }
    return {
      isDark: false,
      // Resting dark dots: increased brightness slightly (baseAlpha: 0.18)
      baseR: 105, baseG: 110, baseB: 125,
      baseAlpha: 0.18,
      // Bright squares: deep slate black (peakAlpha: 0.85)
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

    // Update boids simulation
    for (var i = 0; i < boids.length; i++) {
      boids[i].update(boids, width, height, pointer);
    }

    var startX = (width - (cols - 1) * SPACING) / 2;
    var startY = (height - (rows - 1) * SPACING) / 2;

    var boidRadius = 90;
    var boidRadiusSq = boidRadius * boidRadius;

    for (var r = 0; r < rows; r++) {
      var y = startY + r * SPACING;

      for (var c = 0; c < cols; c++) {
        var idx = r * cols + c;
        var x = startX + c * SPACING;

        // Boid flock proximity
        var instantGlow = 0;
        for (var b = 0; b < boids.length; b++) {
          var dx = x - boids[b].x;
          var dy = y - boids[b].y;
          var d2 = dx * dx + dy * dy;
          if (d2 < boidRadiusSq) {
            var w = 1 - d2 / boidRadiusSq;
            instantGlow += w * w;
          }
        }

        // Trailing wake persistence gives fluid motion
        gridEnergy[idx] = gridEnergy[idx] * 0.88 + Math.min(1.2, instantGlow * 0.55) * 0.12;
        var energy = Math.min(1.0, gridEnergy[idx]);

        // Pointer proximity glow
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
        if (totalGlow > 0.18) {
          // Bright part: expanded size (2.4px -> 5.6px) and rendered as square!
          var size = 2.4 + totalGlow * 3.2;
          var half = size / 2;
          ctx.fillRect(Math.round(x - half), Math.round(y - half), Math.round(size), Math.round(size));
        } else {
          // Dark part: subtle dot with boosted base brightness
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
    lastTimestamp = timestamp;
    if (dt > 0.08) dt = 0.08;
    elapsed += dt;

    renderFrame();
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
    lastTimestamp = 0;
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
