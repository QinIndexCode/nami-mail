declare module "react-file-icon" {
  import type { ReactElement } from "react";

  export type FileIconType =
    | "3d"
    | "acrobat"
    | "android"
    | "audio"
    | "binary"
    | "code"
    | "compressed"
    | "document"
    | "drive"
    | "font"
    | "image"
    | "presentation"
    | "settings"
    | "spreadsheet"
    | "vector"
    | "video";

  export type FileIconProps = {
    color?: string;
    extension?: string;
    fold?: boolean;
    foldColor?: string;
    glyphColor?: string;
    gradientColor?: string;
    gradientOpacity?: number;
    labelColor?: string;
    labelTextColor?: string;
    labelUppercase?: boolean;
    radius?: number;
    type?: FileIconType;
  };

  export function FileIcon(props: FileIconProps): ReactElement;
  export const defaultStyles: Record<string, FileIconProps>;
}
