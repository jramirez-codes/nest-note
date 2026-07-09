import { WidgetType } from '@codemirror/view';
import { c } from '../../theme/palette.js';
import { makeCardActionButton } from '../../ui/buttons.js';
import { post } from '../../bridge.js';
import { deleteCardLine } from '../../ai/marker.js';
import { domainFromUrl, faviconFor } from '../urls.js';

// The rich card rendered beneath a pasted link.
export class LinkCardWidget extends WidgetType {
  constructor(url, data) {
    super();
    this.url = url;
    this.data = data;
  }
  get sig() {
    const d = this.data;
    if (!d) return this.url + '|loading';
    return this.url + '|' + (d.error ? 'e' : '') + (d.title || '') + (d.image || '') + (d.description || '');
  }
  eq(other) {
    return other.sig === this.sig;
  }
  toDOM(view) {
    const d = this.data;
    const domain = d ? d.domain : domainFromUrl(this.url);
    const card = document.createElement('div');
    card.className = 'cm-linkcard';
    card.setAttribute('data-url', this.url);

    if (d && d.image) {
      const img = document.createElement('img');
      img.className = 'cm-linkcard-img';
      img.src = d.image;
      img.addEventListener('error', () => img.remove());
      card.appendChild(img);
    }

    const body = document.createElement('div');
    body.className = 'cm-linkcard-body';

    const title = document.createElement('div');
    title.className = 'cm-linkcard-title';
    title.textContent = d && d.title ? d.title : d && d.error ? domain : 'Loading preview…';
    body.appendChild(title);

    if (d && d.description) {
      const desc = document.createElement('div');
      desc.className = 'cm-linkcard-desc';
      desc.textContent = d.description;
      body.appendChild(desc);
    }

    const dom = document.createElement('div');
    dom.className = 'cm-linkcard-domain';
    const fav = document.createElement('img');
    fav.className = 'cm-linkcard-favicon';
    fav.src = (d && d.favicon) || faviconFor(domain);
    fav.addEventListener('error', () => fav.remove());
    dom.appendChild(fav);
    const dl = document.createElement('span');
    dl.textContent = domain;
    dom.appendChild(dl);
    body.appendChild(dom);

    card.appendChild(body);

    // Copy the URL from the top-right button; long-pressing the card turns it
    // into a Delete button that removes the link line.
    card.appendChild(
      makeCardActionButton({
        copyValue: this.url,
        onDelete: () => deleteCardLine(view, card),
        holdTarget: card,
      }),
    );

    // Own the tap so it opens instead of moving the caret into the widget.
    card.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
    });
    card.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      post({ type: 'openUrl', url: this.url });
    });
    return card;
  }
  ignoreEvent() {
    return true;
  }
}

export const styles = {
  '.cm-linkcard': {
    position: 'relative',
    display: 'flex',
    margin: '8px 0',
    border: `1px solid ${c.surface0}`,
    borderRadius: '12px',
    overflow: 'hidden',
    backgroundColor: c.mantle,
    cursor: 'pointer',
    maxWidth: '520px',
    WebkitTouchCallout: 'none',
  },
  '.cm-linkcard-img': {
    width: '104px',
    minWidth: '104px',
    objectFit: 'cover',
    backgroundColor: c.surface0,
  },
  '.cm-linkcard-body': {
    flex: '1',
    minWidth: '0',
    // Extra right padding reserves room for the copy button.
    padding: '10px 48px 10px 13px',
    fontFamily: '-apple-system, Roboto, sans-serif',
  },
  '.cm-linkcard-title': {
    color: c.text,
    fontSize: '15px',
    fontWeight: '600',
    lineHeight: '1.3',
    display: '-webkit-box',
    '-webkit-line-clamp': '2',
    '-webkit-box-orient': 'vertical',
    overflow: 'hidden',
  },
  '.cm-linkcard-desc': {
    color: c.subtext0,
    fontSize: '13px',
    lineHeight: '1.35',
    marginTop: '3px',
    display: '-webkit-box',
    '-webkit-line-clamp': '2',
    '-webkit-box-orient': 'vertical',
    overflow: 'hidden',
  },
  '.cm-linkcard-domain': {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginTop: '8px',
    color: c.overlay1,
    fontSize: '12px',
  },
  '.cm-linkcard-favicon': {
    width: '15px',
    height: '15px',
    borderRadius: '3px',
    flexShrink: '0',
  },
};
