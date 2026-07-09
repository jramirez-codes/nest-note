import { WidgetType } from '@codemirror/view';
import { c } from '../../theme/palette.js';

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

export const styles = {
  '.cm-task': {
    display: 'inline-block',
    width: '1.05em',
    height: '1.05em',
    verticalAlign: '-0.18em',
    marginRight: '0.3em',
    borderRadius: '5px',
    border: `2px solid ${c.overlay1}`,
    boxSizing: 'border-box',
    cursor: 'pointer',
    position: 'relative',
  },
  '.cm-task.cm-task-done': {
    backgroundColor: c.green,
    borderColor: c.green,
  },
  // The check mark, drawn with a rotated border so no font/icon is needed.
  '.cm-task.cm-task-done::after': {
    content: '""',
    position: 'absolute',
    left: '0.28em',
    top: '0.06em',
    width: '0.22em',
    height: '0.5em',
    border: `solid ${c.crust}`,
    borderWidth: '0 0.14em 0.14em 0',
    transform: 'rotate(43deg)',
  },
  // A completed task line: strike through all its text. The checkbox itself is
  // an inline-block box, so line-through doesn't cross it — only the text.
  '.cm-task-done-line': {
    textDecoration: 'line-through',
    textDecorationColor: c.overlay1,
    color: c.subtext0,
  },
};
