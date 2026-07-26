import React, { useMemo } from 'react';
import { Linking, Platform, StyleSheet, Text, View, type TextStyle } from 'react-native';
import { Check } from 'lucide-react-native';
import { mocha } from '../../theme/catppuccin';

interface ChatMarkdownProps {
  /** Claude's reply, as Markdown. */
  text: string;
}

/**
 * Claude's Markdown, rendered the way the editor renders it.
 *
 * Answers arriving from the server are Markdown, and everywhere else in the app
 * that Markdown is *drawn* — the pad, and the read-only answer views inside
 * `/ask` and `/chat` cards — it goes through the WebView editor's widgets
 * (`webview-editor/src/markdown/widgets`). Cards in React Native have no
 * CodeMirror to lean on, so this is the same rendering re-expressed in RN views:
 * a list marker is a real "•", a task marker is a real checkbox, fenced code is
 * a rounded recessed card, a link is blue and opens on tap.
 *
 * It is deliberately a mirror, not an interpretation — the sizes and colors below
 * are the widgets' own CSS resolved against the answer view's 14px/1.5 base
 * (`theme/chrome.js`'s `answerChrome`), so an idea's chat reads exactly like the
 * same text would inside an `/ask` card. Where the two differ: prose keeps the
 * card's `text` color rather than the answer view's dimmer `subtext0` (the reply
 * *is* the card's content here, not a footnote under a question), and code isn't
 * syntax-highlighted — there's no Lezer parser on this side.
 *
 * Read-only by nature: checkboxes render their state but don't toggle. Nothing
 * here owns a document to write back to — Claude owns the card.
 */
export default function ChatMarkdown({ text }: ChatMarkdownProps) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <View>{blocks.map((b, i) => renderBlock(b, i))}</View>;
}

/** The answer view's base type: 14px at line-height 1.5 (`answerChrome`). Every
 *  size below is this scale's em value resolved, as the widgets' CSS is. */
const FONT = 14;
const LEADING = 21;

/** `ui-monospace, …, monospace` from the widget CSS, per platform. */
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** Heading scale from `theme/highlight.js` (1.8/1.5/1.25em, then plain bold). */
const HEADING = [1.8, 1.5, 1.25, 1, 1, 1];

/** One level of list nesting, as `markdown/listIndent.js` insets a wrapped list. */
const INDENT = 14;

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

type Block =
  | { kind: 'code'; lines: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'task'; done: boolean; text: string; indent: number }
  | { kind: 'bullet'; text: string; indent: number }
  | { kind: 'ordered'; marker: string; text: string; indent: number }
  | { kind: 'text'; text: string }
  | { kind: 'blank' };

