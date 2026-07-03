import { EditorView } from '@codemirror/view';
import { post } from './bridge.js';

// A tap on a rendered link hands the URL to RN (which opens the system browser);
// the WebView must not navigate itself, and we swallow the tap so the caret
// doesn't jump into the link. Any element carrying a data-url participates.
export const openLinks = EditorView.domEventHandlers({
  mousedown(e, view) {
    let el = e.target;
    while (el && el !== view.dom) {
      if (el.dataset && el.dataset.url) {
        post({ type: 'openUrl', url: el.dataset.url });
        e.preventDefault();
        // Stop here so a tap inside a nested answer view doesn't also bubble to
        // the main editor's handler and open the URL twice.
        e.stopPropagation();
        return true;
      }
      el = el.parentElement;
    }
    return false;
  },
});
