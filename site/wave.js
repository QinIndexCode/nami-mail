/* Nami Mail landing page — 1:1 Trae.ai Digital Archipelago Matrix (Monochrome Edition)
 *
 * Visual & Algorithmic Architecture:
 * - Strict 6px Cartesian grid with fixed 4x4px razor-sharp square cells (2px gap).
 * - ~78% pure empty void; ~22% organic archipelago clusters & diagonal streaks.
 * - Domain-warped 3D gradient noise generates slowly drifting, morphing island contours.
 * - Stochastic spatial-hash dithering:
 *     1) Outer Fringe: sparse, fragmented stray pixels rendered in brighter neutral gray.
 *     2) Inner Core: 92%+ dense cellular matrix rendered in deeper, recessed monochrome tones
 *        with subtle mosaic variation.
 * - Batched bucket rendering (12 alpha buckets) for <1ms frame time at 60fps.
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
  var simTime = Math.random() * 200;

  // 1:1 Trae.ai grid geometry: 6px pitch, 4px crisp square, 2px dark gutter
  var SPACING = 6;
  var CELL_SIZE = 4;
  var cols = 0;
  var rows = 0;

  // Per-cell deterministic hashes for stochastic dithering & mosaic texture
  var cellHashExist = null;
  var cellHashTone = null;
  var cellFlickerPhase = null;

  // Coarse noise evaluation grid (bilinearly interpolated per cell for ultra-fast 60fps)
  var COARSE_STEP = 3; // 1 coarse sample per 3x3 cells (18px)
  var cCols = 0;
  var cRows = 0;
  var coarseField = null;

  // 12 discrete monochrome alpha buckets for batched single-pass canvas rendering
  var NUM_BUCKETS = 12;
  var bucketStyles = new Array(NUM_BUCKETS);
  var bucketCoords = new Array(NUM_BUCKETS);
  for (var b = 0; b < NUM_BUCKETS; b++) {
    bucketCoords[b] = [];
  }
  var cachedThemeKey = "";

  var pointer = {
    x: -9999,
    y: -9999,
    targetX: -9999,
    targetY: -9999,
    active: false,
  };

  // --- Fast 3D Gradient / Value-Lattice Noise ---
  var perm = new Uint8Array(512);
  (function initNoise() {
    var p = new Uint8Array(256);
    for (var i = 0; i < 256; i++) p[i] = i;
    var seed = 1337;
    for (var i = 255; i > 0; i--) {
      seed = (seed * 16807) % 2147483647;
      var j = seed % (i + 1);
      var tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }
    for (var i = 0; i < 512; i++) perm[i] = p[i & 255];
  })();

  function grad3(hash, x, y, z) {
    var h = hash & 15;
    var u = h < 8 ? x : y;
    var v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }

  function noise3D(x, y, z) {
    var X = Math.floor(x) & 255;
    var Y = Math.floor(y) & 255;
    var Z = Math.floor(z) & 255;

    x -= Math.floor(x);
    y -= Math.floor(y);
    z -= Math.floor(z);

    var u = x * x * x * (x * (x * 6 - 15) + 10);
    var v = y * y * y * (y * (y * 6 - 15) + 10);
    var w = z * z * z * (z * (z * 6 - 15) + 10);

    var A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z;
    var B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;

    var res =
      (1 - w) *
        ((1 - v) *
          ((1 - u) * grad3(perm[AA], x, y, z) + u * grad3(perm[BA], x - 1, y, z)) +
          v *
            ((1 - u) * grad3(perm[AB], x, y - 1, z) +
              u * grad3(perm[BB], x - 1, y - 1, z))) +
      w *
        ((1 - v) *
          ((1 - u) * grad3(perm[AA + 1], x, y, z - 1) +
            u * grad3(perm[BA + 1], x - 1, y, z - 1)) +
          v *
            ((1 - u) * grad3(perm[AB + 1], x, y - 1, z - 1) +
              u * grad3(perm[BB + 1], x - 1, y - 1, z - 1)));

    return res; // range approx [-1, 1]
  }

  function buildPaletteBuckets() {
    var isDark =
      root.dataset.theme === "dark" ||
      (!root.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);

    var themeKey = isDark ? "dark" : "light";
    if (themeKey === cachedThemeKey) return;
    cachedThemeKey = themeKey;

    for (var i = 0; i < NUM_BUCKETS; i++) {
      var t = (i + 1) / NUM_BUCKETS; // (0, 1]
      if (isDark) {
        // Dark mode monochrome: deep charcoal-gray core up to crisp silver-gray fringe
        var alpha = 0.12 + t * 0.56; // 0.12 -> 0.68
        var lum = Math.round(115 + t * 105); // 115 -> 220
        bucketStyles[i] = "rgba(" + lum + "," + (lum + 3) + "," + (lum + 6) + "," + alpha.toFixed(3) + ")";
      } else {
        // Light mode monochrome: subtle slate-gray core up to crisp charcoal fringe
        var alphaL = 0.10 + t * 0.52; // 0.10 -> 0.62
        var lumL = Math.round(130 - t * 105); // 130 -> 25
        bucketStyles[i] = "rgba(" + lumL + "," + (lumL + 2) + "," + (lumL + 5) + "," + alphaL.toFixed(3) + ")";
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

    cols = Math.ceil(width / SPACING) + 1;
    rows = Math.ceil(height / SPACING) + 1;
    var total = cols * rows;

    cellHashExist = new Float32Array(total);
    cellHashTone = new Float32Array(total);
    cellFlickerPhase = new Float32Array(total);

    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var idx = r * cols + c;
        // High-frequency uncorrelated spatial hashes for authentic pixel perforation
        var h1 = (c * 374761393 + r * 668265263) ^ 0x5bf03635;
        h1 = ((h1 ^ (h1 >> 13)) * 1274126177) >>> 0;
        cellHashExist[idx] = h1 / 4294967296;

        var h2 = (c * 1103515245 + r * 12345 + 0x9e3779b9) ^ (h1 >> 7);
        h2 = ((h2 ^ (h2 >> 15)) * 2246822519) >>> 0;
        cellHashTone[idx] = h2 / 4294967296;

        var h3 = (c * 2654435761 ^ r * 2246822519) >>> 0;
        cellFlickerPhase[idx] = (h3 / 4294967296) * Math.PI * 2;
      }
    }

    cCols = Math.ceil(cols / COARSE_STEP) + 2;
    cRows = Math.ceil(rows / COARSE_STEP) + 2;
    coarseField = new Float32Array(cCols * cRows);

    cachedThemeKey = "";
    buildPaletteBuckets();
    return true;
  }

  function computeCoarseNoiseField() {
    var t = simTime;
    // Spatial frequencies tuned to match Trae.ai island size & diagonal streaks
    var baseScaleX = 0.017;
    var baseScaleY = 0.021;

    for (var cr = 0; cr < cRows; cr++) {
      var gcR = cr * COARSE_STEP;
      var ny = gcR * baseScaleY;
      var rowOff = cr * cCols;

      for (var cc = 0; cc < cCols; cc++) {
        var gcC = cc * COARSE_STEP;
        var nx = gcC * baseScaleX;

        // Domain warping creates organic peninsulas & diagonal archipelago chains
        var warpX = nx + 0.55 * noise3D(nx * 0.8, ny * 0.8, t * 0.14);
        var warpY = ny + 0.55 * noise3D(nx * 0.8 + 41.2, ny * 0.8 + 17.9, t * 0.14);

        // Primary island continents + secondary breakup octave
        var n1 = noise3D(warpX, warpY, t * 0.20);
        var n2 = noise3D(warpX * 2.15 + 19.3, warpY * 2.15 - 31.7, -t * 0.28);
        var n3 = noise3D(nx * 3.8 - t * 0.15, ny * 3.8 + t * 0.12, t * 0.35);

        // Normalize to roughly [0, 1]
        var raw = 0.5 + 0.38 * n1 + 0.18 * n2 + 0.08 * n3;

        //Pointer interaction: parts the core directly under cursor & excites a dithered ring
        if (pointer.x > -1000) {
          var px = gcC * SPACING;
          var py = gcR * SPACING;
          var dx = px - pointer.x;
          var dy = py - pointer.y;
          var d2 = dx * dx + dy * dy;
          if (d2 < 28900) { // 170px radius
            var d = Math.sqrt(d2);
            // Hollow ring excitation around cursor (spawns scattered fringe squares)
            var ring = Math.exp(-Math.pow((d - 75) / 42, 2)) * 0.22;
            var corePush = d < 55 ? -(1 - d / 55) * 0.18 : 0;
            raw += ring + corePush;
          }
        }

        coarseField[rowOff + cc] = raw;
      }
    }
  }

  function renderFrame() {
    if (width <= 0 || height <= 0 || !coarseField) return;
    ctx.clearRect(0, 0, width, height);
    buildPaletteBuckets();

    simTime += 0.014;

    if (pointer.active) {
      if (pointer.x < -1000) {
        pointer.x = pointer.targetX;
        pointer.y = pointer.targetY;
      } else {
        pointer.x += (pointer.targetX - pointer.x) * 0.18;
        pointer.y += (pointer.targetY - pointer.y) * 0.18;
      }
    } else {
      pointer.x += (-9999 - pointer.x) * 0.1;
      pointer.y += (-9999 - pointer.y) * 0.1;
    }

    // 1. Evaluate 3D domain-warped noise on coarse grid
    computeCoarseNoiseField();

    // Clear bucket coordinate lists
    for (var b = 0; b < NUM_BUCKETS; b++) {
      bucketCoords[b].length = 0;
    }

    // Sea-level threshold: ~78% of screen stays pure empty black void
    var SEA_LEVEL = 0.535;
    var invRange = 1.0 / (0.86 - SEA_LEVEL);
    var invCoarse = 1.0 / COARSE_STEP;

    // 2. Classify each grid cell via bilinear interpolation + stochastic dithering
    for (var r = 0; r < rows; r++) {
      var cr = (r * invCoarse) | 0;
      var fy = r * invCoarse - cr;
      var cRow0 = cr * cCols;
      var cRow1 = (cr + 1) * cCols;
      var cellRowOff = r * cols;
      var y = r * SPACING;

      for (var c = 0; c < cols; c++) {
        var cc = (c * invCoarse) | 0;
        var fx = c * invCoarse - cc;

        // Bilinearly interpolate noise value
        var v00 = coarseField[cRow0 + cc];
        var v10 = coarseField[cRow0 + cc + 1];
        var v01 = coarseField[cRow1 + cc];
        var v11 = coarseField[cRow1 + cc + 1];

        var top = v00 + (v10 - v00) * fx;
        var bot = v01 + (v11 - v01) * fx;
        var fieldVal = top + (bot - top) * fy;

        if (fieldVal <= SEA_LEVEL) continue;

        // Normalized island depth: 0.0 (outermost coastline) -> 1.0+ (deep island core)
        var depth = (fieldVal - SEA_LEVEL) * invRange;
        if (depth > 1.2) depth = 1.2;

        var idx = cellRowOff + c;
        var hExist = cellHashExist[idx];
        var hTone = cellHashTone[idx];

        // Subtle cellular breathing so edge pixels gently materialize/dematerialize
        var pulse = Math.sin(simTime * 1.9 + cellFlickerPhase[idx]) * 0.07;
        var effHash = hExist + pulse;

        // Stochastic perforation curve:
        // - Near coastline (depth < 0.25): very sparse stray squares
        // - Mid fringe (0.25..0.55): perforated dithered clusters
        // - Deep core (> 0.55): 93% dense filled matrix with tiny breathing gaps
        var fillProb;
        if (depth < 0.22) {
          fillProb = depth * 1.35; // 0.0 -> 0.30
        } else if (depth < 0.55) {
          fillProb = 0.30 + (depth - 0.22) * 1.85; // 0.30 -> 0.91
        } else {
          fillProb = 0.93;
        }

        if (effHash > fillProb) continue;

        // Luminance profile matching Trae.ai screenshot:
        // - Outer & mid fringe (depth < 0.50): brighter gray squares (higher alpha buckets)
        // - Dense interior core (depth >= 0.50): deeper, recessed gray mosaic (lower-mid buckets)
        var intensity;
        if (depth < 0.48) {
          // Brighter scattered crust/archipelago
          intensity = 0.48 + 0.52 * hTone;
        } else {
          // Dense interior core: recessed dark-to-mid gray mosaic texture
          var coreTransition = Math.min(1.0, (depth - 0.48) * 2.5);
          var fringeLevel = 0.48 + 0.52 * hTone;
          // In the core, 75% of cells are deep subtle gray, 25% are mid-tone accent cells
          var coreLevel = hTone > 0.75 ? 0.42 + (hTone - 0.75) * 0.8 : 0.08 + hTone * 0.36;
          intensity = fringeLevel * (1.0 - coreTransition) + coreLevel * coreTransition;
        }

        var bucketIdx = (intensity * NUM_BUCKETS) | 0;
        if (bucketIdx < 0) bucketIdx = 0;
        else if (bucketIdx >= NUM_BUCKETS) bucketIdx = NUM_BUCKETS - 1;

        bucketCoords[bucketIdx].push(c * SPACING, y);
      }
    }

    // 3. Batch-render all visible 4x4 squares in just 12 draw calls
    for (var b = 0; b < NUM_BUCKETS; b++) {
      var coords = bucketCoords[b];
      var len = coords.length;
      if (len === 0) continue;

      ctx.fillStyle = bucketStyles[b];
      ctx.beginPath();
      for (var i = 0; i < len; i += 2) {
        ctx.rect(coords[i], coords[i + 1], CELL_SIZE, CELL_SIZE);
      }
      ctx.fill();
    }
  }

  function loop(timestamp) {
    if (!isRunning) return;
    if (!lastTimestamp) lastTimestamp = timestamp;
    var dt = (timestamp - lastTimestamp) / 1000;
    if (dt >= 0.016) {
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

  window.addEventListener(
    "resize",
    function () {
      if (updateSize()) {
        if (prefersReducedMotion) renderFrame();
      }
    },
    { passive: true }
  );

  if (hero) {
    hero.addEventListener("pointermove", onPointerMove, { passive: true });
    hero.addEventListener("pointerleave", onPointerLeave, { passive: true });
  }

  document.addEventListener("visibilitychange", function () {
    isVisible = !document.hidden;
    if (isVisible) start();
    else stop();
  });

  var observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          function (entries) {
            for (var i = 0; i < entries.length; i++) {
              if (entries[i].target === hero) {
                isIntersecting = entries[i].isIntersecting;
                if (isIntersecting) start();
                else stop();
              }
            }
          },
          { threshold: 0.05 }
        )
      : null;

  if (observer && hero) {
    observer.observe(hero);
  }

  if (typeof MutationObserver === "function") {
    var themeObserver = new MutationObserver(function () {
      cachedThemeKey = "";
      if (!isRunning) renderFrame();
    });
    themeObserver.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  }

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

  if (updateSize()) {
    start();
  }
})();