import { WidgetType } from '@codemirror/view';
import { c } from '../../theme/palette.js';
import { makeCardActionButton } from '../../ui/buttons.js';
import { post } from '../../bridge.js';
import { deleteCardLine } from '../../ai/marker.js';

/**
 * A rendered image — either a bare image URL pasted on its own line or a
 * markdown `![alt](url)`. Block variant sits on its own line; inline variant is
 * used for an image embedded mid-prose. Tapping opens the source in the browser;
 * a load failure falls back to showing the alt text / URL.
 */
export class ImageWidget extends WidgetType {
  constructor(url, alt, block) {
    super();
    this.url = url;
    this.alt = alt || '';
    this.block = block;
  }
  eq(other) {
    return other.url === this.url && other.alt === this.alt && other.block === this.block;
  }
  toDOM(view) {
    const wrap = document.createElement(this.block ? 'div' : 'span');
    wrap.className = this.block ? 'cm-image-block' : 'cm-image-inline';
    wrap.setAttribute('data-url', this.url);

    const img = document.createElement('img');
    img.className = 'cm-image-img';
    img.src = this.url;
    if (this.alt) img.alt = this.alt;
    img.addEventListener('error', () => {
      wrap.classList.add('cm-image-broken');
      wrap.textContent = this.alt || this.url;
    });
    wrap.appendChild(img);

    // Block images (a pasted URL on its own line) get the Copy-URL button that
    // long-presses into Delete, matching the /ask and link cards.
    if (this.block) {
      wrap.appendChild(
        makeCardActionButton({
          copyValue: this.url,
          onDelete: () => deleteCardLine(view, wrap),
          holdTarget: wrap,
        }),
      );
    }

    // Own the tap so it opens the image instead of moving the caret into it.
    wrap.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
    });
    wrap.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      post({ type: 'openUrl', url: this.url });
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

export const styles = {
  '.cm-image-block': {
    position: 'relative',
    display: 'block',
    width: 'fit-content',
    maxWidth: '100%',
    margin: '8px 0',
    cursor: 'pointer',
    WebkitTouchCallout: 'none',
  },
  '.cm-image-block .cm-image-img': {
    display: 'block',
    maxWidth: '100%',
    maxHeight: '420px',
    borderRadius: '10px',
    border: `1px solid ${c.surface0}`,
    objectFit: 'contain',
    backgroundColor: c.mantle,
  },
  '.cm-image-inline': {
    display: 'inline-block',
    verticalAlign: 'middle',
    cursor: 'pointer',
  },
  '.cm-image-inline .cm-image-img': {
    maxWidth: '100%',
    maxHeight: '260px',
    borderRadius: '6px',
  },
  '.cm-image-broken': {
    color: c.subtext0,
    fontStyle: 'italic',
  },
};
