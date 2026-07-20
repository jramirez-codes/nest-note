// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
import { remarkDocLinks } from './plugins/remark-doc-links.mjs';

const REPO = 'https://github.com/jramirez-codes/ai-notepad';
const BASE = '/ai-notepad';

export default defineConfig({
  // `site` is the ORIGIN ONLY — no path. `base` carries the path, with a
  // leading slash and no trailing one. Astro concatenates them.
  //
  // Putting the full URL (including /ai-notepad) in `site` is the classic
  // mistake here: it produces doubled canonical tags and sitemap entries that
  // look fine locally and 404 in production.
  //
  // Moving to a custom domain later = delete `base`, change `site`, add
  // `public/CNAME`. Safe by construction, because every internal link is
  // either relative (markdown) or goes through withBase() (components).
  site: 'https://jramirez-codes.github.io',
  base: BASE,

  // GitHub Pages serves directory-style URLs and redirects /foo -> /foo/.
  // Pinning this makes `astro preview` and production agree.
  trailingSlash: 'always',

  // Turns `[flags](../server/flags.md)` into `/ai-notepad/server/flags/`.
  // Astro does not rewrite markdown links itself, so without this the `.md`
  // leaks into the HTML and 404s. See the plugin's header for the rationale.
  markdown: {
    remarkPlugins: [[remarkDocLinks, { base: BASE }]],
  },

  integrations: [
    starlight({
      title: 'ainotepad',
      description:
        'A markdown notepad you flip through page by page. Live-preview markdown on your phone, with optional AI that runs on your own laptop.',
      logo: { src: './src/assets/logo.png', alt: 'ainotepad' },
      favicon: '/favicon.svg',
      customCss: [
        './src/styles/catppuccin.generated.css',
        './src/styles/theme.css',
      ],
      // Shiki bundles the Catppuccin themes, so code blocks track the site's
      // light/dark toggle using the same palette as the surrounding chrome.
      expressiveCode: {
        themes: ['catppuccin-mocha', 'catppuccin-latte'],
        styleOverrides: { borderRadius: '0.4rem' },
      },

      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/main/site/` },
      lastUpdated: true,
      // Left strict on purpose. remarkDocLinks has already converted authored
      // `../foo.md` links into real routes by the time this runs, so anything
      // still relative here is a mistake, and any bad target is a build error.
      plugins: [starlightLinksValidator()],

      // Explicit order for the first three groups: the reading order below is
      // pedagogical (what you do first, then the server, then its commands).
      // Alphabetical autogeneration would scramble that. The last three groups
      // are reference material where order is genuinely arbitrary, so they
      // autogenerate and pick up new pages with zero config.
      sidebar: [
        { label: 'Introduction', link: '/introduction/' },
        {
          label: 'Get started',
          items: [
            { label: 'Install & run', link: '/start/install/' },
            { label: 'Using the pad', link: '/start/the-pad/' },
            { label: 'Rebuilding the editor', link: '/start/editor-bundle/' },
          ],
        },
        {
          label: 'Companion server',
          items: [
            { label: 'Setup', link: '/server/setup/' },
            { label: 'Pairing', link: '/server/pairing/' },
            { label: 'Security model', link: '/server/security/' },
            { label: 'Remote access', link: '/server/remote-access/' },
            { label: 'Native setup', link: '/server/native-setup/' },
            { label: 'Flags reference', link: '/server/flags/' },
          ],
        },
        {
          label: 'Slash commands',
          items: [{ autogenerate: { directory: 'commands' } }],
        },
        {
          label: 'Architecture',
          items: [{ autogenerate: { directory: 'architecture' } }],
        },
        {
          label: 'Contributing',
          items: [{ autogenerate: { directory: 'contributing' } }],
        },
      ],
    }),
  ],
});
