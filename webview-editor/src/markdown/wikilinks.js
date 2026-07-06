import { tags as t } from '@lezer/highlight';

// Obsidian-style internal links. Two forms:
//   `[[slug::PAGE TITLE]]` — explicit slug (the stable id of the target subject
//                            page) plus the human label shown in the note.
//   `[[PAGE TITLE]]`       — a bare title, resolved to the same-titled page in
//                            the CURRENT notebook (no slug).
// A bare slug is NOT allowed: a `slug::` prefix must be followed by a title, so
// `[[slug::]]` isn't recognized as a wikilink.
//
// We teach the Lezer markdown parser a new inline node type so `[[…]]` shows up
// in the syntax tree (like Strikethrough / Table do). buildLivePreview then hides
// the brackets/slug and renders the title as a tappable link (see livePreview.js).
//
// Node shape (children, in document order):
//   WikiLink
//     WikiLinkMark   "[["
//     WikiLinkSlug    slug            (omitted when there's no "::")
//     WikiLinkMark   "::"            (omitted when there's no "::")
//     WikiLinkTitle   PAGE TITLE      (the whole inner text when there's no "::")
//     WikiLinkMark   "]]"

const OPEN = 91; /* '[' */
const CLOSE = 93; /* ']' */

/**
 * @type {import('@lezer/markdown').MarkdownConfig}
 */
export const WikiLink = {
  defineNodes: [
    { name: 'WikiLink', style: t.link },
    { name: 'WikiLinkMark', style: t.processingInstruction },
    { name: 'WikiLinkSlug', style: t.labelName },
    { name: 'WikiLinkTitle', style: t.link },
  ],
  parseInline: [
    {
      name: 'WikiLink',
      // Run before the stock Link parser so it doesn't claim the leading `[` as
      // an ordinary link-start delimiter.
      before: 'Link',
      parse(cx, next, pos) {
        // Must open with exactly `[[`.
        if (next !== OPEN || cx.char(pos + 1) !== OPEN) return -1;

        const innerStart = pos + 2;
        // Scan for the closing `]]`, staying on this inline section. Bail on any
        // stray bracket so a malformed `[[a]b]]` doesn't get mis-parsed.
        let i = innerStart;
        let contentTo = -1;
        while (i < cx.end) {
          const c = cx.char(i);
          if (c === CLOSE) {
            if (cx.char(i + 1) === CLOSE) {
              contentTo = i;
              break;
            }
            return -1; // a single `]` inside — not a wikilink
          }
          if (c === OPEN) return -1; // a stray `[` inside — not a wikilink
          i++;
        }
        if (contentTo < 0 || contentTo === innerStart) return -1; // no close, or empty `[[]]`

        const closeTo = contentTo + 2;
        const inner = cx.slice(innerStart, contentTo);

        const children = [cx.elt('WikiLinkMark', pos, innerStart)];
        // Split slug from title on the first `::`.
        const sep = inner.indexOf('::');
        if (sep > 0) {
          // `slug::title` — a slug MUST carry a title (no bare slugs). Reject
          // `[[slug::]]` so it isn't parsed as a wikilink at all.
          const sepAt = innerStart + sep;
          if (sepAt + 2 >= contentTo) return -1;
          children.push(cx.elt('WikiLinkSlug', innerStart, sepAt));
          children.push(cx.elt('WikiLinkMark', sepAt, sepAt + 2));
          children.push(cx.elt('WikiLinkTitle', sepAt + 2, contentTo));
        } else {
          // No `::` — the whole inner text is a bare page title, resolved within
          // the current notebook.
          children.push(cx.elt('WikiLinkTitle', innerStart, contentTo));
        }
        children.push(cx.elt('WikiLinkMark', contentTo, closeTo));

        return cx.addElement(cx.elt('WikiLink', pos, closeTo, children));
      },
    },
  ],
};
