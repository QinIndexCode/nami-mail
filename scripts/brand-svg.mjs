import assert from "node:assert/strict";
import sharp from "sharp";

function distanceToSegment(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const t = dx || dy ? Math.max(0, Math.min(1,
    ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy),
  )) : 0;
  return Math.hypot(point[0] - start[0] - t * dx, point[1] - start[1] - t * dy);
}

function simplify(points, tolerance) {
  if (points.length <= 2) return points;
  let furthest = 0;
  let distance = tolerance;
  for (let i = 1; i < points.length - 1; i++) {
    const next = distanceToSegment(points[i], points[0], points.at(-1));
    if (next > distance) {
      distance = next;
      furthest = i;
    }
  }
  if (!furthest) return [points[0], points.at(-1)];
  return [
    ...simplify(points.slice(0, furthest + 1), tolerance).slice(0, -1),
    ...simplify(points.slice(furthest), tolerance),
  ];
}

function contourPath(points, cornerAngle) {
  if (points.length <= 4) return `M${points.map((point) => point.join(" ")).join("L")}Z`;
  const previous = (i) => points[(i + points.length - 1) % points.length];
  const next = (i) => points[(i + 1) % points.length];
  const tangents = points.map((point, i) => {
    const a = previous(i);
    const b = next(i);
    const incoming = [point[0] - a[0], point[1] - a[1]];
    const outgoing = [b[0] - point[0], b[1] - point[1]];
    const before = Math.hypot(...incoming);
    const after = Math.hypot(...outgoing);
    // Retain sharp serifs and tips; interpolate smooth curves through their
    // traced points, rather than rounding off the original outline.
    if ((incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) / (before * after) < Math.cos(cornerAngle * Math.PI / 180)) return null;
    const tangent = [incoming[0] / before + outgoing[0] / after, incoming[1] / before + outgoing[1] / after];
    const length = Math.hypot(...tangent);
    return tangent.map((value) => value / length);
  });
  let path = `M${points[0].join(" ")}`;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = next(i);
    const j = (i + 1) % points.length;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const before = previous(i);
    const after = next(j);
    const handleA = Math.min(length, Math.hypot(a[0] - before[0], a[1] - before[1])) / 3;
    const handleB = Math.min(length, Math.hypot(after[0] - b[0], after[1] - b[1])) / 3;
    const controlA = a.map((value, axis) => number(value + (tangents[i]?.[axis] || 0) * handleA));
    const controlB = b.map((value, axis) => number(value - (tangents[j]?.[axis] || 0) * handleB));
    path += !tangents[i] && !tangents[j] ? `L${b.join(" ")}` : `C${controlA.join(" ")} ${controlB.join(" ")} ${b.join(" ")}`;
  }
  return `${path}Z`;
}

/** Trace closed contours, including letter counters, without embedding a raster. */
export function traceMaskToPath(mask, width, height, { threshold = 128, tolerance = 0.65, minArea = 4, cornerAngle = 45 } = {}) {
  assert.equal(mask.length, width * height, "A single-channel mask is required.");
  const stride = width + 1;
  const edges = new Map();
  const on = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] >= threshold;
  const add = (x, y, nx, ny, direction) => {
    const start = y * stride + x;
    const outgoing = edges.get(start) || [];
    outgoing.push({ end: ny * stride + nx, direction });
    edges.set(start, outgoing);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!on(x, y)) continue;
      if (!on(x, y - 1)) add(x, y, x + 1, y, 0);
      if (!on(x + 1, y)) add(x + 1, y, x + 1, y + 1, 1);
      if (!on(x, y + 1)) add(x + 1, y + 1, x, y + 1, 2);
      if (!on(x - 1, y)) add(x, y + 1, x, y, 3);
    }
  }
  const paths = [];
  while (edges.size) {
    const start = edges.keys().next().value;
    let current = start;
    let direction = edges.get(start)[0].direction;
    const points = [];
    do {
      points.push([current % stride, Math.floor(current / stride)]);
      const outgoing = edges.get(current);
      assert.ok(outgoing?.length, "Brand contour must close.");
      // At a diagonal contact, turn right to keep the two contours separate.
      const turns = [(direction + 1) % 4, direction, (direction + 3) % 4, (direction + 2) % 4];
      const nextDirection = turns.find((turn) => outgoing.some((edge) => edge.direction === turn));
      const index = outgoing.findIndex((edge) => edge.direction === nextDirection);
      const [next] = outgoing.splice(index, 1);
      if (!outgoing.length) edges.delete(current);
      current = next.end;
      direction = next.direction;
    } while (current !== start);
    const area = Math.abs(points.reduce((sum, point, i) => {
      const next = points[(i + 1) % points.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0)) / 2;
    if (area < minArea) continue;
    let split = 1;
    for (let i = 2; i < points.length; i++) {
      if (Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]) >
          Math.hypot(points[split][0] - points[0][0], points[split][1] - points[0][1])) split = i;
    }
    const contour = [
      ...simplify(points.slice(0, split + 1), tolerance).slice(0, -1),
      ...simplify([...points.slice(split), points[0]], tolerance).slice(0, -1),
    ];
    paths.push(contourPath(contour, cornerAngle));
  }
  return paths.join("");
}

