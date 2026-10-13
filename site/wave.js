/* Nami Mail landing page — flat breathing dot matrix background.
 *
 * Renders a crisp 2D tiled dot matrix grid with gentle, organic breathing
 * luminance and pointer proximity glow. Colors harmonize with the obsidian dark
 * and clean light design tokens. Conserves battery by pausing when hidden or off-screen.
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

  var SPACING = 24; // 24px grid pitch (aligned to 4px/8px tokens)

  var pointer = {
    x: -9999,
    y: -9999,
    targetX: -9999,
    targetY: -9999,
    active: false,
  };

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
    return true;
  }

  function getThemeColors() {
    var isDark = root.dataset.theme === "dark" ||
      (!root.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);

    if (isDark) {
      return {
        isDark: true,
        baseR: 157, baseG: 161, baseB: 176, // Slate (--text-faint)
        accent1R: 117, accent1G: 185, accent1B: 138, // Emerald mint (--success)
        accent2R: 123, accent2G: 161, accent2B: 196, // Ocean cyan (--info)
        baseAlpha: 0.07,
        breathAlpha: 0.36,
        pointerAlpha: 0.48,
      };
    }
    return {
      isDark: false,
      baseR: 98, baseG: 102, baseB: 116,  // Slate (--text-faint)
      accent1R: 47, accent1G: 109, accent1B: 66,   // Spruce jade (--success)
      accent2R: 69, accent2G: 99, accent2B: 129,   // Marine slate (--info)
      baseAlpha: 0.05,
      breathAlpha: 0.20,
      pointerAlpha: 0.28,
    };
  }

  function renderFrame(timeSec) {
    if (width <= 0 || height <= 0) return;
    ctx.clearRect(0, 0, width, height);

    var palette = getThemeColors();

    // Smooth pointer tracking
    if (pointer.active) {
      pointer.x += (pointer.targetX - pointer.x) * 0.14;
      pointer.y += (pointer.targetY - pointer.y) * 0.14;
    } else {
      pointer.x += (-9999 - pointer.x) * 0.14;
      pointer.y += (-9999 - pointer.y) * 0.14;
    }

    // Breathing epicenter gently drifts across the upper right hero area
    var focalX = width * (0.58 + 0.08 * Math.cos(timeSec * 0.25));
    var focalY = height * (0.28 + 0.06 * Math.sin(timeSec * 0.32));

    var cols = Math.ceil(width / SPACING) + 1;
    var rows = Math.ceil(height / SPACING) + 1;
    var startX = (width - (cols - 1) * SPACING) / 2;
    var startY = (height - (rows - 1) * SPACING) / 2;

    for (var r = 0; r < rows; r++) {
      var y = startY + r * SPACING;

      for (var c = 0; c < cols; c++) {
        var x = startX + c * SPACING;

        // Distance from focal breathing center
        var distFocal = Math.hypot(x - focalX, y - focalY);

        // Slow organic traveling breathing pulse
        var wavePhase = Math.sin(timeSec * 1.15 - distFocal * 0.0034);
        var breath = Math.max(0, wavePhase) ** 1.5;

        // Subtle secondary global ambient breathing
        var ambient = 0.5 + 0.5 * Math.sin(timeSec * 0.65);
        var glowFactor = breath * 0.75 + ambient * 0.25;

        // Pointer proximity illumination
        var pointerGlow = 0;
        if (pointer.x > -1000) {
          var pDist = Math.hypot(x - pointer.x, y - pointer.y);
          if (pDist < 200) {
            pointerGlow = Math.exp(-((pDist * pDist) / 10000));
          }
        }

        var totalHighlight = Math.min(1, glowFactor * 0.75 + pointerGlow);

        var red, green, blue;
        if (palette.isDark) {
          red = Math.round(palette.baseR * (1 - totalHighlight) + (palette.accent1R * (1 - totalHighlight * 0.3) + palette.accent2R * totalHighlight * 0.3) * totalHighlight);
          green = Math.round(palette.baseG * (1 - totalHighlight) + (palette.accent1G * (1 - totalHighlight * 0.2) + 210 * totalHighlight * 0.2) * totalHighlight);
          blue = Math.round(palette.baseB * (1 - totalHighlight) + (palette.accent1B * (1 - totalHighlight * 0.4) + palette.accent2R * totalHighlight * 0.4) * totalHighlight);
        } else {
          red = Math.round(palette.baseR * (1 - totalHighlight) + palette.accent1R * totalHighlight);
          green = Math.round(palette.baseG * (1 - totalHighlight) + palette.accent1G * totalHighlight);
          blue = Math.round(palette.baseB * (1 - totalHighlight) + palette.accent2B * totalHighlight);
        }

        var alpha = palette.baseAlpha +
          glowFactor * palette.breathAlpha +
          pointerGlow * palette.pointerAlpha;

        var baseRadius = palette.isDark ? 1.0 : 0.95;
        var radius = baseRadius + totalHighlight * 1.35;

        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(" + red + "," + green + "," + blue + "," + alpha.toFixed(3) + ")";
        ctx.fill();
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

    renderFrame(elapsed);
    animId = requestAnimationFrame(loop);
  }

  function start() {
    if (isRunning) return;
    if (prefersReducedMotion) {
      renderFrame(2.4);
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
      if (prefersReducedMotion) renderFrame(elapsed || 2.4);
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
      if (!isRunning) renderFrame(elapsed || 2.4);
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
        renderFrame(2.4);
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