const FENCE = /^\s*```/;
const QUOTE = /^\s*>\s?(.*)$/;
const HEAD = /^(#{1,6})\s+(.*)$/;
const TASK = /^(\s*)[-*+]\s+\[([ xX])\]\s*(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+[.)])\s+(.*)$/;

/** Two spaces per nesting level, as the editor's list indentation reads them. */
const depthOf = (spaces: string) => Math.min(4, Math.floor(spaces.length / 2));

/**
 * Split the reply into the block shapes the editor decorates line by line. Like
 * the editor this is line-oriented — a hard-wrapped paragraph keeps its breaks
 * rather than being reflowed — so what Claude wrote is what's shown.
 */
function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code, to the closing fence or the end of an answer still streaming.
    if (FENCE.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      out.push({ kind: 'code', lines: body });
      continue;
    }

    // Consecutive `>` lines are one quote, so the accent bar runs unbroken.
    const quote = line.match(QUOTE);
    if (quote) {
      const body = [quote[1]];
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1])) {
        body.push(lines[++i].match(QUOTE)![1]);
      }
      out.push({ kind: 'quote', lines: body });
      continue;
    }

    if (!line.trim()) {
      // One empty line's worth of air, however many were typed.
      if (out[out.length - 1]?.kind !== 'blank') out.push({ kind: 'blank' });
      continue;
    }

    const head = line.match(HEAD);
    if (head) {
      out.push({ kind: 'heading', level: head[1].length, text: head[2] });
      continue;
    }

    // Tasks before bullets: `- [x] …` is both, and the checkbox wins.
    const task = line.match(TASK);
    if (task) {
      out.push({
        kind: 'task',
        done: task[2] !== ' ',
        text: task[3],
        indent: depthOf(task[1]),
      });
      continue;
    }

    const bullet = line.match(BULLET);
    if (bullet) {
      out.push({ kind: 'bullet', text: bullet[2], indent: depthOf(bullet[1]) });
      continue;
    }

    const ordered = line.match(ORDERED);
    if (ordered) {
      out.push({
        kind: 'ordered',
        marker: ordered[2],
        text: ordered[3],
        indent: depthOf(ordered[1]),
      });
      continue;
    }

    out.push({ kind: 'text', text: line });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Inline marks
// ---------------------------------------------------------------------------

interface Mark {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  /** Set on a link; tapping the span opens it. */
  url?: string;
  /** A `[[wikilink]]` — internal navigation, so mauve rather than blue. */
  wiki?: boolean;
}

type Span = Mark & { text: string };

// Tried left to right at each position, so `**bold**` beats `*italic*` and
// `[[wiki]]` beats `[text](url)`.
const INLINE = new RegExp(
  [
    '`([^`\\n]+)`', // 1  `code`
    '\\*\\*([^\\n]+?)\\*\\*', // 2  **bold**
    '__([^\\n]+?)__', // 3  __bold__
    '~~([^\\n]+?)~~', // 4  ~~strike~~
    '\\*([^*\\n]+?)\\*', // 5  *italic*
    '_([^_\\n]+?)_', // 6  _italic_
    '\\[\\[([^\\]\\n]+)\\]\\]', // 7  [[wikilink]]
    '\\[([^\\]\\n]*)\\]\\(([^)\\s]+)\\)', // 8,9  [text](url)
    '((?:https?://|www\\.)[^\\s<>]+)', // 10  bare URL
  ].join('|'),
  'g',
);

/**
 * Split a line into styled spans. Marks nest (a link inside bold, code inside a
 * list item), so each match re-parses its own contents with the outer mark
 * carried down; `depth` stops a pathological string from recursing forever.
 */
function inlineSpans(src: string, mark: Mark = {}, depth = 0): Span[] {
  const out: Span[] = [];
  const push = (text: string, extra?: Mark) => {
    if (text) out.push({ ...mark, ...extra, text });
  };
  if (depth > 3) {
    push(src);
    return out;
  }

  const re = new RegExp(INLINE.source, 'g');
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const [whole, code, bold1, bold2, strike, it1, it2, wiki, linkText, linkUrl, bare] = m;

    // `_` only opens emphasis at a word boundary, so snake_case identifiers in
    // Claude's prose stay literal instead of italicising their middle.
    if (it2 !== undefined && m.index > 0 && !/[\s([{]/.test(src[m.index - 1])) continue;

    push(src.slice(last, m.index));
    last = m.index + whole.length;

    if (code !== undefined) push(code, { code: true });
    else if (bold1 !== undefined || bold2 !== undefined)
      out.push(...inlineSpans((bold1 ?? bold2)!, { ...mark, bold: true }, depth + 1));
    else if (strike !== undefined)
      out.push(...inlineSpans(strike, { ...mark, strike: true }, depth + 1));
    else if (it1 !== undefined || it2 !== undefined)
      out.push(...inlineSpans((it1 ?? it2)!, { ...mark, italic: true }, depth + 1));
    else if (wiki !== undefined) push(wiki, { wiki: true });
    else if (linkUrl !== undefined)
      out.push(...inlineSpans(linkText || linkUrl, { ...mark, url: linkUrl }, depth + 1));
    else if (bare !== undefined) {
      // A URL at the end of a sentence shouldn't swallow the period.
      const url = bare.replace(/[.,;:!?)\]]+$/, '');
      last = m.index + url.length;
      push(url, { url: url.startsWith('www.') ? `https://${url}` : url });
    }
  }
  push(src.slice(last));
  return out;
}

const openUrl = (url: string) => {
  Linking.openURL(url).catch(() => {
    /* no browser for it, or the URL is junk — nothing useful to say */
  });
};

