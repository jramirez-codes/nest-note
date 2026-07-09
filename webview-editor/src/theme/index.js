import { EditorView } from '@codemirror/view';
import { chrome, answerChrome } from './chrome.js';

// Component style fragments, each co-located with the component it styles and
// pulled together here. Selectors are unique across fragments, so the merge order
// isn't load-bearing — it mirrors the original single-file order to keep the
// generated CSS diffable.
import { styles as buttonStyles } from '../ui/buttons.js';
import { styles as checkboxStyles } from '../markdown/widgets/checkbox.js';
import { styles as bulletStyles } from '../markdown/widgets/bullet.js';
import { styles as codeBlockStyles } from '../markdown/codeBlocks.js';
import { styles as inlineStyles } from '../markdown/livePreview.js';
import { styles as linkCardStyles } from '../markdown/widgets/linkCard.js';
import { styles as imageStyles } from '../markdown/widgets/image.js';
import { styles as blockquoteStyles } from '../markdown/blockquotes.js';
import { styles as cardShellStyles } from '../ai/cards/AiCardWidget.js';
import { styles as askStyles } from '../ai/cards/ask.js';
import { styles as chatStyles } from '../ai/cards/chat.js';
import { styles as pairStyles } from '../ai/cards/pair.js';
import { styles as cleanStyles } from '../ai/cards/clean.js';
import { styles as recordStyles } from '../ai/cards/record.js';
import { styles as badgeStyles } from '../ai/shared/badge.js';
import { styles as runStyles } from '../ai/cards/run.js';
import { styles as transcriptStyles } from '../ai/shared/transcript.js';
import { styles as codeViewStyles } from '../ai/shared/codeView.js';
import { styles as codeStyles } from '../ai/cards/code.js';
import { styles as viewStyles } from '../ai/cards/view.js';
import { styles as overlayStyles } from '../ai/overlay.js';
import { styles as commandStyles } from '../ai/commands.js';

export { highlight } from './highlight.js';

const components = {
  ...buttonStyles,
  ...checkboxStyles,
  ...bulletStyles,
  ...codeBlockStyles,
  ...inlineStyles,
  ...linkCardStyles,
  ...imageStyles,
  ...blockquoteStyles,
  ...cardShellStyles,
  ...askStyles,
  ...chatStyles,
  ...pairStyles,
  ...cleanStyles,
  ...recordStyles,
  ...badgeStyles,
  ...runStyles,
  ...transcriptStyles,
  ...codeViewStyles,
  ...codeStyles,
  ...viewStyles,
  ...overlayStyles,
  ...commandStyles,
};

// The main note editor theme, and the read-only answer-view theme (used by the
// nested markdown views inside /ask, /chat and /code) — same components, different
// chrome. Both dark.
export const theme = EditorView.theme({ ...chrome, ...components }, { dark: true });
export const answerTheme = EditorView.theme({ ...answerChrome, ...components }, { dark: true });
