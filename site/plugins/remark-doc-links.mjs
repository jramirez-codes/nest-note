/**
 * Rewrite relative markdown links to real, base-prefixed routes.
 *
 * WHY
 * ---
 * The site is served from a sub-path (`/nest-note/`), so links must carry
 * that base. Three obvious approaches all fail:
 *
 *   1. `[x](/server/flags/)`          — 404s in production; the base is missing.
 *   2. `[x](/nest-note/server/flags/)` — works, but hardcodes the base in every
 *      page, so moving to a custom domain becomes a 40-file find-and-replace.
 *   3. `[x](../server/flags.md)`      — Astro does NOT rewrite these (there is
 *      no markdown-link rewriting in Astro 7), so the `.md` leaks into the
 *      emitted HTML and the link 404s.
 *
 * So we do it ourselves. Authors write option 3 — a relative link to the actual
 * file on disk, which editors can follow and which is obviously correct when
 * reading the source — and this plugin turns it into a base-prefixed route at
 * build time.
 *
 * Because the output is a real route, `starlight-links-validator` can stay
 * strict: a typo'd target produces a hard build error rather than a silent 404.
 *
 * Handles `#anchors` and `index.md*` (which maps to the directory route).
 */
import { relative, resolve, dirname, sep } from 'node:path';

const DOCS_ROOT = resolve(import.meta.dirname, '../src/content/docs');

/** '/nest-note' -> '/nest-note'; '/' or '' -> '' */
function normalizeBase(base) {
  if (!base || base === '/') return '';
  return base.startsWith('/') ? base.replace(/\/$/, '') : `/${base.replace(/\/$/, '')}`;
}

export function remarkDocLinks({ base = '' } = {}) {
  const prefix = normalizeBase(base);

  return function transformer(tree, file) {
    const fromDir = dirname(file.path ?? file.history?.[0] ?? '');

    visit(tree, node => {
      if (node.type !== 'link' || typeof node.url !== 'string') return;

      const url = node.url;
      // Only touch relative links that point at a markdown file.
      if (!/^\.{1,2}\//.test(url)) return;
      const [target, hash] = url.split('#');
      if (!/\.mdx?$/.test(target)) return;

      const abs = resolve(fromDir, target);
      let slug = relative(DOCS_ROOT, abs)
        .split(sep)
        .join('/')
        .replace(/\.mdx?$/, '');

      // `commands/index` is the route `commands/`.
      slug = slug.replace(/(^|\/)index$/, '');

      const route = slug ? `${prefix}/${slug}/` : `${prefix}/`;
      node.url = hash ? `${route}#${hash}` : route;
    });
  };
}

/** Minimal depth-first visitor — avoids a dependency on `unist-util-visit`. */
function visit(node, fn) {
  fn(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) visit(child, fn);
  }
}

export default remarkDocLinks;