function renderSpan(s: Span, i: number) {
  const style: TextStyle = {};
  if (s.bold) style.fontWeight = 'bold';
  if (s.italic) style.fontStyle = 'italic';
  // A struck-through link wants both decorations; RN takes them as one value.
  const deco = `${s.url ? 'underline ' : ''}${s.strike ? 'line-through' : ''}`.trim();
  if (deco) style.textDecorationLine = deco as TextStyle['textDecorationLine'];
  if (s.code) {
    style.fontFamily = MONO;
    style.fontSize = FONT * 0.9; // `.cm-inline-code`
  }

  return (
    <Text
      key={i}
      // Widget colors: code green, links blue, wikilinks mauve.
      className={s.code ? 'text-green' : s.url ? 'text-blue' : s.wiki ? 'text-mauve' : undefined}
      style={style}
      onPress={s.url ? () => openUrl(s.url!) : undefined}>
      {s.text}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

/** A line of prose (or a list item's text) at the answer view's base type. */
function Line({ text, className }: { text: string; className?: string }) {
  return (
    <Text
      className={className ?? 'text-text'}
      style={{ fontSize: FONT, lineHeight: LEADING }}>
      {inlineSpans(text).map(renderSpan)}
    </Text>
  );
}

function renderBlock(b: Block, key: number) {
  switch (b.kind) {
    case 'blank':
      return <View key={key} style={{ height: LEADING / 2 }} />;

    case 'heading': {
      const size = FONT * HEADING[b.level - 1];
      return (
        <Text
          key={key}
          className="font-bold text-text"
          // A heading gets a little air above it — unless it opens the reply.
          style={[{ fontSize: size, lineHeight: size * 1.35 }, key > 0 && styles.headingGap]}>
          {inlineSpans(b.text).map(renderSpan)}
        </Text>
      );
    }

    // `.cm-code-line` in the answer view: crust, 16px inset, rounded ends.
    case 'code':
      return (
        <View key={key} className="my-1.5 rounded-[10px] bg-crust px-4 py-2">
          {b.lines.map((l, i) => (
            <Text
              key={i}
              className="text-text"
              style={{ fontFamily: MONO, fontSize: FONT, lineHeight: LEADING }}>
              {l || ' '}
            </Text>
          ))}
        </View>
      );

    // `.cm-blockquote`: mantle, a 3px mauve bar, dimmed text.
    case 'quote':
      return (
        <View key={key} className="my-1 flex-row">
          <View className="w-[3px] bg-mauve" />
          <View className="flex-1 rounded-r-[8px] bg-mantle px-4 py-[3px]">
            {b.lines.map((l, i) => (
              <Line key={i} text={l} className="text-muted" />
            ))}
          </View>
        </View>
      );

    // `CheckboxWidget`: a 1.05em box, green and ticked when done, its line struck.
    case 'task':
      return (
        <View key={key} className="flex-row" style={{ paddingLeft: b.indent * INDENT }}>
          <View
            accessibilityRole="checkbox"
            accessibilityState={{ checked: b.done }}
            className={
              'mr-1.5 h-[15px] w-[15px] items-center justify-center rounded-[5px] border-2 ' +
              (b.done ? 'border-green bg-green' : 'border-overlay1')
            }
            style={{ marginTop: (LEADING - 15) / 2 }}>
            {b.done && <Check size={10} color={mocha.crust} strokeWidth={4} />}
          </View>
          <View className="flex-1">
            <Line text={b.text} className={b.done ? 'text-subtext0 line-through' : 'text-text'} />
          </View>
        </View>
      );

    // `BulletWidget`: the marker drawn as a real dot, a shade larger than the "-".
    case 'bullet':
      return (
        <View key={key} className="flex-row" style={{ paddingLeft: b.indent * INDENT }}>
          <Text
            className="text-text"
            style={{ width: INDENT, fontSize: FONT * 1.1, lineHeight: LEADING }}>
            •
          </Text>
          <View className="flex-1">
            <Line text={b.text} />
          </View>
        </View>
      );

    case 'ordered':
      return (
        <View key={key} className="flex-row" style={{ paddingLeft: b.indent * INDENT }}>
          <Text
            className="mr-1 text-text"
            style={{ fontSize: FONT, lineHeight: LEADING }}>
            {b.marker}
          </Text>
          <View className="flex-1">
            <Line text={b.text} />
          </View>
        </View>
      );

    case 'text':
      return <Line key={key} text={b.text} />;
  }
}

const styles = StyleSheet.create({
  headingGap: { marginTop: 4 },
});