const number = (value) => Number(value.toFixed(5));

function iconMarkTransform(width, height, size, markRatio = 0.68) {
  const markSize = Math.round(size * markRatio);
  const scale = markSize / Math.max(width, height);
  const left = Math.round((size - Math.round(width * scale)) / 2);
  const top = Math.round((size - Math.round(height * scale)) / 2);
  return `translate(${left} ${top}) scale(${number(scale)})`;
}

/** Both SVGs use the same mark as the existing PNG/ICO application assets. */
export async function renderBrandSvgs(markBuffer, wordmarkReference) {
  const { data: markMask, info: mark } = await sharp(markBuffer).extractChannel("alpha").raw().toBuffer({ resolveWithObject: true });
  const markPath = traceMaskToPath(markMask, mark.width, mark.height, { tolerance: 2 });
  assert.ok(markPath, "The brand mark must contain visible contours.");
  const transform = iconMarkTransform(mark.width, mark.height, 1024);
  const smallTransform = iconMarkTransform(mark.width, mark.height, 1024, 0.74);
  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <title>Nami Mail</title>
  <style>
    @media (max-width: 32px) { .mark { transform: ${smallTransform.replace(/translate\(([^ ]+) ([^)]+)\)/, "translate($1px, $2px)")}; } }
  </style>
  <rect width="1024" height="1024" rx="225" fill="#1b1b1f"/>
  <path class="mark" d="${markPath}" transform="${transform}" fill="#fafafb" fill-rule="evenodd"/>
</svg>
`;

  // Extract only the original lettering. The old white panel and textured icon
  // are deliberately replaced by transparency and the canonical app mark.
  const letteringBox = { left: 342, top: 70, width: 693, height: 131 };
  const { data: letteringMask } = await sharp(wordmarkReference).extract(letteringBox)
    .removeAlpha().grayscale().negate().raw().toBuffer({ resolveWithObject: true });
  const letteringPath = traceMaskToPath(letteringMask, letteringBox.width, letteringBox.height, { threshold: 96, tolerance: 2, cornerAngle: 70 });
  assert.ok(letteringPath, "The wordmark must contain visible lettering.");
  const wordmarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1085" height="266" viewBox="0 0 1085 266" role="img" aria-labelledby="title">
  <title id="title">Nami Mail</title>
  <style>
    :root { color: #171719; }
    @media (prefers-color-scheme: dark) { :root { color: #e8e8ec; } }
  </style>
  <g transform="translate(68 39)">
    <rect width="190" height="190" rx="42" fill="#1b1b1f"/>
    <path d="${markPath}" transform="${iconMarkTransform(mark.width, mark.height, 190)}" fill="#fafafb" fill-rule="evenodd"/>
  </g>
  <path d="M304 49V219" stroke="currentColor" stroke-opacity=".2" stroke-width="2"/>
  <path d="${letteringPath}" transform="translate(${letteringBox.left} ${letteringBox.top})" fill="currentColor" fill-rule="evenodd"/>
</svg>
`;
  return { iconSvg, wordmarkSvg };
}
