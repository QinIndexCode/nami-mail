export type MailSurface = {
  tone: "light" | "dark";
  luminance: number;
  rgb: readonly [number, number, number];
};

const lightSurfaceThreshold = 0.62;
const darkSurfaceThreshold = 0.35;
const readableTextContrastThreshold = 4.5;
const opaqueBackgroundAlphaThreshold = 0.9;

type Rgb = readonly [number, number, number];

type ParsedColor = {
  rgb: Rgb;
  alpha: number;
};

const namedColors: Record<string, Rgb> = {
  aqua: [0, 255, 255],
  black: [0, 0, 0],
  blue: [0, 0, 255],
  fuchsia: [255, 0, 255],
  gray: [128, 128, 128],
  green: [0, 128, 0],
  grey: [128, 128, 128],
  lime: [0, 255, 0],
  maroon: [128, 0, 0],
  navy: [0, 0, 128],
  olive: [128, 128, 0],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  rebeccapurple: [102, 51, 153],
  red: [255, 0, 0],
  silver: [192, 192, 192],
  teal: [0, 128, 128],
  white: [255, 255, 255],
  yellow: [255, 255, 0],
};

const darkReaderSurface = createSurface([23, 23, 25]);
const lightReaderSurface = createSurface([255, 255, 255]);

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseAlpha(value: string): number | null {
  const match = value.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+))%?$/);
  if (!match) return null;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric)) return null;
  return clamp(value.trim().endsWith("%") ? numeric / 100 : numeric, 0, 1);
}

function parseRgbChannel(value: string): number | null {
  const match = value.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+))%?$/);
  if (!match) return null;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric)) return null;
  return clamp(value.trim().endsWith("%") ? (numeric / 100) * 255 : numeric, 0, 255);
}

function parseColorParts(value: string): { channels: string[]; alpha: string | null } | null {
  const [channelPart, slashAlpha] = value.trim().split(/\s*\/\s*/, 2);
  const channels = channelPart.includes(",")
    ? channelPart.split(",").map((part) => part.trim()).filter(Boolean)
    : channelPart.split(/\s+/).filter(Boolean);
  const implicitAlpha = !slashAlpha && channels.length === 4 ? channels.pop() ?? null : null;
  if (channels.length !== 3) return null;
  return { channels, alpha: slashAlpha ?? implicitAlpha };
}

function parseRgbColor(value: string): ParsedColor | null {
  const match = value.match(/^rgba?\(\s*(.*?)\s*\)$/i);
  if (!match) return null;
  const parts = parseColorParts(match[1]);
  if (!parts) return null;
  const rgb = parts.channels.map(parseRgbChannel);
  const alpha = parts.alpha ? parseAlpha(parts.alpha) : 1;
  if (rgb.some((channel) => channel === null) || alpha === null) return null;
  return { rgb: [rgb[0]!, rgb[1]!, rgb[2]!], alpha };
}

function parseHue(value: string): number | null {
  const match = value.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+))(deg|grad|rad|turn)?$/i);
  if (!match) return null;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric)) return null;
  const unit = match[2]?.toLowerCase();
  const degrees = unit === "grad" ? numeric * 0.9
    : unit === "rad" ? numeric * (180 / Math.PI)
      : unit === "turn" ? numeric * 360
        : numeric;
  return ((degrees % 360) + 360) % 360;
}

function parsePercentage(value: string): number | null {
  const match = value.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+))%$/);
  if (!match) return null;
  const numeric = Number(match[1]);
  return Number.isFinite(numeric) ? clamp(numeric / 100, 0, 1) : null;
}

