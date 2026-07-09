import { WidgetType } from '@codemirror/view';
import { c } from '../../theme/palette.js';

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

export const styles = {
  '.cm-bullet': {
    color: c.text,
    // A slightly larger dot than the raw "-", nudged to sit on the baseline.
    fontSize: '1.1em',
    lineHeight: '1',
  },
};
