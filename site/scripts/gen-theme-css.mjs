/**
 * Generate the site's Catppuccin CSS custom properties from the app's palette.
 *
 * `src/theme/catppuccin.js` is the single source of truth for color in this
 * repo. It is CommonJS and lives outside the site's Vite root, so rather than
 * importing across the project boundary at build time (fragile, and Vite's
 * `fs.allow` fights it), we generate a CSS file and commit it — the same
 * pattern the repo already uses for `webview-editor/` -> `src/webview/editorHtml.ts`.
 *
 * `predev`/`prebuild` regenerate it; CI runs `check:theme`, which regenerates
 * and fails on a non-empty git diff. Drift becomes a red X, not a silent
 * divergence.
 *
 * Run: npm run gen:theme
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const SOURCE = '../../src/theme/catppuccin.js';
const OUT = resolve(here, '../src/styles/catppuccin.generated.css');

const { mocha, latte, makeSemantic } = require(SOURCE);

/** `{ base: '#1e1e2e' }` -> `  --ctp-base: #1e1e2e;` */
const toVars = (obj, prefix) =>
  Object.entries(obj)
    .map(([name, value]) => `  --${prefix}-${kebab(name)}: ${value};`)
    .join('\n');

const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

const flavor = palette =>
  [toVars(palette, 'ctp'), toVars(makeSemantic(palette), 'ctp-role')].join('\n\n');

const css = `/*
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source:    src/theme/catppuccin.js  (repo root, shared with the app)
 * Regenerate: npm run gen:theme
 * Verified by: npm run check:theme  (runs in CI; fails if this file is stale)
 *
 * Two layers, mirroring the source file:
 *   --ctp-*       raw Catppuccin palette names (mauve, base, subtext0, ...)
 *   --ctp-role-*  semantic roles (background, text, accent, danger, ...)
 *
 * Dark is Mocha (what the app ships). Light is Latte, the official light
 * flavor of the same palette — the app doesn't use it, but a docs site read on
 * a laptop should honor the OS preference.
 *
 * Starlight's own variables are mapped onto these in ./theme.css, which IS
 * hand-written. Edit that file, not this one.
 */

/* Mocha (dark) — also the :root default, matching Starlight's dark-first CSS. */
:root,
:root[data-theme='dark'] {
${flavor(mocha)}
}

/* Latte (light) */
:root[data-theme='light'] {
${flavor(latte)}
}

/*
 * OS preference fallback.
 *
 * Inside the docs, Starlight's theme script always stamps data-theme on :root,
 * so the blocks above are enough. The landing page renders outside that layout
 * and may have no data-theme at all — this makes it honor the OS setting.
 * Scoped with :not([data-theme]) so an explicit choice always wins.
 */
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
${flavor(latte)
  .split('\n')
  .map(line => (line ? `  ${line}` : line))
  .join('\n')}
  }
}
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, css, 'utf8');
console.log(`gen-theme-css: wrote ${OUT.replace(process.cwd() + '/', '')}`);
