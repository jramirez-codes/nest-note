import { EditorView } from '@codemirror/view';
import { post } from '../bridge.js';

// A tap on a rendered link hands the URL to RN (which opens the system browser);
// the WebView must not navigate itself, and we swallow the tap so the caret
// doesn't jump into the link. Any element carrying a data-url participates.
//
// We handle BOTH mousedown and click. In the editable note, mousedown fires and
// preventDefault keeps the caret from jumping into the link. But the /ask answer
// view is contenteditable=false, and mobile WebViews don't reliably fire
// mousedown on non-editable content — so tapping an answer link needs the click
// path too. A short dedupe stops the editable view from opening the URL twice
// when both fire for the same tap.
let lastUrl = null;
let lastAt = 0;

function handleTap(e, view) {
  let el = e.target;
  while (el && el !== view.dom) {
    // A wikilink (`[[slug::title]]` or bare `[[title]]`) navigates to an internal
    // subject page rather than opening a URL — RN handles `openPage`. Checked
    // first since a wikilink title carries data-page-title, not data-url. `slug`
    // is empty for a bare title, which RN resolves within the current notebook.
    if (el.dataset && el.dataset.pageTitle != null) {
      const slug = el.dataset.page || '';
      const title = el.dataset.pageTitle;
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      // Collapse the mousedown+click pair (or a stray double-tap) for one target.
      const key = slug || title;
      if (key === lastUrl && now - lastAt < 700) return true;
      lastUrl = key;
      lastAt = now;
      post({ type: 'openPage', slug, title });
      return true;
    }
    if (el.dataset && el.dataset.url) {
      const url = el.dataset.url;
      e.preventDefault();
      // Stop here so a tap inside a nested answer view doesn't also bubble to
      // the main editor's handler and open the URL twice.
      e.stopPropagation();
      const now = Date.now();
      // Collapse the mousedown+click pair (or a stray double-tap) for one URL.
      if (url === lastUrl && now - lastAt < 700) return true;
      lastUrl = url;
      lastAt = now;
      post({ type: 'openUrl', url });
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

export const openLinks = EditorView.domEventHandlers({
  mousedown: handleTap,
  click: handleTap,
});
