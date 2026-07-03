/** Type declarations for the CommonJS palette in `catppuccin.js`. */

export interface MochaPalette {
  rosewater: string;
  flamingo: string;
  pink: string;
  mauve: string;
  red: string;
  maroon: string;
  peach: string;
  yellow: string;
  green: string;
  teal: string;
  sky: string;
  sapphire: string;
  blue: string;
  lavender: string;
  text: string;
  subtext1: string;
  subtext0: string;
  overlay2: string;
  overlay1: string;
  overlay0: string;
  surface2: string;
  surface1: string;
  surface0: string;
  base: string;
  mantle: string;
  crust: string;
}

export interface SemanticColors {
  background: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  danger: string;
  syntax: string;
  codeBlockBackground: string;
  codeBlockBorder: string;
}

export const mocha: MochaPalette;
export const semantic: SemanticColors;
