/**
 * Base-aware URL helper.
 *
 * The site is served from a sub-path (`/nest-note/` on GitHub Pages), so every
 * hand-written `href`/`src` must be prefixed with that base. Starlight prefixes
 * its own chrome (sidebar, pagination, search) automatically — but nothing we
 * write by hand gets that for free, and a bare `/introduction/` silently 404s
 * in production while working fine on a root-served dev server.
 *
 * Rule: **every `href` and `src` in `src/pages/` and `src/components/` goes
 * through `withBase()`.** No exceptions. Markdown files are exempt — they use
 * relative file links (`../server/flags.md`), which Astro rewrites at build.
 *
 * `import.meta.env.BASE_URL` is always trailing-slashed by Astro ('/nest-note/'),
 * or '/' when no base is configured — both are normalized here.
 */
const BASE = import.meta.env.BASE_URL;

export function withBase(pathname: string): string {
  const base = BASE.replace(/\/$/, '');
  const path = pathname.replace(/^\//, '');
  return path ? `${base}/${path}` : `${base}/`;
}
