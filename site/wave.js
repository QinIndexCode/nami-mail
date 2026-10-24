/* Nami Mail landing page — "Nami Tidal Matrix" (High-Dynamics Wave Edition)
 *
 * Upgrades for richer, more vivid pixel fluctuation while preserving monochrome elegance:
 * 1. Cross-Swell Wave Interference: primary diagonal swells + secondary cross-ripples
 *    create visibly rolling wave crests and shifting bathymetric contours.
 * 2. Cascading Pixel Undulation: per-cell luminance, existence threshold (amplitude ±0.24),
 *    and micro-glyph morphology (2x2 dot <-> 4x4 hollow ring <-> 4x4 solid) dynamically
 *    cascade as wave phase sweeps across each cluster.
 * 3. Autonomous Tidal Pulses: self-spawning harmonic wave rings periodically sweep across
 *    the matrix so the canvas feels alive even without pointer movement.
 * 4. Expanding Pointer Ripples: moving the cursor radiates outward travelling wave rings.
 * 5. Balanced Pacing: a 24 FPS cap, a 1.5x larger dot pitch (about 55% fewer
 *    particles to simulate and draw each frame), and a simulation step halved
 *    from the original keep the hero calm and cheap — full smoothness at 50%
 *    of the former motion speed.
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
  var simTime = Math.random() * 100;

  // 24 FPS frame rate limit — smooth motion at the zoomed pitch stays well under budget
  var TARGET_FPS = 24;
  var FRAME_INTERVAL = 1000 / TARGET_FPS; // ~41.67 ms per frame

  // 9px pitch grid (1.5x zoom of the original 6px pitch): ~55% fewer cells per frame;
  // supports 6x6 solid, 6x6 hollow ring, and 3x3 mist dots
  var SPACING = 9;
  var CELL_SIZE = 6;
  var cols = 0;
  var rows = 0;

  // Per-cell deterministic spatial hashes
  var cellHashExist = null;
  var cellHashTone = null;
  var cellHashGlyph = null;
  var cellFlickerPhase = null;

  // Coarse evaluation grid (1 sample per 3x3 cells = 18px)
  var COARSE_STEP = 3;
  var cCols = 0;
  var cRows = 0;
  var coarseWave = null;
  var coarseCrest = null;
  var coarsePhase = null;
  var coarseWake = null;

  // Autonomous tidal pulse emitters (creates natural expanding wave rings)
  var pulses = [];
  var MAX_PULSES = 3;

  // 12 monochrome alpha buckets using single-pass 'evenodd' path batching
  var NUM_BUCKETS = 12;
  var bucketStyles = new Array(NUM_BUCKETS);
  var bucketItems = new Array(NUM_BUCKETS);
  for (var b = 0; b < NUM_BUCKETS; b++) {
    bucketItems[b] = [];
  }
  var cachedThemeKey = "";

  var pointer = {
    x: -9999,
    y: -9999,
    targetX: -9999,
    targetY: -9999,
    speed: 0,
    active: false,
  };

  // --- Fast 3D Gradient Noise ---
  var perm = new Uint8Array(512);
  (function initNoise() {
    var p = new Uint8Array(256);
    for (var i = 0; i < 256; i++) p[i] = i;
    var seed = 2026;
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

    return (
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
              u * grad3(perm[BB + 1], x - 1, y - 1, z - 1)))
    );
  }

  function spawnPulse(customX, customY) {
    return {
      cx: customX !== undefined ? customX : cCols * (0.15 + 0.7 * Math.random()),
      cy: customY !== undefined ? customY : cRows * (0.15 + 0.7 * Math.random()),
      radius: 0,
      maxRadius: 22 + Math.random() * 18,
      // Halved expansion rate so autonomous rings match the 50% motion speed
      speed: (0.22 + Math.random() * 0.10) * 1.25,
      strength: 0.22 + Math.random() * 0.10,
    };
  }

  function buildPaletteBuckets() {
    var isDark =
      root.dataset.theme === "dark" ||
      (!root.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);

    var themeKey = isDark ? "dark" : "light";
    if (themeKey === cachedThemeKey) return;
    cachedThemeKey = themeKey;

    for (var i = 0; i < NUM_BUCKETS; i++) {
      var t = (i + 1) / NUM_BUCKETS;
      if (isDark) {
        // Dark mode: deeper contrast range from subtle slate (0.12) to luminous white-silver (0.86)
        var alpha = 0.12 + Math.pow(t, 1.05) * 0.74;
        var lum = Math.round(105 + t * 150); // 105 -> 255
        var bLum = Math.min(255, lum + 6);
        bucketStyles[i] = "rgba(" + lum + "," + Math.min(255, lum + 3) + "," + bLum + "," + alpha.toFixed(3) + ")";
      } else {
        // Light mode: subtle slate-gray undertow up to crisp deep ink crest
        var alphaL = 0.10 + Math.pow(t, 1.05) * 0.68;
        var lumL = Math.round(140 - t * 125); // 140 -> 15
        bucketStyles[i] = "rgba(" + lumL + "," + (lumL + 2) + "," + (lumL + 6) + "," + alphaL.toFixed(3) + ")";
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
    cellHashGlyph = new Float32Array(total);
    cellFlickerPhase = new Float32Array(total);

    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var idx = r * cols + c;
        var h1 = (c * 374761393 + r * 668265263) ^ 0x5bf03635;
        h1 = ((h1 ^ (h1 >> 13)) * 1274126177) >>> 0;
        cellHashExist[idx] = h1 / 4294967296;

        var h2 = (c * 1103515245 + r * 12345 + 0x9e3779b9) ^ (h1 >> 7);
        h2 = ((h2 ^ (h2 >> 15)) * 2246822519) >>> 0;
        cellHashTone[idx] = h2 / 4294967296;

        var h3 = (c * 2246822519 + r * 3266489917) ^ (h2 >> 11);
        h3 = ((h3 ^ (h3 >> 16)) * 668265263) >>> 0;
        cellHashGlyph[idx] = h3 / 4294967296;

        cellFlickerPhase[idx] = ((h1 ^ h3) >>> 0) / 4294967296 * Math.PI * 2;
      }
    }

    cCols = Math.ceil(cols / COARSE_STEP) + 2;
    cRows = Math.ceil(rows / COARSE_STEP) + 2;
    coarseWave = new Float32Array(cCols * cRows);
    coarseCrest = new Float32Array(cCols * cRows);
    coarsePhase = new Float32Array(cCols * cRows);
    coarseWake = new Float32Array(cCols * cRows);

    pulses = [];
    for (var p = 0; p < MAX_PULSES; p++) {
      var pulse = spawnPulse();
      pulse.radius = (p / MAX_PULSES) * pulse.maxRadius;
      pulses.push(pulse);
    }

    cachedThemeKey = "";
    buildPaletteBuckets();
    return true;
  }

  function computeTidalField() {
    var t = simTime;
    // Rotate coordinate space by ~-24 deg so tidal swells sweep diagonally
    var cosA = 0.9135;
    var sinA = -0.4067;

    var scaleAlong = 0.014;
    var scaleCross = 0.025;

    // Step autonomous harmonic tidal pulses
    for (var p = 0; p < pulses.length; p++) {
      pulses[p].radius += pulses[p].speed;
      if (pulses[p].radius > pulses[p].maxRadius) {
        pulses[p] = spawnPulse();
      }
    }

    var hasPointer = pointer.active && pointer.x > -1000;
    var pxCoarse = pointer.x / (SPACING * COARSE_STEP);
    var pyCoarse = pointer.y / (SPACING * COARSE_STEP);

    for (var cr = 0; cr < cRows; cr++) {
      var gcR = cr * COARSE_STEP;
      var rowOff = cr * cCols;

      for (var cc = 0; cc < cCols; cc++) {
        var cIdx = rowOff + cc;
        var gcC = cc * COARSE_STEP;

        // 1. Persistent fluid wake + active radiating pointer wave rings
        var wake = coarseWake[cIdx] * 0.84;
        if (hasPointer) {
          var dx = cc - pxCoarse;
          var dy = cr - pyCoarse;
          var d2 = dx * dx + dy * dy;
          if (d2 < 42) {
            var d = Math.sqrt(d2);
            // Travelling outward wave ring around cursor
            var rippleWave = Math.sin(d * 1.65 - t * 5.2) * Math.exp(-d * 0.16);
            var boost = rippleWave * (0.28 + Math.min(0.25, pointer.speed * 0.015));
            wake = Math.max(-0.45, Math.min(0.65, wake + boost));
          }
        }
        coarseWake[cIdx] = wake;

        // 2. Autonomous tidal pulse ring contribution
        var pulseContrib = 0;
        for (var pIdx = 0; pIdx < pulses.length; pIdx++) {
          var pl = pulses[pIdx];
          var pdx = cc - pl.cx;
          var pdy = cr - pl.cy;
          var pd = Math.sqrt(pdx * pdx + pdy * pdy);
          var ringDist = Math.abs(pd - pl.radius);
          if (ringDist < 4.5) {
            var life = 1.0 - pl.radius / pl.maxRadius;
            var ringProfile = Math.cos((ringDist / 4.5) * Math.PI * 0.5);
            pulseContrib += ringProfile * life * pl.strength;
          }
        }

        // 3. Rotated tidal coordinates with lively domain warping
        var u = (gcC * cosA - gcR * sinA) * scaleAlong;
        var v = (gcC * sinA + gcR * cosA) * scaleCross;

        var warpU = u + 0.52 * noise3D(u * 0.9, v * 0.9, t * 0.24);
        var warpV = v + 0.65 * noise3D(u * 1.1 + 31.4, v * 0.85 - 19.7, t * 0.28);

        // Primary rolling tidal swell (faster phase velocity so wave motion is unmistakable)
        var phase1 = warpV * 2.5 - t * 1.15 + 0.9 * noise3D(warpU * 1.2, warpV * 0.9, t * 0.25);
        var s1 = Math.sin(phase1);
        var c1 = Math.cos(phase1);
        var primaryWave = Math.pow((s1 + 1.0) * 0.5, 1.45) * (0.82 + 0.18 * c1);

        // Secondary cross-swell interference (creates shifting peaks & undulating saddles)
        var phase2 = (warpU * 1.7 - warpV * 1.2) * 1.8 + t * 0.85;
        var crossWave = 0.5 + 0.5 * Math.sin(phase2 + noise3D(u * 1.6, v * 1.6, t * 0.3) * 1.8);

        // Island archipelago continent mask (additive + modulated so peaks aren't crushed)
        var continent =
          0.52 +
          0.42 * noise3D(u * 0.62 - t * 0.14, v * 0.55 + 11.2, t * 0.22) +
          0.22 * noise3D(u * 1.55 + 7.3, v * 1.35 + t * 0.18, -t * 0.26);

        // Bathymetric contour ripples that actively cascade down the back of each wave
        var contourRipple = 0.5 + 0.5 * Math.sin(phase1 * 3.8 + t * 1.6);

        // Fast lateral "Signal Gliders" surfing along the wave ridges
        var glider = Math.max(0, Math.sin(warpU * 5.0 - t * 3.6 + s1 * 1.5));
        glider = Math.pow(glider, 5.0) * 0.28;

        // Combine into unified wave elevation
        var waveHeight =
          continent * (0.52 + 0.48 * primaryWave) +
          crossWave * primaryWave * 0.22 +
          contourRipple * primaryWave * 0.12 +
          glider * primaryWave +
          pulseContrib +
          wake;

        coarseWave[cIdx] = waveHeight;
        // Crest highlight tracks leading wave fronts, signal gliders, and active ripples
        coarseCrest[cIdx] = Math.max(
          0,
          Math.min(
            1,
            (c1 + 0.35) * 0.55 +
              glider * 1.8 +
              pulseContrib * 1.6 +
              (wake > 0 ? wake * 1.4 : 0)
          )
        );
        // Travelling phase used to drive cascading pixel-by-pixel shimmer & glyph morphing
        coarsePhase[cIdx] = phase1 * 2.2 + phase2 * 1.4;
      }
    }
  }

  function renderFrame() {
    if (width <= 0 || height <= 0 || !coarseWave) return;
    ctx.clearRect(0, 0, width, height);
    buildPaletteBuckets();

    // Half-speed simulation step calibrated for 24 FPS (~0.66 units/sec, 50% of the original pace)
    simTime += 0.0275;

    if (pointer.active) {
      var prevX = pointer.x < -1000 ? pointer.targetX : pointer.x;
      var prevY = pointer.y < -1000 ? pointer.targetY : pointer.y;
      pointer.x = prevX + (pointer.targetX - prevX) * 0.48;
      pointer.y = prevY + (pointer.targetY - prevY) * 0.48;
      var vx = pointer.x - prevX;
      var vy = pointer.y - prevY;
      pointer.speed = Math.min(32, Math.sqrt(vx * vx + vy * vy));
    } else {
      pointer.speed *= 0.75;
      pointer.x += (-9999 - pointer.x) * 0.25;
      pointer.y += (-9999 - pointer.y) * 0.25;
    }

    computeTidalField();

    for (var b = 0; b < NUM_BUCKETS; b++) {
      bucketItems[b].length = 0;
    }

    // Calibrated sea level: keeps ~72% clean void while allowing rich, expressive wave clusters
    var SEA_LEVEL = 0.56;
    var invRange = 1.0 / (0.98 - SEA_LEVEL);
    var invCoarse = 1.0 / COARSE_STEP;

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

        var i00 = cRow0 + cc;
        var i10 = i00 + 1;
        var i01 = cRow1 + cc;
        var i11 = i01 + 1;

        // Bilinear interpolation of wave height
        var wVal =
          (coarseWave[i00] + (coarseWave[i10] - coarseWave[i00]) * fx) * (1 - fy) +
          (coarseWave[i01] + (coarseWave[i11] - coarseWave[i01]) * fx) * fy;

        if (wVal <= SEA_LEVEL) continue;

        // Bilinear interpolation of crest energy & travelling wave phase
        var crest =
          (coarseCrest[i00] + (coarseCrest[i10] - coarseCrest[i00]) * fx) * (1 - fy) +
          (coarseCrest[i01] + (coarseCrest[i11] - coarseCrest[i01]) * fx) * fy;

        var localPhase =
          (coarsePhase[i00] + (coarsePhase[i10] - coarsePhase[i00]) * fx) * (1 - fy) +
          (coarsePhase[i01] + (coarsePhase[i11] - coarsePhase[i01]) * fx) * fy;

        var depth = (wVal - SEA_LEVEL) * invRange;
        if (depth > 1.25) depth = 1.25;

        var idx = cellRowOff + c;
        var hExist = cellHashExist[idx];
        var hTone = cellHashTone[idx];
        var hGlyph = cellHashGlyph[idx];
        var cellPhase = cellFlickerPhase[idx];

        // 1. Dynamic Cascading Existence Wave (±0.24 modulation so edge & mid-slope pixels actively ripple)
        var cascadeWave = Math.sin(localPhase - simTime * 2.6 + cellPhase);
        var effHash = hExist + cascadeWave * 0.24;

        var fillProb;
        if (depth < 0.25) {
          fillProb = depth * 1.5; // 0.0 -> 0.375 (lively seafoam fringe)
        } else if (depth < 0.58) {
          fillProb = 0.375 + (depth - 0.25) * 1.65; // 0.375 -> 0.92
        } else {
          fillProb = 0.93;
        }

        if (effHash > fillProb) continue;

        // 2. Dynamic Tone & Micro-Glyph Oscillation (interior pixels undulate as waves pass through)
        var toneRipple = 0.5 + 0.5 * Math.sin(localPhase * 1.4 - simTime * 3.1 + cellPhase * 0.7);
        var dynTone = hTone * 0.55 + toneRipple * 0.45;
        var dynGlyph = hGlyph + 0.28 * Math.cos(localPhase - simTime * 2.2 + cellPhase);

        // glyphType: 0 = 2x2 mist dot, 1 = 4x4 solid square, 2 = 4x4 hollow 1px ring
        var glyphType = 1;
        var intensity;

        if (depth < 0.22 || (depth < 0.38 && dynGlyph < 0.45)) {
          // Outer spray zone: shimmering 2x2 mist dots & bright crest droplets
          glyphType = dynGlyph < 0.65 ? 0 : 1;
          intensity = 0.52 + 0.48 * (dynTone * 0.65 + crest * 0.35);
        } else if (depth < 0.54) {
          // Active wave crest & contour slopes: crisp 4x4 solid squares with cascading highlights
          glyphType = 1;
          intensity = 0.46 + 0.54 * (dynTone * 0.55 + crest * 0.45);
        } else {
          // Deep tidal interior: recessed mosaic where solid squares, hollow rings & 2x2 nodes ripple
          var coreBlend = Math.min(1.0, (depth - 0.54) * 2.5);
          var crestLevel = 0.50 + 0.46 * dynTone;
          // Traveling internal wave lights up bands of cells inside the dark core
          var coreWaveHighlight = Math.pow(toneRipple, 2.6) * 0.38;
          var undertowLevel = (hTone > 0.76 ? 0.38 + (hTone - 0.76) * 0.8 : 0.08 + hTone * 0.26) + coreWaveHighlight;

          intensity = crestLevel * (1.0 - coreBlend) + undertowLevel * coreBlend + crest * 0.22;

          if (dynGlyph > 0.68) {
            glyphType = 2; // 4x4 hollow frame
          } else if (dynGlyph < 0.16) {
            glyphType = 0; // 2x2 centered node
          }
        }

        var bucketIdx = (intensity * NUM_BUCKETS) | 0;
        if (bucketIdx < 0) bucketIdx = 0;
        else if (bucketIdx >= NUM_BUCKETS) bucketIdx = NUM_BUCKETS - 1;

        bucketItems[bucketIdx].push(c * SPACING, y, glyphType);
      }
    }

    // 3. Batch-render all 3 glyph morphologies in 12 draw calls using 'evenodd' winding
    for (var b = 0; b < NUM_BUCKETS; b++) {
      var items = bucketItems[b];
      var len = items.length;
      if (len === 0) continue;

      ctx.fillStyle = bucketStyles[b];
      ctx.beginPath();

      for (var i = 0; i < len; i += 3) {
        var x = items[i];
        var yPos = items[i + 1];
        var gType = items[i + 2];

        if (gType === 1) {
          ctx.rect(x, yPos, CELL_SIZE, CELL_SIZE);
        } else if (gType === 0) {
          ctx.rect(x + 2, yPos + 2, 3, 3);
        } else {
          ctx.rect(x, yPos, CELL_SIZE, CELL_SIZE);
          ctx.rect(x + 1, yPos + 1, 4, 4);
        }
      }

      ctx.fill("evenodd");
    }
  }

  function loop(timestamp) {
    if (!isRunning) return;
    if (!lastTimestamp) {
      lastTimestamp = timestamp;
      renderFrame();
      animId = requestAnimationFrame(loop);
      return;
    }
    var elapsed = timestamp - lastTimestamp;
    if (elapsed >= FRAME_INTERVAL) {
      if (elapsed > 200) {
        lastTimestamp = timestamp;
      } else {
        lastTimestamp += FRAME_INTERVAL;
      }
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
    lastTimestamp = 0;
    animId = requestAnimationFrame(loop);
  }

  function stop() {
    isRunning = false;
    lastTimestamp = 0;
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