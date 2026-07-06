import { c } from '../../theme/palette.js';
import { EXPAND } from '../../ui/icons.js';
import { makeCornerButton } from '../../ui/buttons.js';
import { copyText } from '../../ui/clipboard.js';
import { blockSelection } from '../../ui/events.js';
import { post } from '../../bridge.js';
import { updateAiMarker, deleteCardLine } from '../marker.js';
import { openCardOverlay } from '../overlay.js';

/**
 * The /view card: a live preview of a web page served by a localhost dev server
 * on the paired laptop. The header shows `localhost:PORT` and toggles the body;
 * the body embeds an <iframe> pointed at the laptop's plaintext preview proxy
 * (server/view.go), reached over the LAN. The iframe URL carries the bearer token
 * and is transient — it never lives in the document; RN refills it by id on every
 * mount via window.__viewUrl (see viewLiveField / viewFetcher). While it's being
 * fetched the card shows a loading line; a failed fetch shows the error instead.
 */
export function renderView(view, widget) {
  const obj = widget.obj;
  const open = obj.open !== false;
  const id = obj.id;
  const port = obj.port;
  const live = widget.live || {};
  const url = live.url || '';
  const error = live.error || '';
  const status = error ? 'error' : url ? 'ready' : live.status || 'loading';

  const card = document.createElement('div');
  card.className = 'cm-ask cm-view' + (status === 'error' ? ' cm-ask-error' : '');
  blockSelection(card);

  const head = document.createElement('div');
  head.className = 'cm-ask-head cm-view-head';

  const chev = document.createElement('span');
  chev.className = 'cm-ask-chev' + (open ? ' cm-open' : '');
  chev.textContent = '▶';
  head.appendChild(chev);

  const title = document.createElement('code');
  title.className = 'cm-view-title';
  title.textContent = 'localhost:' + port;
  head.appendChild(title);

  const badge = document.createElement('span');
  badge.className = 'cm-view-badge cm-view-badge-' + status;
  badge.textContent = status === 'ready' ? 'live' : status === 'error' ? 'error' : 'loading…';
  head.appendChild(badge);

  // Reload the embedded page in place. Cheaper than a token re-fetch (the URL is
  // stable for the session); if the frame isn't up yet, re-ask RN for the URL.
  const refresh = document.createElement('span');
  refresh.className = 'cm-view-refresh';
  refresh.textContent = '⟳';
  refresh.title = 'Reload';
  refresh.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
  });
  refresh.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const f = card._iframe;
    if (f) f.src = f.src;
    else post({ type: 'view', id, port });
  });
  head.appendChild(refresh);

  // Corner Expand — opens the full-page view (the same enlarged chrome as /run and
  // /code, with the page filling the screen); a long-press morphs it into Delete.
  // Arming Delete copies the `/view PORT` invocation so it's easy to re-drop later.
  head.appendChild(
    makeCornerButton({
      icon: EXPAND,
      label: 'Expand',
      holdTarget: card,
      onActivate: () => openCardOverlay(view, obj),
      onArm: () => copyText('/view ' + port),
      onDelete: () => deleteCardLine(view, card),
    }),
  );

  head.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
  });
  head.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    updateAiMarker(view, card, { open: !open });
  });
  card.appendChild(head);

  if (open) {
    const body = document.createElement('div');
    body.className = 'cm-ask-body cm-view-body';

    if (error) {
      const err = document.createElement('div');
      err.className = 'cm-view-error';
      err.textContent = error;
      body.appendChild(err);
    } else if (url) {
      const frame = document.createElement('iframe');
      frame.className = 'cm-view-frame';
      frame.src = url;
      frame.setAttribute('referrerpolicy', 'no-referrer');
      // The page is the user's own dev server, but sandbox it anyway so a stray
      // top-level navigation can't hijack the note editor; allow scripts/forms so
      // the app actually runs, and same-origin so its own XHR/assets work.
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups');
      body.appendChild(frame);
      card._iframe = frame;
    } else {
      const load = document.createElement('div');
      load.className = 'cm-view-loading';
      load.textContent = 'Loading localhost:' + port + '…';
      body.appendChild(load);
    }
    card.appendChild(body);
  }

  card._viewSig = { id, open, status, url };
  return card;
}

export const styles = {
  // Reuses the ask card shell (.cm-ask); the header shows the target port and a
  // status badge, the body embeds the live page in an iframe.
  '.cm-view-head': { gap: '8px' },
  '.cm-view-title': {
    flex: '1',
    minWidth: '0',
    color: c.blue,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '13px',
    fontWeight: '600',
    lineHeight: '1.4',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  '.cm-view-badge': {
    flexShrink: '0',
    fontSize: '11px',
    fontWeight: '600',
    color: c.overlay1,
    alignSelf: 'center',
  },
  '.cm-view-badge-ready': { color: c.green },
  '.cm-view-badge-error': { color: c.red },
  '.cm-view-refresh': {
    flexShrink: '0',
    color: c.subtext0,
    fontSize: '16px',
    lineHeight: '1',
    padding: '0 4px',
    cursor: 'pointer',
    userSelect: 'none',
  },
  '.cm-view-body': { padding: '10px 12px 12px 12px' },
  '.cm-view-frame': {
    width: '100%',
    height: '360px',
    border: `1px solid ${c.surface0}`,
    borderRadius: '8px',
    backgroundColor: '#ffffff',
  },
  '.cm-view-loading': {
    padding: '18px 4px',
    color: c.overlay1,
    fontSize: '13px',
  },
  '.cm-view-error': {
    padding: '14px 4px',
    color: c.red,
    fontSize: '13px',
    lineHeight: '1.45',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
};
