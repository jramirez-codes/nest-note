/**
 * Catppuccin Mocha — the single source of truth for the app's color system.
 *
 * Two layers:
 *   1. `mocha`    — the raw named palette (never reference hex anywhere else).
 *   2. `semantic` — roles (background, text, accent, …) mapped onto the palette.
 *
 * Both are consumed by `tailwind.config.js` (so components use utility classes
 * like `bg-background` / `text-muted`) and by `theme/colors.ts` (for the
 * imperative styles the markdown editor needs). Re-theming — or adding another
 * Catppuccin flavor later — is a change in this one file.
 *
 * Palette reference: https://catppuccin.com/palette (Mocha).
 *
 * @format
 */

const mocha = {
  rosewater: '#f5e0dc',
  flamingo: '#f2cdcd',
  pink: '#f5c2e7',
  mauve: '#cba6f7',
  red: '#f38ba8',
  maroon: '#eba0ac',
  peach: '#fab387',
  yellow: '#f9e2af',
  green: '#a6e3a1',
  teal: '#94e2d5',
  sky: '#89dceb',
  sapphire: '#74c7ec',
  blue: '#89b4fa',
  lavender: '#b4befe',
  text: '#cdd6f4',
  subtext1: '#bac2de',
  subtext0: '#a6adc8',
  overlay2: '#9399b2',
  overlay1: '#7f849c',
  overlay0: '#6c7086',
  surface2: '#585b70',
  surface1: '#45475a',
  surface0: '#313244',
  base: '#1e1e2e',
  mantle: '#181825',
  crust: '#11111b',
};

/**
 * Semantic roles. Components should prefer these over raw palette names, so the
 * meaning of a color (and any future re-map) stays in one place.
 */
const semantic = {
  background: mocha.base, // the page / writing surface
  surface: mocha.surface0, // elevated panels, code blocks
  border: mocha.surface0, // hairline dividers on the background
  text: mocha.text, // primary body text
  muted: mocha.subtext0, // secondary text (dates, captions)
  faint: mocha.overlay0, // de-emphasized text, inactive indicators
  accent: mocha.mauve, // primary accent / interactive affordance
  danger: mocha.red, // destructive actions (delete)
  syntax: mocha.overlay1, // markdown syntax characters (#, *, `)
};

module.exports = { mocha, semantic };
