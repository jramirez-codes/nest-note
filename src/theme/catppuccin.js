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
 * Catppuccin Latte — the official light flavor of the same palette.
 *
 * The app itself is dark-only (it's a writing surface, often at night) and does
 * not consume this. It exists for the documentation site under `site/`, which is
 * read on laptops and screenshotted, and therefore honors the OS light/dark
 * preference. Keeping it here rather than in `site/` is the point of this file's
 * "adding another Catppuccin flavor is a change in this one file" contract —
 * `site/scripts/gen-theme-css.mjs` reads both flavors from here and generates
 * the site's CSS custom properties, so the two can never drift.
 */
const latte = {
  rosewater: '#dc8a78',
  flamingo: '#dd7878',
  pink: '#ea76cb',
  mauve: '#8839ef',
  red: '#d20f39',
  maroon: '#e64553',
  peach: '#fe640b',
  yellow: '#df8e1d',
  green: '#40a02b',
  teal: '#179299',
  sky: '#04a5e5',
  sapphire: '#209fb5',
  blue: '#1e66f5',
  lavender: '#7287fd',
  text: '#4c4f69',
  subtext1: '#5c5f77',
  subtext0: '#6c6f85',
  overlay2: '#7c7f93',
  overlay1: '#8c8fa1',
  overlay0: '#9ca0b0',
  surface2: '#acb0be',
  surface1: '#bcc0cc',
  surface0: '#ccd0da',
  base: '#eff1f5',
  mantle: '#e6e9ef',
  crust: '#dce0e8',
};

/**
 * Semantic roles. Components should prefer these over raw palette names, so the
 * meaning of a color (and any future re-map) stays in one place.
 *
 * Expressed as a factory over a flavor so the role mapping is written once and
 * both flavors stay structurally identical — a role added here exists in every
 * flavor by construction.
 */
const makeSemantic = p => ({
  background: p.base, // the page / writing surface
  surface: p.surface0, // elevated panels, code blocks
  border: p.surface0, // hairline dividers on the background
  text: p.text, // primary body text
  muted: p.subtext0, // secondary text (dates, captions)
  faint: p.overlay0, // de-emphasized text, inactive indicators
  accent: p.mauve, // primary accent / interactive affordance
  danger: p.red, // destructive actions (delete)
  syntax: p.overlay1, // markdown syntax characters (#, *, `)
  codeBlockBackground: p.mantle, // recessed fenced-code surface (GitHub-like)
  codeBlockBorder: p.surface1, // subtle hairline around a fenced code block
});

/** The app's semantic tokens. Unchanged in value — Mocha, as before. */
const semantic = makeSemantic(mocha);

module.exports = { mocha, latte, semantic, makeSemantic };
