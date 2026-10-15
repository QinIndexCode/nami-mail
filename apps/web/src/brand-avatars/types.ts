export interface BrandAvatar {
  id: string;
  name: string;
  /** Primary brand background color hex (e.g. "#181717"). */
  color: string;
  /** SVG path data (d attribute). */
  svgPath: string;
  /** SVG viewBox dimensions. Defaults to "0 0 24 24". */
  viewBox?: string;
  /** Foreground/icon color. Defaults to "#ffffff". */
  textColor?: string;
}
