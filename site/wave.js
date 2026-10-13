/* Nami Mail landing page — flat breathing dot matrix background.
 *
 * Renders a clean 2D Cartesian dot grid strictly conforming to Nami Mail's
 * application design system tokens (--canvas: #0c0d10 / #f4f5f8, --text-faint: #9da1b0 / #626674,
 * and brand --success: #75b98a / #2f6d42).
 *
 * Features gentle, unified rhythmic breathing with optical dot expansion during
 * inhalation, and subtle pointer proximity illumination. Zero gradients, zero chaotic
 * colors. Conserves battery by pausing when scrolled off-screen or tab is hidden.
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

  function getThemePalette() {
    var isDark = root.dataset.theme === "dark" ||
      (!root.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);

    if (isDark) {
      return {
        isDark: true,
        baseR: 157, baseG: 161, baseB: 176, // Slate (--text-faint: #9da1b0)
        accentR: 117, accentG: 185, accentB: 138, // Nami Brand Mint (--success: #75b98a)
        baseAlpha: 0.06,
        breathAlpha: 0.28,
        pointerAlpha: 0.40,
      };
    }
    return {
      isDark: false,
      baseR: 98, baseG: 102, baseB: 116,  // Marine Slate (--text-faint: #626674)
      accentR: 47, accentG: 109, accentB: 66,   // Spruce Jade (--success: #2f6d42)
      baseAlpha: 0.05,
      breathAlpha: 0.20,
      pointerAlpha: 0.28,
    };
  }

  function renderFrame(timeSec) {
    if (width <= 0 || height <= 0) return;
    ctx.clearRect(0, 0, width, height);

    var palette = getThemePalette();

    // Smooth pointer tracking
    if (pointer.active) {
      pointer.x += (pointer.targetX - pointer.x) * 0.14;
      pointer.y += (pointer.targetY - pointer.y) * 0.14;
    } else {
      pointer.x += (-9999 - pointer.x) * 0.14;
      pointer.y += (-9999 - pointer.y) * 0.14;
    }

    var cols = Math.ceil(width / SPACING) + 1;
    var rows = Math.ceil(height / SPACING) + 1;
    var startX = (width - (cols - 1) * SPACING) / 2;
    var startY = (height - (rows - 1) * SPACING) / 2;

    var centerX = width * 0.60;
    var centerY = height * 0.35;

    for (var r = 0; r < rows; r++) {
      var y = startY + r * SPACING;

      for (var c = 0; c < cols; c++) {
        var x = startX + c * SPACING;

        // Gentle, calm traveling breathing pulse across the Cartesian grid
        var distCenter = Math.hypot(x - centerX, y - centerY);
        var breathPhase = Math.sin(timeSec * 1.15 - distCenter * 0.0022);
        var breath = Math.max(0, breathPhase) ** 1.35;

        // Pointer proximity illumination
        var pointerGlow = 0;
        if (pointer.x > -1000) {
          var pDist = Math.hypot(x - pointer.x, y - pointer.y);
          if (pDist < 180) {
            pointerGlow = Math.exp(-((pDist * pDist) / 8000));
          }
        }

        var totalHighlight = Math.min(1.0, breath * 0.85 + pointerGlow * 0.65);

        // Clean interpolation using strictly the application theme tokens
        var red = Math.round(palette.baseR * (1 - totalHighlight) + palette.accentR * totalHighlight);
        var green = Math.round(palette.baseG * (1 - totalHighlight) + palette.accentG * totalHighlight);
        var blue = Math.round(palette.baseB * (1 - totalHighlight) + palette.accentB * totalHighlight);

        var alpha = palette.baseAlpha + breath * palette.breathAlpha + pointerGlow * palette.pointerAlpha;

        // Dynamic optical expansion on breathing: resting 1.0px swells to 2.2px
        var radius = 1.0 + totalHighlight * 1.25;

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
      renderFrame(1.6);
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
      if (prefersReducedMotion) renderFrame(elapsed || 1.6);
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
      if (!isRunning) renderFrame(elapsed || 1.6);
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
        renderFrame(1.6);
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
