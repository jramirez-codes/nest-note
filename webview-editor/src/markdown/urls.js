import { syntaxTree } from '@codemirror/language';

export function domainFromUrl(url) {
  const m = /^https?:\/\/([^/]+)/i.exec(url);
  return m ? m[1].replace(/^www\./, '') : url;
}
export function faviconFor(domain) {
  return (
    'https://www.google.com/s2/favicons?domain=' +
    encodeURIComponent(domain) +
    '&sz=64'
  );
}

// A bare URL is treated as an image when its path ends in a known image
// extension (query string / hash allowed after it), e.g.
//   https://study.com/cimages/videopreview/7m7z42z3x3.jpg
const IMAGE_URL_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|apng|ico)(?:[?#][^\s]*)?$/i;
export function isImageUrl(url) {
  return IMAGE_URL_RE.test(url);
}

// The alt text of a markdown image `![alt](url)`.
export function imageAlt(raw) {
  const m = /^!\[([^\]]*)\]/.exec(raw);
  return m ? m[1] : '';
}

/**
 * A "pasted link" is a bare URL alone on its line — that's what we unfurl into a
 * card (a URL inside prose stays an inline link). Yields the card-worthy URLs.
 */
export function eachCardUrl(state, fn) {
  syntaxTree(state).iterate({
    enter: node => {
      if (node.name !== 'URL') return;
      const parent = node.node.parent;
      if (parent && (parent.name === 'Link' || parent.name === 'Autolink' || parent.name === 'Image')) return;
      const line = state.doc.lineAt(node.from);
      const url = state.doc.sliceString(node.from, node.to);
      if (line.text.trim() !== url) return;
      // Image URLs render as the image itself (see eachBlockImage), not a card.
      if (isImageUrl(url)) return;
      fn(url, line);
    },
  });
}

/**
 * An image alone on its line — either a bare image URL or a markdown
 * `![alt](url)` — which we render as a block image. Yields (url, alt, line).
 */
export function eachBlockImage(state, fn) {
  syntaxTree(state).iterate({
    enter: node => {
      if (node.name === 'Image') {
        const raw = state.doc.sliceString(node.from, node.to);
        const line = state.doc.lineAt(node.from);
        if (line.text.trim() !== raw) return; // inline image — handled elsewhere
        const urlNode = node.node.getChild('URL');
        if (!urlNode) return;
        const url = state.doc.sliceString(urlNode.from, urlNode.to);
        fn(url, imageAlt(raw), line);
        return;
      }
      if (node.name === 'URL') {
        const parent = node.node.parent;
        if (parent && (parent.name === 'Link' || parent.name === 'Autolink' || parent.name === 'Image')) return;
        const url = state.doc.sliceString(node.from, node.to);
        if (!isImageUrl(url)) return;
        const line = state.doc.lineAt(node.from);
        if (line.text.trim() !== url) return;
        fn(url, '', line);
      }
    },
  });
}
