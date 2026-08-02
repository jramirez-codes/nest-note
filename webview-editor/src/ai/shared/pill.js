import { c } from '../../theme/palette.js';

/**
 * The header chip worn by the cards that name a persistent context — /code's
 * project, /talk's subject, /run's project folder — plus their full-page
 * overlays. One builder and one sizing rule, so a 40-character project name
 * can't grow the chip: it ellipsizes and the status badge + Expand button on
 * the far side of the header stay put.
 *
 * `icon` is either SVG markup or a bare glyph (e.g. "✦"); `className` carries a
 * per-card tweak (colour, scale) on top of the shared `.cm-pill` sizing.
 */
export function makePill({ icon, label, title, className }) {
  const pill = document.createElement('span');
  pill.className = className ? 'cm-pill ' + className : 'cm-pill';

  if (icon) {
    const ic = document.createElement('span');
    ic.className = 'cm-pill-icon';
    if (icon.startsWith('<')) ic.innerHTML = icon;
    else ic.textContent = icon;
    pill.appendChild(ic);
  }

  const text = document.createElement('span');
  text.className = 'cm-pill-label';
  text.textContent = label || '';
  pill.appendChild(text);

  if (title) pill.title = title;
  return pill;
}

export const styles = {
  '.cm-pill': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    // Shrinkable (not flex-shrink: 0) so the chip is what gives up width when the
    // header runs out: without this a long label pushed the badge and the corner
    // Expand button past the card edge, where they were clipped.
    flex: '0 1 auto',
    minWidth: '0',
    // A fixed cap rather than a % of the header — every chip reads the same size
    // at rest, and the trailing controls keep their room however narrow the card
    // gets. In em, so the overlay's scaled-up chip caps proportionally.
    maxWidth: '12em',
    padding: '2px 9px',
    borderRadius: '7px',
    backgroundColor: c.surface0,
    border: `1px solid ${c.surface1}`,
    color: c.mauve,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '12px',
    fontWeight: '600',
    lineHeight: '1.5',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  },
  '.cm-pill-icon': { display: 'block', flexShrink: '0' },
  '.cm-pill-icon svg': { display: 'block', width: '13px', height: '13px' },
  // The label is the only part that shrinks; its own overflow:hidden is what lets
  // it fall below its content width so the ellipsis appears.
  '.cm-pill-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
};
