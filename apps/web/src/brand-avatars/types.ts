export interface BrandAvatar {
  id: string;
  name: string;
  /** Primary brand background color hex (e.g. "#F24E1E"). */
  color: string;
  /** SVG path data (d attribute). */
  svgPath: string;
}

/**
 * One icon as stored in icons.json, the file apps/web/scripts/sync-brand-icons.mjs writes and
 * the registry reads. The shape is declared once, here, so that the artifact, the script and
 * the tests cannot end up describing the same file three different ways.
 */
export interface BrandIconRecord {
  source: string;
  slug: string;
  version: string;
  /** Upstream brand color (`#RRGGBB`), or null when upstream published none. */
  hex: string | null;
  path: string;
}
