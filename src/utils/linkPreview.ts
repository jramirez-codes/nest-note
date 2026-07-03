/**
 * Fetches Open Graph / Twitter-card metadata for a URL so the editor can render
 * a rich "unfurled" link card (icon + title + description), like iMessage/Teams.
 *
 * This runs on the RN/native side on purpose: the CodeMirror editor lives in an
 * html-source WebView, which is a non-secure, null-origin context — a fetch from
 * there is blocked by CORS for essentially every real site. Native networking
 * has no such restriction, so we fetch + parse here and hand the result to the
 * WebView (see NoteEditorWebView → window.__setPreview).
 */

export interface LinkPreview {
  url: string;
  domain: string;
  title?: string;
  description?: string;
  /** Large preview image (og:image), absolute URL. */
  image?: string;
  /** Small site icon, absolute URL. */
  favicon?: string;
  /** True when the fetch/parse failed — the card falls back to just the domain. */
  error?: boolean;
}

// Previews don't change often; cache for the app session so re-opening a note
// (or scrolling a URL back into view) doesn't refetch.
const cache = new Map<string, LinkPreview>();

function domainOf(url: string): string {
  const m = /^https?:\/\/([^/]+)/i.exec(url);
  return m ? m[1].replace(/^www\./, '') : url;
}

function faviconFor(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Meta tags where property/name and content can appear in either order. */
function metaFor(prop: string): RegExp[] {
  return [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`,
      'i',
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`,
      'i',
    ),
  ];
}

function firstMatch(html: string, patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1] && m[1].trim()) return decodeEntities(m[1].trim());
  }
  return undefined;
}

// Resolve a possibly-relative asset URL against the page URL without depending
// on a URL polyfill (RN's `URL` support is spotty across engines).
function resolveUrl(base: string, ref?: string): string | undefined {
  if (!ref) return undefined;
  if (/^https?:\/\//i.test(ref)) return ref;
  if (ref.startsWith('//')) {
    const scheme = /^(https?):/i.exec(base);
    return `${scheme ? scheme[1] : 'https'}:${ref}`;
  }
  const m = /^(https?:\/\/[^/]+)(\/[^?#]*)?/i.exec(base);
  if (!m) return undefined;
  const origin = m[1];
  if (ref.startsWith('/')) return origin + ref;
  const path = m[2] || '/';
  return origin + path.slice(0, path.lastIndexOf('/') + 1) + ref;
}

export async function fetchLinkPreview(url: string): Promise<LinkPreview> {
  const cached = cache.get(url);
  if (cached) return cached;

  const domain = domainOf(url);
  let result: LinkPreview = { url, domain, favicon: faviconFor(domain) };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      // RN follows redirects by default; its RequestInit type omits `redirect`.
      signal: controller.signal,
      headers: {
        // Some sites only emit OG tags for a browser-ish UA.
        'User-Agent': 'Mozilla/5.0 (compatible; ainotepad-linkpreview)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timer);

    const finalUrl = res.url || url;
    // Cap the read — meta tags live in <head>, near the top.
    const html = (await res.text()).slice(0, 500_000);
    const finalDomain = domainOf(finalUrl);

    result = {
      url,
      domain: finalDomain,
      title:
        firstMatch(html, [...metaFor('og:title'), ...metaFor('twitter:title')]) ??
        firstMatch(html, [/<title[^>]*>([^<]*)<\/title>/i]),
      description: firstMatch(html, [
        ...metaFor('og:description'),
        ...metaFor('twitter:description'),
        ...metaFor('description'),
      ]),
      image: resolveUrl(
        finalUrl,
        firstMatch(html, [...metaFor('og:image'), ...metaFor('twitter:image')]),
      ),
      favicon: faviconFor(finalDomain),
    };
  } catch {
    result = { url, domain, favicon: faviconFor(domain), error: true };
  }

  cache.set(url, result);
  return result;
}
