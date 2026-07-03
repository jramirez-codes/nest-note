import { WidgetType } from '@codemirror/view';
import { makeCopyButton, makeCardActionButton } from './buttons.js';
import { post } from './bridge.js';
import { deleteCardLine } from './aiMarker.js';
import { domainFromUrl, faviconFor } from './urls.js';

/**
 * Interactive task-list checkbox. Replaces the `[ ]`/`[x]` marker; a tap toggles
 * the underlying markdown. The live position is resolved at tap time via
 * posAtDOM so the toggle stays correct even as text above shifts.
 */
export class CheckboxWidget extends WidgetType {
  constructor(checked) {
    super();
    this.checked = checked;
  }
  eq(other) {
    return other.checked === this.checked;
  }
  toDOM(view) {
    const box = document.createElement('span');
    box.className = 'cm-task' + (this.checked ? ' cm-task-done' : '');
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(this.checked));
    box.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      const pos = view.posAtDOM(box);
      const cur = view.state.doc.sliceString(pos, pos + 3);
      if (!/^\[[ xX]\]$/.test(cur)) return;
      view.dispatch({
        changes: { from: pos, to: pos + 3, insert: cur === '[ ]' ? '[x]' : '[ ]' },
      });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

/** Renders an unordered-list marker (`-`/`*`/`+`) as a real "•" bullet. */
export class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const b = document.createElement('span');
    b.className = 'cm-bullet';
    b.textContent = '•';
    return b;
  }
  ignoreEvent() {
    return true;
  }
}

/** Claude-style "Copy" button pinned to the top-right of a fenced code card. */
export class CopyButtonWidget extends WidgetType {
  constructor(code) {
    super();
    this.code = code;
  }
  eq(other) {
    return other.code === this.code;
  }
  toDOM() {
    return makeCopyButton(this.code);
  }
  ignoreEvent() {
    return true;
  }
}

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
