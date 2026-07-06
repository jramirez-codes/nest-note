import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { c } from './palette.js';

// How markdown tokens (and nested code) are painted. Syntax marks (#, *, `) are
// dimmed like Obsidian; headings are larger and bold; code tokens get the full
// Catppuccin palette so fenced blocks read like a real editor.
export const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.8em', fontWeight: 'bold', color: c.text },
  { tag: t.heading2, fontSize: '1.5em', fontWeight: 'bold', color: c.text },
  { tag: t.heading3, fontSize: '1.25em', fontWeight: 'bold', color: c.text },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: 'bold', color: c.text },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: c.blue, textDecoration: 'underline' },
  { tag: t.url, color: c.blue },
  { tag: [t.monospace], color: c.green },
  { tag: t.quote, color: c.subtext0 },
  { tag: t.list, color: c.text },
  // The literal syntax punctuation (#, *, -, `, >) — dimmed.
  { tag: [t.processingInstruction, t.meta], color: c.overlay1 },

  // Code tokens inside fenced blocks (js/ts/css/html).
  { tag: [t.keyword, t.modifier], color: c.mauve },
  { tag: [t.controlKeyword, t.operatorKeyword], color: c.mauve },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: c.blue },
  { tag: [t.string, t.special(t.string), t.regexp], color: c.green },
  { tag: [t.number, t.bool, t.null, t.atom], color: c.peach },
  { tag: [t.comment, t.lineComment, t.blockComment], color: c.overlay1, fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace], color: c.yellow },
  { tag: [t.propertyName, t.attributeName], color: c.teal },
  { tag: [t.tagName], color: c.blue },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: c.subtext0 },
  { tag: [t.variableName, t.definition(t.variableName)], color: c.text },
  { tag: t.escape, color: c.peach },
]);
