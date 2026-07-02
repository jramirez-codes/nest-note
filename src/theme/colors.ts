import { useColorScheme } from 'react-native';

/**
 * Semantic color tokens. Components reference roles (`text`, `surface`, …)
 * rather than raw hex values, so re-theming is a change in one place.
 *
 * The palette leans warm to evoke a paper notepad.
 */
export interface ThemeColors {
  background: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  /** Color used for markdown syntax characters (the `#`, `*`, backticks). */
  syntax: string;
  codeBackground: string;
}

const light: ThemeColors = {
  background: '#fffbeb', // amber-50 — warm paper
  surface: '#ffffff',
  text: '#1c1917', // stone-900
  muted: '#78716c', // stone-500
  border: '#e7e5e4', // stone-200
  accent: '#d97706', // amber-600
  syntax: '#a8a29e', // stone-400
  codeBackground: '#f5f5f4', // stone-100
};

const dark: ThemeColors = {
  background: '#0c0a09', // stone-950
  surface: '#1c1917', // stone-900
  text: '#f5f5f4', // stone-100
  muted: '#a8a29e', // stone-400
  border: '#292524', // stone-800
  accent: '#fbbf24', // amber-400
  syntax: '#57534e', // stone-600
  codeBackground: '#292524', // stone-800
};

export const themes = { light, dark };

/** Resolve the active theme from the OS color scheme. */
export function useTheme(): ThemeColors {
  return useColorScheme() === 'dark' ? dark : light;
}