function parseHslColor(value: string): ParsedColor | null {
  const match = value.match(/^hsla?\(\s*(.*?)\s*\)$/i);
  if (!match) return null;
  const parts = parseColorParts(match[1]);
  if (!parts) return null;
  const hue = parseHue(parts.channels[0]);
  const saturation = parsePercentage(parts.channels[1]);
  const lightness = parsePercentage(parts.channels[2]);
  const alpha = parts.alpha ? parseAlpha(parts.alpha) : 1;
  if (hue === null || saturation === null || lightness === null || alpha === null) return null;

  const chroma = (1 - Math.abs((2 * lightness) - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const matchChannel = hue < 60 ? [chroma, secondary, 0]
    : hue < 120 ? [secondary, chroma, 0]
      : hue < 180 ? [0, chroma, secondary]
        : hue < 240 ? [0, secondary, chroma]
          : hue < 300 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  const offset = lightness - (chroma / 2);
  return {
    rgb: [
      (matchChannel[0] + offset) * 255,
      (matchChannel[1] + offset) * 255,
      (matchChannel[2] + offset) * 255,
    ],
    alpha,
  };
}

function parseHexColor(value: string): ParsedColor | null {
  const hex = value.match(/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[0];
  if (!hex) return null;
  const digits = hex.slice(1);
  const expanded = digits.length <= 4
    ? digits.split("").map((part) => `${part}${part}`).join("")
    : digits;
  const alpha = expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1;
  return {
    rgb: [
      Number.parseInt(expanded.slice(0, 2), 16),
      Number.parseInt(expanded.slice(2, 4), 16),
      Number.parseInt(expanded.slice(4, 6), 16),
    ],
    alpha,
  };
}

function parseCssColor(value: string | null): ParsedColor | null {
  if (!value) return null;
  const color = value.trim().toLowerCase();
  if (!color || color === "inherit" || color === "initial" || color === "unset" || color === "currentcolor") return null;
  if (color === "transparent") return { rgb: [0, 0, 0], alpha: 0 };
  const named = namedColors[color];
  if (named) return { rgb: named, alpha: 1 };
  return parseHexColor(color) ?? parseRgbColor(color) ?? parseHslColor(color);
}

function luminanceForRgb(rgb: Rgb): number {
  const linear = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function createSurface(rgb: Rgb): MailSurface {
  const luminance = luminanceForRgb(rgb);
  return {
    tone: luminance > lightSurfaceThreshold ? "light" : "dark",
    luminance,
    rgb,
  };
}

function topLevelDepth(value: string, end: number): number {
  let depth = 0;
  let quote = "";
  for (let index = 0; index < end; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth = Math.max(0, depth - 1);
    }
  }
  return depth;
}

function stripCssFunctions(value: string): string {
  let result = "";
  let depth = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === "\"" || character === "'") {
      if (depth === 0) result += character;
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) result += character;
  }
  return result;
}

function colorFromBackgroundShorthand(value: string): string | null {
  if (parseCssColor(value)) return value;
  // A gradient has no single trustworthy surface color. A URL may have a
  // conventional solid fallback, which is useful when identifying old email tables.
  if (/gradient\s*\(/i.test(value)) return null;

  const functionalColor = /(?:rgba?|hsla?)\(\s*[^()]*\s*\)/gi;
  for (const match of value.matchAll(functionalColor)) {
    if (match.index !== undefined && topLevelDepth(value, match.index) === 0 && parseCssColor(match[0])) return match[0];
  }

  const outsideFunctions = stripCssFunctions(value);
  const hex = outsideFunctions.match(/#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/i)?.[0];
  if (hex && parseCssColor(hex)) return hex;
  for (const token of outsideFunctions.matchAll(/\b[a-z]+\b/gi)) {
    if (parseCssColor(token[0])) return token[0];
  }
  return null;
}

function effectiveForegroundLuminance(foreground: ParsedColor, surface: MailSurface): number {
  if (foreground.alpha >= 1) return luminanceForRgb(foreground.rgb);
  const composite: Rgb = [
    (foreground.rgb[0] * foreground.alpha) + (surface.rgb[0] * (1 - foreground.alpha)),
    (foreground.rgb[1] * foreground.alpha) + (surface.rgb[1] * (1 - foreground.alpha)),
    (foreground.rgb[2] * foreground.alpha) + (surface.rgb[2] * (1 - foreground.alpha)),
  ];
  return luminanceForRgb(composite);
}

export function colorLuminance(value: string | null): number | null {
  const color = parseCssColor(value);
  return !color || color.alpha === 0 ? null : luminanceForRgb(color.rgb);
}

function isOpaqueBackground(value: string | null): boolean {
  const color = parseCssColor(value);
  return color !== null && color.alpha >= opaqueBackgroundAlphaThreshold;
}

export function mailSurfaceForBackground(background: string | null): MailSurface | null {
  if (!isOpaqueBackground(background)) return null;
  const color = parseCssColor(background);
  if (!color) return null;
  const luminance = luminanceForRgb(color.rgb);
  if (luminance > lightSurfaceThreshold) return { tone: "light", luminance, rgb: color.rgb };
  if (luminance < darkSurfaceThreshold) return { tone: "dark", luminance, rgb: color.rgb };
  return null;
}

export function mailBackgroundColor(
  backgroundColor: string | null,
  background: string | null,
  legacyBackground: string | null,
): string | null {
  if (parseCssColor(backgroundColor)) return backgroundColor;
  if (background) {
    const shorthandColor = colorFromBackgroundShorthand(background);
    if (shorthandColor) return shorthandColor;
  }
  return parseCssColor(legacyBackground) ? legacyBackground : null;
}

export function mailReaderSurface(tone: "light" | "dark"): MailSurface {
  return tone === "dark" ? darkReaderSurface : lightReaderSurface;
}

export function shouldResetMailForeground(
  foreground: string | null,
  surface: MailSurface | null,
  minimumContrast = readableTextContrastThreshold,
): boolean {
  const foregroundColor = parseCssColor(foreground);
  if (!foregroundColor) return false;

  const effectiveSurface = surface ?? darkReaderSurface;
  const foregroundLuminance = effectiveForegroundLuminance(foregroundColor, effectiveSurface);

  const contrast = (Math.max(foregroundLuminance, effectiveSurface.luminance) + 0.05)
    / (Math.min(foregroundLuminance, effectiveSurface.luminance) + 0.05);
  return contrast < minimumContrast;
}
