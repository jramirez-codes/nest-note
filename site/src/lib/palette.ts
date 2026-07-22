/**
 * Catppuccin palette, resolved to concrete values for JS consumers.
 *
 * The CSS-only parts of the site read `var(--ctp-mauve)` directly and get theme
 * switching for free. React Flow cannot — a handful of its knobs (edge stroke,
 * background pattern) take a concrete `#cba6f7` as a JS string, and want a *new*
 * one when the user flips the docs theme toggle.
 *
 * So: read the computed value off `:root`, and re-read it when the `data-theme`
 * attribute that scopes the flavors changes. Keeping the CSS as the single
 * source of truth means the generated palette file stays authoritative — there
 * is no second copy of the hex codes to drift.
 */
import { useEffect, useState } from 'react';

/** The subset of roles the islands actually use. */
export const PALETTE_KEYS = [
  'base',
  'mantle',
  'crust',
  'surface0',
  'surface1',
  'surface2',
  'overlay0',
  'overlay1',
  'text',
  'subtext0',
  'subtext1',
  'mauve',
  'lavender',
  'blue',
  'sapphire',
  'teal',
  'green',
  'peach',
  'pink',
] as const;

export type PaletteKey = (typeof PALETTE_KEYS)[number];
export type Palette = Record<PaletteKey, string> & { dark: boolean };

/**
 * Fallback used during SSR and for the very first client render, before
 * `getComputedStyle` is available. These are Mocha's values — matching the
 * site's default theme, so the common case never flashes the wrong color.
 */
const MOCHA: Record<PaletteKey, string> = {
  base: '#1e1e2e',
  mantle: '#181825',
  crust: '#11111b',
  surface0: '#313244',
  surface1: '#45475a',
  surface2: '#585b70',
  overlay0: '#6c7086',
  overlay1: '#7f849c',
  text: '#cdd6f4',
  subtext0: '#a6adc8',
  subtext1: '#bac2de',
  mauve: '#cba6f7',
  lavender: '#b4befe',
  blue: '#89b4fa',
  sapphire: '#74c7ec',
  teal: '#94e2d5',
  green: '#a6e3a1',
  peach: '#fab387',
  pink: '#f5c2e7',
};

/**
 * Which flavor is actually on screen.
 *
 * This mirrors the cascade in catppuccin.generated.css exactly: an explicit
 * `data-theme` wins, and with no attribute at all the OS preference decides.
 *
 * Treating "no attribute" as dark — the obvious shortcut — is wrong precisely
 * where it matters. The landing page renders outside Starlight's layout, so a
 * first-time visitor has no stored choice and no attribute; on a light-mode OS
 * the CSS then serves Latte while this reported dark, and the pad drew grey
 * paper on a white page.
 */
function isDark(): boolean {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'light') return false;
  if (explicit === 'dark') return true;
  return !window.matchMedia('(prefers-color-scheme: light)').matches;
}

export function readPalette(): Palette {
  if (typeof document === 'undefined') return { ...MOCHA, dark: true };

  const style = getComputedStyle(document.documentElement);
  const out = {} as Record<PaletteKey, string>;
  for (const key of PALETTE_KEYS) {
    out[key] = style.getPropertyValue(`--ctp-${key}`).trim() || MOCHA[key];
  }
  return { ...out, dark: isDark() };
}

/**
 * Live palette. Re-resolves on theme change so React Flow's JS-set colors follow
 * the same toggle as the rest of the page.
 */
export function usePalette(): Palette {
  const [palette, setPalette] = useState<Palette>(() => ({ ...MOCHA, dark: true }));

  useEffect(() => {
    setPalette(readPalette());

    const resync = () => setPalette(readPalette());

    // Two independent triggers, matching the two ways the flavor can change:
    // the docs' theme toggle stamps `data-theme`, and a visitor who has never
    // touched that toggle follows the OS instead.
    const observer = new MutationObserver(resync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    const os = window.matchMedia('(prefers-color-scheme: light)');
    os.addEventListener('change', resync);

    return () => {
      observer.disconnect();
      os.removeEventListener('change', resync);
    };
  }, []);

  return palette;
}

/** True when the visitor has asked for reduced motion. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  return reduced;
}
