import { semantic } from './catppuccin';

/**
 * Semantic color tokens for imperative styles (the markdown editor). Components
 * that render via NativeWind use the matching utility classes instead
 * (`bg-background`, `text-muted`, …); both are backed by the same palette in
 * `catppuccin.js`, so the app has a single source of truth.
 *
 * The app ships a single dark theme: Catppuccin Mocha.
 */
export interface ThemeColors {
  background: string;
  surface: string;
  text: string;
  muted: string;
  faint: string;
  border: string;
  accent: string;
  danger: string;
  /** Color used for markdown syntax characters (the `#`, `*`, backticks). */
  syntax: string;
  codeBackground: string;
  /** Recessed background behind a fenced code block (styled like GitHub). */
  codeBlockBackground: string;
  /** Hairline border around a fenced code block. */
  codeBlockBorder: string;
}

export const theme: ThemeColors = {
  background: semantic.background,
  surface: semantic.surface,
  text: semantic.text,
  muted: semantic.muted,
  faint: semantic.faint,
  border: semantic.border,
  accent: semantic.accent,
  danger: semantic.danger,
  syntax: semantic.syntax,
  codeBackground: semantic.surface,
  codeBlockBackground: semantic.codeBlockBackground,
  codeBlockBorder: semantic.codeBlockBorder,
};

/** The active theme. A hook so call sites stay stable if flavors are added. */
export function useTheme(): ThemeColors {
  return theme;
}
