import { WidgetType } from '@codemirror/view';
import { makeCopyButton } from '../../ui/buttons.js';

/**
 * Claude-style "Copy" button pinned to a fenced code card. Styling for the
 * button itself lives with makeCopyButton (ui/buttons); the code card positions
 * it via `.cm-code-first .cm-copy-btn` (markdown/codeBlocks).
 */
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
